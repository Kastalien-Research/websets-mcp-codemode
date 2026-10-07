// S2 (Temporal cursor): a run can be pinned to an instant, enforced at the
// client boundary.
//
// Interface these checks fix:
//   src/temporal/instant.ts    parseAsOf(value, now?) -> {ok, asOf} | {ok: false, reason}
//   src/temporal/boundary.ts   PINNABLE_OPERATIONS, guardSnapshots(exa, asOf?)
//   src/tools/executeTool.ts   executeInputSchema, runExecute(input, exa, options)
//   src/tools/operations.ts    dispatchOperation(op, args, exa, compat, { asOf })
//   responses under a snapshot carry `temporal: { snapshotAsOf, verification, discovery? }`
//   with verification 'verified' | 'provider-guaranteed' and discovery 'current-ranking'.
//
// Probe instants are derived from env.now so the checks never age out of the
// rolling Snapshot window.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLIENT_BOOTSTRAP_FILES } from '../contract.js';
import { recordingClient, type Responder } from '../harness/recording-client.js';
import { fail, pass, type Check, type CheckEnv } from '../kernel.js';

const DAY = 86_400_000;
const LEAK_MARKER = 'CONTRACT-LEAK-MARKER-7f3a';

const load = (env: CheckEnv, file: string) => import(pathToFileURL(join(env.root, file)).href);
const operations = (env: CheckEnv) => load(env, 'src/tools/operations.ts');
const boundary = (env: CheckEnv) => load(env, 'src/temporal/boundary.ts');

const iso = (ms: number) => new Date(ms).toISOString();
const sameInstant = (a: unknown, b: string) => typeof a === 'string' && Date.parse(a) === Date.parse(b);
const textOf = (r: { content?: Array<{ text?: string }> }) => (r.content ?? []).map(c => c.text ?? '').join('\n');
const jsonOf = (r: { content?: Array<{ text?: string }> }) => {
  try {
    return JSON.parse(r.content?.[0]?.text ?? 'null');
  } catch {
    return null;
  }
};

/** Instants relative to the verifier clock: A is the pin, B earlier, C later (all inside the window). */
const instants = (env: CheckEnv) => {
  const now = env.now.getTime();
  return { A: iso(now - 30 * DAY), B: iso(now - 60 * DAY), C: iso(now - 10 * DAY) };
};

function containsSnapshotAsOf(value: unknown, depth = 0): boolean {
  if (depth > 5 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(v => containsSnapshotAsOf(v, depth + 1));
  return 'snapshotAsOf' in value || Object.values(value).some(v => containsSnapshotAsOf(v, depth + 1));
}

/** The snapshotAsOf a recorded request carried, wherever the endpoint puts it. */
function sentSnapshot(call: { path: string; args: unknown[] }): unknown {
  if (call.path === 'search') return (call.args[1] as any)?.contents?.snapshotAsOf;
  if (call.path === 'getContents') return (call.args[1] as any)?.snapshotAsOf;
  if (call.path === 'rawRequest') return (call.args[2] as any)?.snapshotAsOf;
  return undefined;
}

async function rejectsWithBoundary(invoke: () => unknown): Promise<string | null> {
  try {
    await invoke();
    return 'did not throw';
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    return message.includes('TEMPORAL_BOUNDARY') ? null : `threw without TEMPORAL_BOUNDARY: ${message.slice(0, 120)}`;
  }
}

function sourceFiles(dir: string, root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== '__tests__') out.push(...sourceFiles(path, root));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(relative(root, path));
    }
  }
  return out;
}

