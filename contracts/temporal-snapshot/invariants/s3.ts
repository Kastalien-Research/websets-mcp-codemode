// S3 (Recorded snapshots): every snapshot request is recorded; identical
// requests replay from the record; a record never answers another instant;
// spend is counted and budgeted; status shows it.
//
// Interface these checks fix:
//   src/store/db.ts           getDb(':memory:'), closeDb(); tables
//                             snapshot_requests(request_key, endpoint, snapshot_as_of, request, response, response_hash, fetched_at)
//                             snapshot_spend(id, at, endpoint, snapshot_as_of, request_key)
//   src/temporal/records.ts   storeSnapshotRecords(budget?) -> SnapshotRecords (spent(), budget)
//   src/tools/operations.ts   dispatchOperation(op, args, exa, compat, { asOf?, snapshotRecords? })
//   src/tools/statusTool.ts   getAccountStatus(exa, compat, opts) -> { snapshot: { used, budget, remaining, recorded, window } },
//                             _resetStatusCache()
//   temporal blocks gain source: 'upstream' | 'record', and fetchedAt on replays; budget refusals carry TEMPORAL_BUDGET.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordingClient, type Responder } from '../harness/recording-client.js';
import { fail, pass, type Check, type CheckEnv } from '../kernel.js';

const DAY = 86_400_000;
const load = (env: CheckEnv, file: string) => import(pathToFileURL(join(env.root, file)).href);
const iso = (ms: number) => new Date(ms).toISOString();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const textOf = (r: { content?: Array<{ text?: string }> }) => (r.content ?? []).map(c => c.text ?? '').join('\n');
const jsonOf = (r: { content?: Array<{ text?: string }> }) => {
  try {
    return JSON.parse(r.content?.[0]?.text ?? 'null');
  } catch {
    return null;
  }
};

