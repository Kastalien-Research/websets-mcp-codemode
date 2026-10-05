// The verifier. Runs inside the checkout being verified (an isolated worktree
// during lock and advance), evaluates every invariant it can find a check for,
// and writes raw verdicts as JSON. It decides nothing about the process; the
// orchestrator (run.ts) does that from these verdicts plus git and the ledger.
//
// usage: tsx contracts/temporal-snapshot/verify.ts --mode check|lock --out <file> [--now <iso>]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GLOBAL_INVARIANTS, STATES, STATE_CHECK_FILES } from './contract.js';
import type { Baseline, Check, CheckEnv, Invariant, Verdict } from './kernel.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadChecks(file: string): Promise<{ checks: Record<string, Check> } | { error: string }> {
  const path = join(root, file);
  if (!existsSync(path)) return { error: `check file ${file} does not exist` };
  try {
    const mod = await import(pathToFileURL(path).href);
    return { checks: mod.checks as Record<string, Check> };
  } catch (err) {
    return { error: `check file ${file} failed to load: ${(err as Error).message}` };
  }
}

async function evaluate(invariants: Invariant[], file: string, env: CheckEnv): Promise<Verdict[]> {
  const loaded = await loadChecks(file);
  const verdicts: Verdict[] = [];
  for (const inv of invariants) {
    if ('error' in loaded) {
      verdicts.push({ id: inv.id, status: 'pending', evidence: loaded.error });
      continue;
    }
    const check = loaded.checks[inv.id];
    if (!check) {
      verdicts.push({ id: inv.id, status: 'pending', evidence: `no check registered for ${inv.id}` });
      continue;
    }
    try {
      verdicts.push({ id: inv.id, ...(await check(env)) });
    } catch (err) {
      verdicts.push({ id: inv.id, status: 'error', evidence: `check threw: ${(err as Error).stack ?? err}` });
    }
  }
  return verdicts;
}

async function main() {
  const mode = arg('mode') === 'lock' ? 'lock' : 'check';
  const out = arg('out');
  if (!out) throw new Error('--out is required');
  const baselinePath = join(here, 'fixtures', 'baseline.json');
  const env: CheckEnv = {
    root,
    now: arg('now') ? new Date(arg('now')!) : new Date(),
    mode,
    baseline: mode === 'check' && existsSync(baselinePath)
      ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline)
      : null,
    memo: new Map(),
  };

  const verdicts = await evaluate(GLOBAL_INVARIANTS, 'contracts/temporal-snapshot/invariants/global.ts', env);
  for (const state of STATES) {
    if (state.invariants.length === 0) continue;
    verdicts.push(...await evaluate(state.invariants, STATE_CHECK_FILES[state.id], env));
  }

  const tests = env.memo.get('baselineTests') as Baseline['tests'] | undefined;
  const operations = env.memo.get('operations') as string[] | undefined;
  writeFileSync(out, JSON.stringify({
    verdicts,
    measuredBaseline: tests && operations ? { operations, tests } : null,
  }, null, 2));
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err);
    process.exit(2);
  },
);