export const checks: Record<string, Check> = {
  async 'S2.1'(env) {
    const { parseAsOf } = await load(env, 'src/temporal/instant.ts');
    const { executeInputSchema } = await load(env, 'src/tools/executeTool.ts');
    const problems: string[] = [];

    // Parser, with an injected clock: window start is 2026-05-07T12:00Z.
    const clock = new Date('2026-10-07T12:00:00Z');
    const accepts = (value: string, instant: string) => {
      const r = parseAsOf(value, clock);
      if (!r.ok || !sameInstant(r.asOf, instant)) problems.push(`parser should accept ${value} as ${instant}: ${JSON.stringify(r)}`);
    };
    const rejects = (value: string, why: string) => {
      if (parseAsOf(value, clock).ok) problems.push(`parser accepted ${why}: ${value}`);
    };
    accepts('2026-08-01', '2026-08-01T00:00:00Z');
    accepts('2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    accepts('2026-08-01T02:00:00+02:00', '2026-08-01T00:00:00Z');
    accepts('2026-05-08', '2026-05-08T00:00:00Z');
    for (const bad of ['yesterday', '', '2026-13-01', '2026-02-31', '2026-08-01T00:00:00', '08/01/2026']) rejects(bad, 'a malformed value');
    rejects('2026-10-08', 'a future date');
    rejects('2026-10-07T12:00:01Z', 'a future instant');
    rejects('2026-05-07', 'a date before the 5-month window');

    // Registered input schema, on the real clock.
    const now = env.now.getTime();
    const dateOnly = (ms: number) => iso(ms).slice(0, 10);
    const schemaAccepts = (input: Record<string, unknown>) => executeInputSchema.safeParse({ code: 'return 1', ...input }).success;
    if (!schemaAccepts({})) problems.push('schema rejects a call without asOf');
    if (!schemaAccepts({ asOf: dateOnly(now - 7 * DAY) })) problems.push('schema rejects a valid recent asOf');
    if (schemaAccepts({ asOf: 'yesterday' })) problems.push('schema accepts a malformed asOf');
    if (schemaAccepts({ asOf: dateOnly(now + 2 * DAY) })) problems.push('schema accepts a future asOf');
    if (schemaAccepts({ asOf: dateOnly(now - 200 * DAY) })) problems.push('schema accepts an asOf outside the window');

    return problems.length === 0 ? pass('parser and execute schema accept valid instants and reject malformed, future and out-of-window ones') : fail(problems.join('; '));
  },

  async 'S2.2'(env) {
    const { OPERATIONS, dispatchOperation } = await operations(env);
    const { PINNABLE_OPERATIONS } = await boundary(env);
    const { A } = instants(env);
    const pinnable = [...PINNABLE_OPERATIONS] as string[];
    const problems: string[] = [];
    const unknown = pinnable.filter(op => !(op in OPERATIONS));
    if (pinnable.length === 0) problems.push('PINNABLE_OPERATIONS is empty');
    if (unknown.length > 0) problems.push(`PINNABLE_OPERATIONS names unregistered operations: ${unknown.join(', ')}`);

    let refused = 0;
    for (const op of Object.keys(OPERATIONS).filter(op => !PINNABLE_OPERATIONS.has(op))) {
      const rec = recordingClient();
      const result = await dispatchOperation(op, {}, rec.client, 'strict', { asOf: A });
      if (!result.isError || !textOf(result).includes('TEMPORAL_BOUNDARY')) problems.push(`${op}: not refused with TEMPORAL_BOUNDARY`);
      else if (rec.calls.length > 0) problems.push(`${op}: refused after ${rec.calls.length} client call(s)`);
      else refused++;
    }
    return problems.length === 0
      ? pass(`${refused} non-pinnable operations refused before validation with zero calls; pinnable: ${pinnable.join(', ')}`, { refused, pinnable: pinnable.length })
      : fail(problems.slice(0, 20).join('; '), { refused, pinnable: pinnable.length });
  },

  async 'S2.3'(env) {
    const { guardSnapshots } = await boundary(env);
    const { A } = instants(env);
    const rec = recordingClient();
    const pinned = guardSnapshots(rec.client, A);
    const problems: string[] = [];
    const methodPaths = [
      'answer', 'streamAnswer', 'findSimilar', 'findSimilarAndContents', 'searchAndContents', 'streamSearch',
      'websets.create', 'websets.list', 'websets.items.list', 'websets.searches.create', 'websets.monitors.create',
      'research.create', 'research.get', 'request',
    ];
    for (const path of methodPaths) {
      const problem = await rejectsWithBoundary(() => {
        const fn = path.split('.').reduce((o: any, k) => o[k], pinned);
        return fn('contract-probe', {});
      });
      if (problem) problems.push(`${path}: ${problem}`);
    }
    for (const [endpoint, method] of [['/answer', 'POST'], ['/search', 'POST'], ['/websets/v0/websets', 'GET']]) {
      const problem = await rejectsWithBoundary(() => pinned.rawRequest(endpoint, method, {}));
      if (problem) problems.push(`rawRequest ${method} ${endpoint}: ${problem}`);
    }
    if (rec.calls.length > 0) problems.push(`calls reached the client: ${rec.calls.map(c => c.path).join(', ')}`);

    const constructing = sourceFiles(join(env.root, 'src'), env.root)
      .filter(f => /new\s+Exa\s*\(/.test(readFileSync(join(env.root, f), 'utf8')));
    const stray = constructing.filter(f => !CLIENT_BOOTSTRAP_FILES.includes(f));
    if (stray.length > 0) problems.push(`new Exa( outside bootstrap files: ${stray.join(', ')}`);

    return problems.length === 0
      ? pass(`${methodPaths.length + 3} non-pinnable client paths throw TEMPORAL_BOUNDARY with zero calls; clients constructed only in ${constructing.join(', ')}`)
      : fail(problems.join('; '));
  },

  async 'S2.4'(env) {
    const { dispatchOperation } = await operations(env);
    const { A, B, C } = instants(env);
    const problems: string[] = [];
    const cases: Array<{ name: string; op: string; args: Record<string, unknown>; expect: string | 'rejected' }> = [
      { name: 'search, no per-call value', op: 'exa.search', args: { query: 'q', contents: { highlights: true } }, expect: A },
      { name: 'search, no contents', op: 'exa.search', args: { query: 'q' }, expect: A },
      { name: 'contents by url', op: 'exa.getContents', args: { urls: ['https://example.com/'], text: true }, expect: A },
      { name: 'contents by id', op: 'exa.getContents', args: { ids: ['https://example.com/'], text: true }, expect: A },
      { name: 'search, earlier per-call', op: 'exa.search', args: { query: 'q', contents: { snapshotAsOf: B } }, expect: B },
      { name: 'contents, earlier per-call', op: 'exa.getContents', args: { urls: ['https://example.com/'], snapshotAsOf: B }, expect: B },
      { name: 'search, later per-call', op: 'exa.search', args: { query: 'q', contents: { snapshotAsOf: C } }, expect: 'rejected' },
      { name: 'contents, later per-call', op: 'exa.getContents', args: { ids: ['https://example.com/'], snapshotAsOf: C }, expect: 'rejected' },
    ];
    for (const k of cases) {
      const rec = recordingClient();
      const result = await dispatchOperation(k.op, k.args, rec.client, 'strict', { asOf: A });
      if (k.expect === 'rejected') {
        if (!result.isError || rec.calls.length > 0) problems.push(`${k.name}: expected rejection with zero calls (isError ${result.isError}, calls ${rec.calls.length})`);
        continue;
      }
      const sent = rec.calls.map(sentSnapshot);
      if (result.isError) problems.push(`${k.name}: failed: ${textOf(result).slice(0, 160)}`);
      else if (rec.calls.length !== 1 || !sameInstant(sent[0], k.expect)) problems.push(`${k.name}: sent ${JSON.stringify(sent)}, expected ${k.expect}`);
    }
    return problems.length === 0 ? pass(`${cases.length} pinned cases: injected, kept earlier per-call values, rejected later ones`) : fail(problems.join('; '));
  },

  async 'S2.5'(env) {
    const { dispatchOperation } = await operations(env);
    const { guardSnapshots } = await boundary(env);
    const { A } = instants(env);
    const problems: string[] = [];
    const contentsConflicts = { livecrawl: 'always', livecrawlTimeout: 1000, maxAgeHours: 24, subpages: 1 };
    const searchConflicts: Array<[string, Record<string, unknown>]> = [
      ['type deep', { type: 'deep' }], ['type deep-lite', { type: 'deep-lite' }], ['type deep-reasoning', { type: 'deep-reasoning' }],
      ['category', { category: 'news' }], ['stream', { stream: true }],
    ];
    const probe = async (name: string, op: string, args: Record<string, unknown>, asOf?: string) => {
      const rec = recordingClient();
      const result = await dispatchOperation(op, args, rec.client, 'strict', asOf ? { asOf } : undefined);
      if (!result.isError || rec.calls.length > 0) problems.push(`${name}: not rejected with zero calls`);
    };
    for (const [field, value] of Object.entries(contentsConflicts)) {
      await probe(`pinned contents + ${field}`, 'exa.getContents', { urls: ['https://example.com/'], [field]: value }, A);
      await probe(`per-call contents + ${field}`, 'exa.getContents', { urls: ['https://example.com/'], snapshotAsOf: A, [field]: value });
      const rec = recordingClient();
      const problem = await rejectsWithBoundary(() =>
        guardSnapshots(rec.client).getContents(['https://example.com/'], { snapshotAsOf: A, [field]: value }));
      if (problem || rec.calls.length > 0) problems.push(`client-level contents + ${field}: ${problem ?? 'reached the client'}`);
    }
    for (const [name, extra] of searchConflicts) {
      await probe(`pinned search + ${name}`, 'exa.search', { query: 'q', ...extra }, A);
      await probe(`per-call search + ${name}`, 'exa.search', { query: 'q', contents: { snapshotAsOf: A }, ...extra });
    }
    for (const [field, value] of Object.entries(contentsConflicts)) {
      const rec = recordingClient();
      const problem = await rejectsWithBoundary(() => guardSnapshots(rec.client, A).search('q', { contents: { [field]: value } }));
      if (problem || rec.calls.length > 0) problems.push(`client-level pinned search + contents.${field}: ${problem ?? 'reached the client'}`);
    }
    for (const [name, extra] of searchConflicts.filter(([n]) => n !== 'stream')) {
      const rec = recordingClient();
      const problem = await rejectsWithBoundary(() => guardSnapshots(rec.client, A).search('q', { ...extra }));
      if (problem || rec.calls.length > 0) problems.push(`client-level pinned search + ${name}: ${problem ?? 'reached the client'}`);
    }
    {
      const rec = recordingClient();
      const problem = await rejectsWithBoundary(() =>
        guardSnapshots(rec.client).streamSearch('q', { contents: { snapshotAsOf: A } }));
      if (problem || rec.calls.length > 0) problems.push(`client-level streamSearch with snapshot: ${problem ?? 'reached the client'}`);
    }
    return problems.length === 0 ? pass('every conflicting parameter rejected with zero calls, pinned and per-call, at dispatch and at the client') : fail(problems.join('; '));
  },

  async 'S2.6'(env) {
    const { dispatchOperation } = await operations(env);
    const { A } = instants(env);
    const late = iso(Date.parse(A) + DAY);
    const early = iso(Date.parse(A) - DAY);
    const result = (extra: Record<string, unknown>) => ({ id: 'https://example.com/a', url: 'https://example.com/a', title: LEAK_MARKER, text: LEAK_MARKER, ...extra });
    const responder = (body: unknown): Responder => path => path === 'rawRequest'
      ? { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
      : body;
    const problems: string[] = [];

    const leaks: Array<[string, string, Record<string, unknown>, unknown, string | undefined]> = [
      ['late snapshotAt on search', 'exa.search', { query: 'q' }, { results: [result({ snapshotAt: late })] }, A],
      ['unparseable snapshotAt on search', 'exa.search', { query: 'q' }, { results: [result({ snapshotAt: 'not-a-date' })] }, A],
      ['late snapshotAt on contents by id', 'exa.getContents', { ids: ['https://example.com/a'] }, { results: [result({ snapshotAt: late })] }, A],
      ['live-sourced contents', 'exa.getContents', { urls: ['https://example.com/a'] },
        { results: [result({})], statuses: [{ id: 'https://example.com/a', status: 'success', source: 'live' }] }, A],
      ['late snapshotAt on per-call search', 'exa.search', { query: 'q', contents: { snapshotAsOf: A } }, { results: [result({ snapshotAt: late })] }, undefined],
      // Earlier per-call snapshot inside a pinned run: the cutoff is the per-call value, not asOf.
      ['snapshotAt between an earlier per-call snapshot and asOf', 'exa.search',
        { query: 'q', contents: { snapshotAsOf: iso(Date.parse(A) - 10 * DAY) } }, { results: [result({ snapshotAt: early })] }, A],
      ['contents sourced from neither store nor live', 'exa.getContents', { urls: ['https://example.com/a'] },
        { results: [result({})], statuses: [{ id: 'https://example.com/a', status: 'success', source: 'crawl' }] }, A],
    ];
    for (const [name, op, args, body, asOf] of leaks) {
      const rec = recordingClient(responder(body));
      const r = await dispatchOperation(op, args, rec.client, 'strict', asOf ? { asOf } : undefined);
      const text = textOf(r);
      if (!r.isError || !text.includes('TEMPORAL_LEAK')) problems.push(`${name}: not a TEMPORAL_LEAK error`);
      else if (text.includes(LEAK_MARKER)) problems.push(`${name}: error text contains the offending content`);
    }

    const labels: Array<[string, string, Record<string, unknown>, unknown, string]> = [
      ['search without snapshotAt', 'exa.search', { query: 'q' }, { results: [result({ title: 't', text: 't' })] }, 'provider-guaranteed'],
      ['contents without snapshotAt', 'exa.getContents', { urls: ['https://example.com/a'] },
        { results: [result({ title: 't', text: 't' })], statuses: [{ id: 'https://example.com/a', status: 'success', source: 'cached' }] }, 'provider-guaranteed'],
      ['search with earlier snapshotAt', 'exa.search', { query: 'q' }, { results: [result({ title: 't', text: 't', snapshotAt: early })] }, 'verified'],
      ['mixed search', 'exa.search', { query: 'q' }, { results: [result({ title: 't', text: 't', snapshotAt: early }), result({ id: 'b', url: 'https://example.com/b', title: 't', text: 't' })] }, 'provider-guaranteed'],
    ];
    for (const [name, op, args, body, expected] of labels) {
      const rec = recordingClient(responder(body));
      const r = await dispatchOperation(op, args, rec.client, 'strict', { asOf: A });
      const label = jsonOf(r)?.temporal?.verification;
      if (r.isError) problems.push(`${name}: failed: ${textOf(r).slice(0, 160)}`);
      else if (label !== expected) problems.push(`${name}: verification ${JSON.stringify(label)}, expected ${expected}`);
    }
    return problems.length === 0 ? pass(`${leaks.length} leak shapes rejected without content; ${labels.length} label cases correct`) : fail(problems.join('; '));
  },

  async 'S2.7'(env) {
    const { runExecute } = await load(env, 'src/tools/executeTool.ts');
    const { A } = instants(env);
    const body = { requestId: 'r', results: [{ id: 'https://example.com/a', url: 'https://example.com/a', title: 't', text: 't' }] };
    const rec = recordingClient(path => path === 'rawRequest'
      ? { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
      : body);
    const code = `
      const search = await callOperation('exa.search', { query: 'q', contents: { highlights: true } });
      const contents = await callOperation('exa.getContents', { urls: ['https://example.com/a'], text: true });
      return { search, contents };`;
    const r = await runExecute({ code, asOf: A, timeout: 20_000 }, rec.client, { compatMode: 'strict' });
    const envelope = jsonOf(r);
    const problems: string[] = [];
    if (r.isError || !envelope) return fail(`pinned execute failed: ${textOf(r).slice(0, 300)}`);
    if (!sameInstant(envelope.asOf, A)) problems.push(`envelope asOf ${JSON.stringify(envelope.asOf)}, expected ${A}`);
    for (const key of ['search', 'contents'] as const) {
      const t = envelope.result?.[key]?.temporal;
      if (!t) {
        problems.push(`${key}: no temporal block`);
        continue;
      }
      if (!sameInstant(t.snapshotAsOf, A)) problems.push(`${key}: temporal.snapshotAsOf ${JSON.stringify(t.snapshotAsOf)}`);
      if (!['verified', 'provider-guaranteed'].includes(t.verification)) problems.push(`${key}: temporal.verification ${JSON.stringify(t.verification)}`);
    }
    if (envelope.result?.search?.temporal?.discovery !== 'current-ranking') problems.push('search: temporal.discovery is not current-ranking');

    // A per-call snapshot outside a pinned run is still a response under a snapshot.
    const { dispatchOperation } = await operations(env);
    const B = iso(Date.parse(A) - 10 * DAY);
    for (const [op, args] of [
      ['exa.search', { query: 'q', contents: { snapshotAsOf: B } }],
      ['exa.getContents', { urls: ['https://example.com/a'], snapshotAsOf: B }],
      ['exa.getContents', { ids: ['https://example.com/a'], snapshotAsOf: B }],
    ] as const) {
      const live = recordingClient(path => path === 'rawRequest'
        ? { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
        : body);
      const t = jsonOf(await dispatchOperation(op, args, live.client, 'strict'))?.temporal;
      if (!t || !sameInstant(t.snapshotAsOf, B)) problems.push(`per-call ${op} ${Object.keys(args)[0]}: missing or wrong temporal block`);
    }
    return problems.length === 0 ? pass('pinned envelope carries asOf; search and contents carry temporal blocks; search discovery marked current-ranking') : fail(problems.join('; '));
  },

  async 'S2.8'(env) {
    const { dispatchOperation } = await operations(env);
    const problems: string[] = [];
    for (const [op, args] of [
      ['exa.search', { query: 'q', contents: { highlights: true } }],
      ['exa.search', { query: 'q' }],
      ['exa.getContents', { urls: ['https://example.com/'], text: true }],
      ['exa.getContents', { ids: ['https://example.com/'], text: true }],
    ] as const) {
      const rec = recordingClient();
      const r = await dispatchOperation(op, args, rec.client, 'strict');
      if (r.isError) problems.push(`${op}: failed in live mode: ${textOf(r).slice(0, 120)}`);
      if (rec.calls.length === 0) problems.push(`${op}: made no call`);
      if (rec.calls.some(c => containsSnapshotAsOf(c.args))) problems.push(`${op}: live request carried snapshotAsOf`);
    }
    return problems.length === 0 ? pass('live-mode search and contents requests carry no snapshotAsOf') : fail(problems.join('; '));
  },

  async 'S2.9'(env) {
    const { dispatchOperation } = await operations(env);
    const ledgerPath = join(env.root, 'contracts/temporal-snapshot/ledger.jsonl');
    const ledger = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
    const spends = ledger.filter((e: any) => e.type === 'spend' && String(e.purpose).startsWith('S2.9'));
    const problems: string[] = [];
    if (spends.length > 2) problems.push(`${spends.length} sanctioned S2.9 requests (at most 2)`);

    const probes: Array<[string, string, string, Record<string, unknown>]> = [
      ['search', 'fixtures/t2-live-probe-search.json', 'exa.search', { query: 'latest stable Python release notes', numResults: 2, contents: { highlights: true } }],
      ['contents', 'fixtures/t2-live-probe-contents.json', 'exa.getContents', { urls: ['https://docs.python.org/3/whatsnew/changelog.html'], text: true }],
    ];
    for (const [endpoint, file, op, args] of probes) {
      const path = join(env.root, 'contracts/temporal-snapshot', file);
      if (!existsSync(path)) {
        problems.push(`${file} is missing`);
        continue;
      }
      const recorded = JSON.parse(readFileSync(path, 'utf8'));
      const spend = spends.find((e: any) => e.endpoint === endpoint && e.requestId === recorded.requestId);
      if (!spend) {
        problems.push(`${file}: requestId ${recorded.requestId} has no matching S2.9 spend entry`);
        continue;
      }
      const rec = recordingClient(() => recorded);
      const r = await dispatchOperation(op, args, rec.client, 'strict', { asOf: spend.snapshotAsOf });
      const results: any[] = recorded.results ?? [];
      const expected = results.length > 0 && results.every(x => typeof x.snapshotAt === 'string') ? 'verified' : 'provider-guaranteed';
      const label = jsonOf(r)?.temporal?.verification;
      if (r.isError) problems.push(`${file}: replay failed: ${textOf(r).slice(0, 200)}`);
      else if (label !== expected) problems.push(`${file}: replay labeled ${JSON.stringify(label)}, fields justify ${expected}`);
    }
    return problems.length === 0
      ? pass(`${spends.length} sanctioned requests; both live responses replay through the pinned path with the label their fields justify`, { spend: spends.length })
      : fail(problems.join('; '), { spend: spends.length });
  },
};