/** Deterministic PRNG so the property check explores the same sequences every run. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Responder that numbers each upstream fetch, so replays are distinguishable from new fetches. */
function numberedResponder(): { responder: Responder; fetches: () => number } {
  let n = 0;
  const responder: Responder = (path, args) => {
    if (path !== 'search' && path !== 'getContents' && path !== 'rawRequest') return { results: [] };
    const target = path === 'search' ? String(args[0])
      : path === 'getContents' ? String((args[0] as string[])[0])
        : String((args[2] as any)?.ids?.[0]);
    if (target.includes('fail')) throw new Error('upstream failure (contract probe)');
    n++;
    const body = { requestId: `r${n}`, results: [{ id: target, url: target, title: `fetch-${n}` }] };
    return path === 'rawRequest'
      ? { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
      : body;
  };
  return { responder, fetches: () => n };
}

interface Harness {
  db: any;
  records: any;
  dispatch: (op: string, args: Record<string, unknown>, asOf: string | undefined, client: any) => Promise<any>;
}

async function harness(env: CheckEnv, budget = 1000): Promise<Harness> {
  const store = await load(env, 'src/store/db.ts');
  const { storeSnapshotRecords } = await load(env, 'src/temporal/records.ts');
  const { dispatchOperation } = await load(env, 'src/tools/operations.ts');
  store.closeDb();
  const db = store.getDb(':memory:');
  const records = storeSnapshotRecords(budget);
  return {
    db,
    records,
    dispatch: (op, args, asOf, client) =>
      dispatchOperation(op, args, client, 'strict', { ...(asOf ? { asOf } : {}), snapshotRecords: records }),
  };
}

type Op = 'search' | 'contents-url' | 'contents-id';
function request(op: Op, target: string, perCall: string | undefined): [string, Record<string, unknown>] {
  if (op === 'search') return ['exa.search', { query: target, ...(perCall ? { contents: { snapshotAsOf: perCall } } : {}) }];
  const key = op === 'contents-url' ? 'urls' : 'ids';
  return ['exa.getContents', { [key]: [target], ...(perCall ? { snapshotAsOf: perCall } : {}) }];
}

interface SequenceResult {
  problems: string[];
  steps: number;
  upstream: number;
  replays: number;
}

/** Runs one seeded random sequence and checks S3.2 (replay iff recorded) and S3.4 (spend == upstream). */
async function runSequence(env: CheckEnv, seed: number, length: number): Promise<SequenceResult> {
  const h = await harness(env);
  const rng = mulberry32(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
  const now = env.now.getTime();
  const A = iso(now - 30 * DAY);
  const B = iso(now - 45 * DAY);
  const { responder } = numberedResponder();
  const rec = recordingClient(responder);
  const seen = new Map<string, string>();
  const out: SequenceResult = { problems: [], steps: length, upstream: 0, replays: 0 };

  for (let i = 0; i < length && out.problems.length < 5; i++) {
    const op = pick<Op>(['search', 'contents-url', 'contents-id']);
    const target = op === 'search' ? pick(['alpha', 'beta']) : pick(['https://example.com/1', 'https://example.com/2']);
    const instant = pick([A, B]);
    const pinned = rng() < 0.5;
    // Pinned runs use asOf A; an explicit per-call value is optional when it equals A.
    const perCall = pinned ? (instant === A && rng() < 0.5 ? undefined : instant) : instant;
    const [operation, args] = request(op, target, perCall);
    const key = `${op}|${target}|${Date.parse(instant)}`;

    const callsBefore = rec.calls.length;
    const spentBefore = h.records.spent();
    const r = await h.dispatch(operation, args, pinned ? A : undefined, rec.client);
    const upstream = rec.calls.length - callsBefore;
    const spent = h.records.spent() - spentBefore;
    const body = jsonOf(r);
    const title = body?.results?.[0]?.title;
    const where = `step ${i} ${operation} ${JSON.stringify(args)}${pinned ? ` pinned ${A}` : ''}`;

    if (r.isError) {
      out.problems.push(`${where}: failed: ${textOf(r).slice(0, 160)}`);
      continue;
    }
    if (spent !== upstream) out.problems.push(`${where}: spend +${spent} for ${upstream} upstream call(s)`);
    if (!seen.has(key)) {
      if (upstream !== 1) out.problems.push(`${where}: first request made ${upstream} upstream calls`);
      if (body?.temporal?.source !== 'upstream') out.problems.push(`${where}: fresh response not marked source upstream`);
      seen.set(key, title);
      out.upstream++;
    } else {
      if (upstream !== 0) out.problems.push(`${where}: identical request went upstream again`);
      if (body?.temporal?.source !== 'record') out.problems.push(`${where}: replay not marked source record`);
      if (Number.isNaN(Date.parse(body?.temporal?.fetchedAt))) out.problems.push(`${where}: replay without fetchedAt`);
      if (title !== seen.get(key)) out.problems.push(`${where}: replay returned ${title}, recorded ${seen.get(key)}`);
      out.replays++;
    }
  }
  return out;
}

async function sequences(env: CheckEnv): Promise<SequenceResult[]> {
  const cached = env.memo.get('s3Sequences') as SequenceResult[] | undefined;
  if (cached) return cached;
  const results: SequenceResult[] = [];
  for (const seed of [20261007, 7, 1337]) results.push(await runSequence(env, seed, 60));
  env.memo.set('s3Sequences', results);
  return results;
}

export const checks: Record<string, Check> = {
  async 'S3.1'(env) {
    const h = await harness(env);
    const A = iso(env.now.getTime() - 30 * DAY);
    const { responder } = numberedResponder();
    const rec = recordingClient(responder);
    const requests: Array<[string, Record<string, unknown>, string | undefined]> = [
      ['exa.search', { query: 'alpha' }, A],
      ['exa.getContents', { urls: ['https://example.com/1'] }, A],
      ['exa.getContents', { ids: ['https://example.com/2'] }, A],
      ['exa.search', { query: 'beta', contents: { snapshotAsOf: A } }, undefined],
      ['exa.search', { query: 'fail' }, A],
    ];
    for (const [op, args, asOf] of requests) await h.dispatch(op, args, asOf, rec.client);
    const rows = h.db.prepare('SELECT request_key, snapshot_as_of, request, response, response_hash FROM snapshot_requests').all();
    const problems: string[] = [];
    if (rows.length !== 4) problems.push(`${rows.length} records for 4 successful upstream requests (1 failed)`);
    for (const row of rows) {
      if (sha256(row.response) !== row.response_hash) problems.push(`${row.request_key}: sha256(response) != response_hash`);
      if (Date.parse(row.snapshot_as_of) !== Date.parse(A)) problems.push(`${row.request_key}: snapshot_as_of ${row.snapshot_as_of}`);
      try {
        JSON.parse(row.request);
        JSON.parse(row.response);
      } catch {
        problems.push(`${row.request_key}: request or response is not JSON`);
      }
    }
    return problems.length === 0 ? pass(`${rows.length} records, every sha256(response) matches its stored hash`, { records: rows.length }) : fail(problems.join('; '));
  },

  async 'S3.2'(env) {
    const runs = await sequences(env);
    const problems = runs.flatMap(r => r.problems);
    const upstream = runs.reduce((s, r) => s + r.upstream, 0);
    const replays = runs.reduce((s, r) => s + r.replays, 0);
    if (replays === 0 || upstream === 0) problems.push(`degenerate sequences: ${upstream} upstream, ${replays} replays`);
    return problems.length === 0
      ? pass(`${runs.length} seeded sequences, ${upstream} first requests went upstream once, ${replays} identical requests replayed the recorded response`, { upstream, replays })
      : fail(problems.slice(0, 8).join('; '), { upstream, replays });
  },

  async 'S3.3'(env) {
    const h = await harness(env);
    const A = iso(env.now.getTime() - 30 * DAY);
    const { responder } = numberedResponder();
    const rec = recordingClient(responder);
    const problems: string[] = [];

    const fresh = jsonOf(await h.dispatch('exa.search', { query: 'gamma' }, A, rec.client));
    const replay = jsonOf(await h.dispatch('exa.search', { query: 'gamma' }, A, rec.client));
    for (const field of ['snapshotAsOf', 'verification', 'discovery', 'bound']) {
      if (JSON.stringify(fresh?.temporal?.[field]) !== JSON.stringify(replay?.temporal?.[field])) {
        problems.push(`replay temporal.${field} ${JSON.stringify(replay?.temporal?.[field])} differs from fresh ${JSON.stringify(fresh?.temporal?.[field])}`);
      }
    }

    for (const shift of [-1000, 1000]) {
      const before = rec.calls.length;
      const neighbor = iso(Date.parse(A) + shift);
      const r = await h.dispatch('exa.search', { query: 'gamma', contents: { snapshotAsOf: neighbor } }, undefined, rec.client);
      if (r.isError) problems.push(`neighbor ${neighbor}: failed: ${textOf(r).slice(0, 120)}`);
      else if (rec.calls.length - before !== 1) problems.push(`neighbor instant ${neighbor} was answered from the record of ${A}`);
    }

    const row = h.db.prepare("SELECT request_key, snapshot_as_of, response FROM snapshot_requests WHERE request LIKE '%gamma%'").all()
      .find((r: any) => Date.parse(r.snapshot_as_of) === Date.parse(A));
    if (!row) {
      problems.push('no record for the gamma request');
    } else {
      const tampered = JSON.parse(row.response);
      tampered.results[0].snapshotAt = iso(Date.parse(A) + DAY);
      tampered.results[0].title = 'CONTRACT-TAMPERED-CONTENT';
      const text = JSON.stringify(tampered);
      h.db.prepare('UPDATE snapshot_requests SET response = ?, response_hash = ? WHERE request_key = ?').run(text, sha256(text), row.request_key);
      const before = rec.calls.length;
      const r = await h.dispatch('exa.search', { query: 'gamma' }, A, rec.client);
      if (!r.isError || !textOf(r).includes('TEMPORAL_LEAK')) problems.push('tampered record replayed without TEMPORAL_LEAK');
      else if (textOf(r).includes('CONTRACT-TAMPERED-CONTENT')) problems.push('leak error echoed the tampered content');
      if (rec.calls.length !== before) problems.push('tampered replay went upstream');
    }
    return problems.length === 0 ? pass('replays match fresh temporal blocks; neighboring instants go upstream; a late record replays as TEMPORAL_LEAK') : fail(problems.join('; '));
  },

  async 'S3.4'(env) {
    const runs = await sequences(env);
    const spendProblems = runs.flatMap(r => r.problems.filter(p => p.includes('spend')));
    const h = await harness(env);
    const { responder } = numberedResponder();
    const rec = recordingClient(responder);
    const A = iso(env.now.getTime() - 30 * DAY);
    const before = h.records.spent();
    const r = await h.dispatch('exa.getContents', { urls: ['https://example.com/fail'] }, A, rec.client);
    const recordedFailures = h.db.prepare("SELECT COUNT(*) AS n FROM snapshot_requests WHERE request LIKE '%fail%'").get().n;
    if (!r.isError) spendProblems.push('failing upstream request did not fail');
    if (h.records.spent() - before !== 1) spendProblems.push(`failing upstream request added ${h.records.spent() - before} spend entries`);
    if (recordedFailures !== 0) spendProblems.push('failing upstream request was recorded as a snapshot');
    return spendProblems.length === 0
      ? pass('spend delta equals upstream calls on every sequence step; a failed request costs 1 and is not recorded')
      : fail(spendProblems.slice(0, 8).join('; '));
  },

  async 'S3.5'(env) {
    const h = await harness(env, 3);
    const { responder } = numberedResponder();
    const rec = recordingClient(responder);
    const A = iso(env.now.getTime() - 30 * DAY);
    const problems: string[] = [];
    for (const q of ['one', 'two', 'three']) {
      const r = await h.dispatch('exa.search', { query: q }, A, rec.client);
      if (r.isError) problems.push(`within budget, ${q} failed: ${textOf(r).slice(0, 120)}`);
    }
    const before = rec.calls.length;
    const over = await h.dispatch('exa.search', { query: 'four' }, A, rec.client);
    if (!over.isError || !textOf(over).includes('TEMPORAL_BUDGET')) problems.push('request over budget not refused with TEMPORAL_BUDGET');
    if (rec.calls.length !== before) problems.push('request over budget reached upstream');
    const replay = await h.dispatch('exa.search', { query: 'one' }, A, rec.client);
    if (replay.isError) problems.push(`replay over budget failed: ${textOf(replay).slice(0, 120)}`);
    if (rec.calls.length !== before) problems.push('replay over budget reached upstream');
    return problems.length === 0 ? pass('at budget, new requests are refused with TEMPORAL_BUDGET and zero calls; replays still succeed') : fail(problems.join('; '));
  },

  async 'S3.6'(env) {
    const h = await harness(env);
    const { getAccountStatus, _resetStatusCache } = await load(env, 'src/tools/statusTool.ts');
    const { snapshotWindowStart } = await load(env, 'src/temporal/instant.ts');
    const { responder } = numberedResponder();
    const rec = recordingClient(responder);
    const A = iso(env.now.getTime() - 30 * DAY);
    for (const q of ['one', 'two']) await h.dispatch('exa.search', { query: q }, A, rec.client);
    for (const q of ['fail-1', 'fail-2', 'fail-3']) await h.dispatch('exa.search', { query: q }, A, rec.client);

    _resetStatusCache();
    const status = await getAccountStatus(recordingClient().client, 'strict', { timeoutMs: 2000 });
    const s = status?.snapshot;
    const problems: string[] = [];
    const near = (a: unknown, b: number) => typeof a === 'string' && Math.abs(Date.parse(a) - b) < 120_000;
    if (!s) return fail('status has no snapshot section');
    const budget = Number(process.env.SNAPSHOT_BUDGET ?? 100);
    if (s.used !== 5 || s.used !== h.records.spent()) problems.push(`used ${s.used}, ledger ${h.records.spent()}, expected 5`);
    if (s.budget !== budget) problems.push(`budget ${s.budget}, expected ${budget}`);
    if (s.remaining !== budget - 5) problems.push(`remaining ${s.remaining}`);
    if (s.recorded !== 2) problems.push(`recorded ${s.recorded}, expected 2`);
    if (!near(s.window?.from, snapshotWindowStart(env.now).getTime())) problems.push(`window.from ${s.window?.from}`);
    if (!near(s.window?.to, env.now.getTime())) problems.push(`window.to ${s.window?.to}`);
    return problems.length === 0 ? pass('status reports used = ledger count, budget, remaining, recorded and the current window') : fail(problems.join('; '));
  },
};
