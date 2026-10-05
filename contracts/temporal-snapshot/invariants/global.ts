// Global invariants G1-G5: must hold in every state, S0 included.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALLOWED_REMOVALS, ALLOWED_REMOVED_TEST_FILES } from '../contract.js';
import { fail, pass, verifierEnv, type Check, type CheckEnv } from '../kernel.js';
import { renderContract } from '../render.js';

const tail = (s: string, n = 1500) => (s.length > n ? `...${s.slice(-n)}` : s);

interface SuiteRun {
  /** True only when vitest exited normally and wrote its JSON report. */
  completed: boolean;
  exitCode: number;
  signal: string | null;
  attempts: number;
  passed: number;
  failed: number;
  skipped: number;
  perFile: Record<string, number>;
  failingTests: string[];
  netAttempts: string[];
  output: string;
}

/** Attempts allowed when vitest dies without writing a report (infrastructure, never test failures). */
const SUITE_ATTEMPTS = 3;

function runOfflineSuite(env: CheckEnv): SuiteRun {
  const cached = env.memo.get('offlineSuite') as SuiteRun | undefined;
  if (cached) return cached;
  let run = runOfflineSuiteOnce(env, 1);
  while (!run.completed && run.failed === 0 && run.attempts < SUITE_ATTEMPTS) {
    run = runOfflineSuiteOnce(env, run.attempts + 1);
  }
  env.memo.set('offlineSuite', run);
  return run;
}

function runOfflineSuiteOnce(env: CheckEnv, attempt: number): SuiteRun {
  const scratch = mkdtempSync(join(tmpdir(), 'contract-suite-'));
  const jsonOut = join(scratch, 'vitest.json');
  const netLog = join(scratch, 'net.log');
  const proc = spawnSync(
    'npx',
    [
      'vitest', 'run',
      '--config', 'contracts/temporal-snapshot/harness/offline.vitest.config.ts',
      '--reporter=json', '--outputFile', jsonOut,
    ],
    { cwd: env.root, env: verifierEnv({ CONTRACT_NET_LOG: netLog }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  const run: SuiteRun = {
    completed: false,
    exitCode: proc.status ?? -1,
    signal: proc.signal ?? (proc.error ? `spawn error: ${proc.error.message}` : null),
    attempts: attempt,
    passed: 0,
    failed: 0,
    skipped: 0,
    perFile: {},
    failingTests: [],
    netAttempts: existsSync(netLog) ? readFileSync(netLog, 'utf8').split('\n').filter(Boolean) : [],
    output: `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`,
  };
  if (existsSync(jsonOut)) {
    const report = JSON.parse(readFileSync(jsonOut, 'utf8')) as {
      testResults: Array<{ name: string; assertionResults: Array<{ status: string; fullName: string }> }>;
    };
    for (const file of report.testResults) {
      const rel = relative(env.root, file.name);
      let filePassed = 0;
      for (const a of file.assertionResults) {
        if (a.status === 'passed') filePassed++;
        else if (a.status === 'failed') run.failingTests.push(`${rel} > ${a.fullName}`);
        else run.skipped++;
      }
      run.perFile[rel] = filePassed;
      run.passed += filePassed;
    }
    run.failed = run.failingTests.length;
    run.completed = proc.status !== null && Object.keys(run.perFile).length > 0;
  }
  rmSync(scratch, { recursive: true, force: true });
  return run;
}

const suiteMeasurements = (run: SuiteRun) => ({
  passed: run.passed,
  failed: run.failed,
  skipped: run.skipped,
  exitCode: run.exitCode,
  attempts: run.attempts,
  ...(run.signal ? { signal: run.signal } : {}),
});

const incomplete = (run: SuiteRun) =>
  `offline suite did not complete after ${run.attempts} attempt(s) (exit ${run.exitCode}, signal ${run.signal ?? 'none'}): ${tail(run.output)}`;

async function registeredOperations(env: CheckEnv): Promise<string[]> {
  const mod = await import(pathToFileURL(join(env.root, 'src/tools/operations.ts')).href);
  return Object.keys(mod.OPERATIONS).sort();
}

export const checks: Record<string, Check> = {
  async G1(env) {
    const proc = spawnSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], {
      cwd: env.root, env: verifierEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    return proc.status === 0
      ? pass('tsc --noEmit exited 0')
      : fail(`tsc --noEmit exited ${proc.status}: ${tail(`${proc.stdout}${proc.stderr}`)}`);
  },

  async G2(env) {
    const run = runOfflineSuite(env);
    const m = suiteMeasurements(run);
    if (!run.completed && run.failed === 0) return fail(incomplete(run), m);
    if (run.exitCode !== 0 || run.failed > 0) {
      return fail(
        `offline suite exit ${run.exitCode}, ${run.failed} failing: ${run.failingTests.slice(0, 10).join('; ') || tail(run.output)}`,
        m,
      );
    }
    env.memo.set('baselineTests', { passed: run.passed, failed: run.failed, skipped: run.skipped, perFile: run.perFile });
    if (env.mode === 'lock') return pass(`baseline recorded: ${run.passed} passed, ${run.skipped} skipped`, m);
    if (!env.baseline) return fail('no baseline recorded; lock the contract first', m);

    const removedAllowance = ALLOWED_REMOVED_TEST_FILES
      .filter(f => !existsSync(join(env.root, f)))
      .reduce((sum, f) => sum + (env.baseline!.tests.perFile[f] ?? 0), 0);
    const floor = env.baseline.tests.passed - removedAllowance;
    return run.passed >= floor
      ? pass(`${run.passed} passed >= floor ${floor} (baseline ${env.baseline.tests.passed}, allowance ${removedAllowance})`, m)
      : fail(`${run.passed} passed < floor ${floor} (baseline ${env.baseline.tests.passed}, allowance ${removedAllowance})`, m);
  },

  async G3(env) {
    const run = runOfflineSuite(env);
    // A suite that never ran cannot certify that it made no requests.
    if (!run.completed) return fail(incomplete(run), { attempts: run.netAttempts.length });
    return run.netAttempts.length === 0
      ? pass('no outbound non-loopback requests during the offline suite', { attempts: 0 })
      : fail(`blocked outbound requests: ${[...new Set(run.netAttempts)].join(', ')}`, { attempts: run.netAttempts.length });
  },

  async G4(env) {
    const ops = await registeredOperations(env);
    env.memo.set('operations', ops);
    if (env.mode === 'lock') return pass(`baseline recorded: ${ops.length} operations`, { operations: ops.length });
    if (!env.baseline) return fail('no baseline recorded; lock the contract first');
    const missing = env.baseline.operations.filter(op => !ALLOWED_REMOVALS.includes(op) && !ops.includes(op));
    return missing.length === 0
      ? pass(`${ops.length} operations; every S0 operation present except allowed removals`, { operations: ops.length })
      : fail(`missing S0 operations: ${missing.join(', ')}`, { operations: ops.length });
  },

  async G5(env) {
    const path = join(env.root, 'contracts/temporal-snapshot/CONTRACT.md');
    if (!existsSync(path)) return fail('CONTRACT.md is missing');
    return readFileSync(path, 'utf8') === renderContract()
      ? pass('CONTRACT.md matches the rendering of contract.ts')
      : fail('CONTRACT.md differs from the rendering of contract.ts; run `run.ts render`');
  },
};
