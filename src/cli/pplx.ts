#!/usr/bin/env node
// pplx — Effect-TS CLI over the Perplexity Sonar client (src/lib/perplexity.ts).
//
//   pplx ask "<question>" [--model sonar|sonar-pro|sonar-reasoning-pro|sonar-deep-research] [--json]
//   pplx verify-person --name "JANE DOE" [--city X] [--state TN] [--license 12345] [--claim "..." ...]
//   pplx batch <file.jsonl> [--concurrency 4] [--model sonar] [--out results.jsonl]
//       each line: {"name": "...", "city": "...", "state": "...", "lic": "...", "claims": ["..."]}
//
// Built on the `effect` core dependency: typed errors, exponential-backoff
// retry on transient failures, bounded-concurrency batch fan-out, and a
// mechanical dollar ledger from API usage (same discipline as the exa.*
// costDollars tracking). Argument parsing is hand-rolled to avoid adding
// @effect/cli + @effect/platform; migrate if the command surface grows.

import { Effect, Schedule, Duration } from 'effect';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  perplexityAsk,
  PerplexityError,
  type PerplexityAnswer,
  type PerplexityModel,
} from '../lib/perplexity.js';

// --- env: fall back to .env in cwd (the server loads env via docker; the CLI
// runs on the host where .env is a file) --------------------------------------
function loadDotEnvKey(): void {
  if (process.env.PERPLEXITY_API_KEY) return;
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^PERPLEXITY_API_KEY=(.*)$/.exec(line.trim());
    if (m) {
      process.env.PERPLEXITY_API_KEY = m[1];
      return;
    }
  }
}

// --- effect wrappers ---------------------------------------------------------
const transient = (e: unknown) =>
  e instanceof PerplexityError && (e.status === 429 || e.status >= 500);

const askEffect = (question: string, opts: Parameters<typeof perplexityAsk>[1]) =>
  Effect.tryPromise({
    try: () => perplexityAsk(question, opts),
    catch: (e) => e,
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential(Duration.seconds(2)).pipe(
        Schedule.intersect(Schedule.recurs(3)),
      ),
      while: transient,
    }),
  );

const verifyPersonQuestion = (p: {
  name: string;
  city?: string;
  state?: string;
  lic?: string;
  claims?: string[];
}): string => {
  const locality = [p.city, p.state].filter(Boolean).join(', ');
  return (
    `Who is ${p.name}${locality ? `, associated with ${locality}` : ''}` +
    `${p.lic ? ` (professional engineer license #${p.lic})` : ''}? ` +
    `Report their current employer, job title, engineering discipline, and any professional profile URLs. ` +
    `Cite sources for every fact.` +
    ((p.claims?.length ?? 0) > 0
      ? ` Additionally, for each of the following claims, state what your sources support or contradict — ` +
        `if you find no evidence either way, say so explicitly rather than guessing:\n` +
        p.claims!.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : '')
  );
};

const VERIFY_SYSTEM =
  'You are verifying facts about a specific real person. Precision matters more than coverage: ' +
  'never blend facts from different same-named people — if multiple candidates exist, say so and ' +
  'distinguish them. Absence of evidence must be reported as absence, not filled in.';

// --- arg parsing -------------------------------------------------------------
interface Flags {
  positional: string[];
  flags: Record<string, string | string[] | boolean>;
}
function parseArgs(argv: string[]): Flags {
  const positional: string[] = [];
  const flags: Record<string, string | string[] | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
      if (key === 'claim') {
        const prev = (flags[key] as string[] | undefined) ?? [];
        flags[key] = [...prev, String(value)];
      } else {
        flags[key] = value;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function printAnswer(a: PerplexityAnswer, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(a, null, 2));
    return;
  }
  console.log(a.content);
  if (a.citations.length) {
    console.log('\nCitations:');
    a.citations.forEach((c, i) => console.log(`  [${i + 1}] ${c}`));
  }
  console.log(
    `\n— ${a.model} | ${a.usage.promptTokens}+${a.usage.completionTokens} tokens | ` +
      `~$${a.usage.estCostDollars}${a.usage.estIsPartial ? ' (tokens only; search fees not included)' : ''}`,
  );
}

// --- commands ----------------------------------------------------------------
const cmdAsk = (args: Flags) =>
  Effect.gen(function* () {
    const question = args.positional[0];
    if (!question) return yield* Effect.fail(new Error('usage: pplx ask "<question>" [--model m] [--json]'));
    const answer = yield* askEffect(question, {
      model: args.flags.model as PerplexityModel | undefined,
    });
    printAnswer(answer, args.flags.json === true);
  });

const cmdVerifyPerson = (args: Flags) =>
  Effect.gen(function* () {
    const name = args.flags.name as string | undefined;
    if (!name) {
      return yield* Effect.fail(
        new Error('usage: pplx verify-person --name "X" [--city C] [--state S] [--license L] [--claim "..." ...]'),
      );
    }
    const answer = yield* askEffect(
      verifyPersonQuestion({
        name,
        city: args.flags.city as string | undefined,
        state: args.flags.state as string | undefined,
        lic: args.flags.license as string | undefined,
        claims: args.flags.claim as string[] | undefined,
      }),
      { model: (args.flags.model as PerplexityModel | undefined) ?? 'sonar', systemPrompt: VERIFY_SYSTEM, maxTokens: 1536 },
    );
    printAnswer(answer, args.flags.json === true);
  });

const cmdBatch = (args: Flags) =>
  Effect.gen(function* () {
    const file = args.positional[0];
    if (!file || !fs.existsSync(file)) {
      return yield* Effect.fail(new Error('usage: pplx batch <file.jsonl> [--concurrency 4] [--model m] [--out results.jsonl]'));
    }
    const concurrency = Number(args.flags.concurrency ?? 4) || 4;
    const model = ((args.flags.model as string | undefined) ?? 'sonar') as PerplexityModel;
    const outPath = (args.flags.out as string | undefined) ?? file.replace(/\.jsonl$/, '') + '-results.jsonl';

    const people = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { name: string; city?: string; state?: string; lic?: string; claims?: string[] });

    console.error(`batch: ${people.length} people, concurrency ${concurrency}, model ${model} → ${outPath}`);
    const out = fs.createWriteStream(outPath);
    let done = 0;
    let dollars = 0;

    const results = yield* Effect.forEach(
      people,
      (p) =>
        askEffect(verifyPersonQuestion(p), { model, systemPrompt: VERIFY_SYSTEM, maxTokens: 1536 }).pipe(
          Effect.map((answer) => ({ person: p, answer, error: null as string | null })),
          Effect.catchAll((e) =>
            Effect.succeed({ person: p, answer: null as PerplexityAnswer | null, error: String(e) }),
          ),
          Effect.tap((r) =>
            Effect.sync(() => {
              done++;
              if (r.answer) dollars += r.answer.usage.estCostDollars;
              out.write(JSON.stringify(r) + '\n');
              if (done % 10 === 0) console.error(`  ${done}/${people.length} | ~$${dollars.toFixed(3)}`);
            }),
          ),
        ),
      { concurrency },
    );

    out.end();
    const failed = results.filter((r) => r.error).length;
    console.error(`done: ${results.length - failed} ok, ${failed} failed | ledger ~$${dollars.toFixed(3)} | ${outPath}`);
  });

// --- main --------------------------------------------------------------------
loadDotEnvKey();
const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const program =
  cmd === 'ask' ? cmdAsk(args)
  : cmd === 'verify-person' ? cmdVerifyPerson(args)
  : cmd === 'batch' ? cmdBatch(args)
  : Effect.fail(new Error('usage: pplx <ask|verify-person|batch> ... (see file header for details)'));

Effect.runPromise(program as Effect.Effect<void, unknown>).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
