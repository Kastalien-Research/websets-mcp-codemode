// Orchestrator-side machinery: git, the append-only ledger, contract hashing,
// isolated worktrees, and the process invariants P1-P7.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALWAYS_ALLOWED,
  CONTRACT_FILES,
  SNAPSHOT_SPEND_LIMIT,
  STATE_CHECK_FILES,
  TRANSITIONS,
} from './contract.js';
import {
  fail,
  matchesAny,
  pass,
  stateIndex,
  verifierEnv,
  type StateId,
  type TransitionId,
  type TransitionSpec,
  type Verdict,
} from './kernel.js';

export const CONTRACT_DIR = 'contracts/temporal-snapshot';
export const LEDGER_PATH = `${CONTRACT_DIR}/ledger.jsonl`;

export type LedgerEntry =
  | { type: 'lock'; at: string; commit: string; contractHash: string }
  | { type: 'amend'; at: string; commit: string; contractHash: string; previousHash: string; reason: string }
  | { type: 'check-lock'; at: string; transition: TransitionId; file: string; hash: string; commit: string }
  | {
      type: 'advance';
      at: string;
      transition: TransitionId;
      from: StateId;
      to: StateId;
      base: string;
      head: string;
      contractHash: string;
      verdicts: Verdict[];
    }
  | {
      type: 'grade';
      at: string;
      transition: TransitionId;
      head: string;
      model: string;
      aggregate: number | null;
      costUsd: number;
      results: unknown[];
    }
  | { type: 'spend'; at: string; endpoint: string; snapshotAsOf: string; requestId: string | null; purpose: string };

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function repoRoot(): string {
  return git(process.cwd(), ['rev-parse', '--show-toplevel']);
}

export function readLedger(root: string): LedgerEntry[] {
  const path = join(root, LEDGER_PATH);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as LedgerEntry);
}

export function appendLedger(root: string, entry: LedgerEntry): void {
  appendFileSync(join(root, LEDGER_PATH), `${JSON.stringify(entry)}\n`);
}

/** Commits only the given paths; refuses if anything else is staged. */
export function commitPaths(root: string, paths: string[], message: string): string {
  const staged = git(root, ['diff', '--cached', '--name-only']);
  if (staged) throw new Error(`refusing to commit: unrelated staged changes:\n${staged}`);
  git(root, ['add', '--', ...paths]);
  const trailer = process.env.CONTRACT_COMMIT_TRAILER;
  git(root, ['commit', '-m', trailer ? `${message}\n\n${trailer}` : message, '--', ...paths]);
  return git(root, ['rev-parse', 'HEAD']);
}

export function isClean(root: string): boolean {
  return git(root, ['status', '--porcelain', '--untracked-files=no']) === '';
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hash of the contract definition files in a checkout, in declared order. */
export function contractHash(root: string): string {
  const h = createHash('sha256');
  for (const file of CONTRACT_FILES) {
    const path = join(root, file);
    h.update(`${file}\0`);
    h.update(existsSync(path) ? readFileSync(path) : 'MISSING');
    h.update('\0');
  }
  return h.digest('hex');
}

export function fileHash(root: string, file: string): string | null {
  const path = join(root, file);
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

/** IsolatedVerifierEnv analog: a fresh detached worktree of a committed revision. */
export function withWorktree<T>(root: string, commit: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'contract-wt-'));
  rmSync(dir, { recursive: true, force: true });
  git(root, ['worktree', 'add', '--detach', dir, commit]);
  const cleanup = () => git(root, ['worktree', 'remove', '--force', dir]);
  let result: T;
  try {
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    result = fn(dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result instanceof Promise) return result.finally(cleanup) as T;
  cleanup();
  return result;
}

export interface VerifyOutput {
  verdicts: Verdict[];
  measuredBaseline: { operations: string[]; tests: { passed: number; failed: number; skipped: number; perFile: Record<string, number> } } | null;
}

/** Runs verify.ts inside `dir` with a credential-free environment. */
export function runVerifier(dir: string, mode: 'lock' | 'check'): VerifyOutput {
  const scratch = mkdtempSync(join(tmpdir(), 'contract-verify-'));
  const out = join(scratch, 'verdicts.json');
  try {
    const proc = spawnSync('npx', ['tsx', `${CONTRACT_DIR}/verify.ts`, '--mode', mode, '--out', out], {
      cwd: dir, env: verifierEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    if (!existsSync(out)) {
      throw new Error(`verifier produced no output (exit ${proc.status}):\n${proc.stdout}\n${proc.stderr}`);
    }
    return JSON.parse(readFileSync(out, 'utf8')) as VerifyOutput;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function transition(id: TransitionId): TransitionSpec {
  const t = TRANSITIONS.find(x => x.id === id);
  if (!t) throw new Error(`unknown transition ${id}`);
  return t;
}

/** The last state recorded in the ledger (S0 once locked) and the commit it was recorded at. */
export function recordedState(ledger: LedgerEntry[]): { state: StateId; commit: string } | null {
  let current: { state: StateId; commit: string } | null = null;
  for (const e of ledger) {
    if (e.type === 'lock') current = { state: 'S0', commit: e.commit };
    if (e.type === 'advance') current = { state: e.to, commit: e.head };
  }
  return current;
}

const latestHash = (ledger: LedgerEntry[]): string | null => {
  let hash: string | null = null;
  for (const e of ledger) if (e.type === 'lock' || e.type === 'amend') hash = e.contractHash;
  return hash;
};

/**
 * Evaluates P1-P7 for advancing `t` to HEAD. `headDir` is a worktree at HEAD,
 * `cleanAtStart` is whether the caller's tree was clean when the advance began.
 */
export function processVerdicts(root: string, headDir: string, head: string, t: TransitionSpec, cleanAtStart: boolean): Verdict[] {
  const ledger = readLedger(headDir);
  const recorded = recordedState(ledger);
  const verdicts: Verdict[] = [];
  const add = (id: string, v: Omit<Verdict, 'id'>) => verdicts.push({ id, ...v });

  // P1: locked, and the contract at HEAD is the contract that was locked or amended.
  const lockedHash = latestHash(ledger);
  const headHash = contractHash(headDir);
  add('P1', !lockedHash
    ? fail('contract is not locked')
    : lockedHash === headHash
      ? pass(`contract hash ${headHash.slice(0, 12)} matches the latest lock/amend`)
      : fail(`contract hash at HEAD ${headHash.slice(0, 12)} differs from the latest lock/amend ${lockedHash.slice(0, 12)}; amend explicitly`));

  // P2: one state at a time, in order.
  add('P2', !recorded
    ? fail('no recorded state; lock first')
    : recorded.state === t.from && stateIndex(t.to) === stateIndex(t.from) + 1
      ? pass(`recorded state ${recorded.state} -> ${t.to}`)
      : fail(`recorded state is ${recorded.state}; ${t.id} requires ${t.from}`));

  const base = recorded?.commit ?? head;
  const commits = recorded ? git(root, ['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean) : [];

  // P3: checks before code.
  const checkFile = STATE_CHECK_FILES[t.to];
  const checkLocks = ledger.filter((e): e is Extract<LedgerEntry, { type: 'check-lock' }> =>
    e.type === 'check-lock' && e.transition === t.id);
  if (checkLocks.length === 0) {
    add('P3', fail(`no check-lock entry for ${t.id} (${checkFile})`));
  } else {
    const first = checkLocks[0];
    const latest = checkLocks[checkLocks.length - 1];
    const firstIdx = commits.indexOf(first.commit);
    // Commits up to and including the one the first check-lock pinned must be
    // contract-only. A check-lock taken at the base itself has no such commits.
    const preLock = first.commit === base ? [] : commits.slice(0, firstIdx < 0 ? commits.length : firstIdx + 1);
    const early = preLock.filter(c => git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', c])
      .split('\n').filter(Boolean).some(f => !f.startsWith(`${CONTRACT_DIR}/`)));
    const headCheckHash = fileHash(headDir, checkFile);
    const problems: string[] = [];
    if (first.commit !== base && firstIdx < 0) problems.push(`first check-lock commit ${first.commit.slice(0, 8)} is not between base and HEAD`);
    if (early.length > 0) problems.push(`implementation commits before the check-lock: ${early.map(c => c.slice(0, 8)).join(', ')}`);
    if (headCheckHash !== latest.hash) problems.push(`${checkFile} at HEAD does not match the latest check-lock`);
    add('P3', problems.length === 0
      ? pass(`${checkFile} pinned before implementation (${checkLocks.length} lock(s))`, { relocks: checkLocks.length - 1 })
      : fail(problems.join('; '), { relocks: checkLocks.length - 1 }));
  }

  // P4: frame condition.
  const changed = recorded ? git(root, ['diff', '--name-only', `${base}..${head}`]).split('\n').filter(Boolean) : [];
  const outside = changed.filter(f => !matchesAny(f, [...t.scope, ...ALWAYS_ALLOWED]));
  add('P4', outside.length === 0
    ? pass(`${changed.length} changed files, all within scope`, { changedFiles: changed.length })
    : fail(`outside ${t.id} scope: ${outside.join(', ')}`, { changedFiles: changed.length }));

  // P5: append-only ledger, across every committed revision up to HEAD.
  const revisions = git(root, ['log', '--format=%H', '--reverse', head, '--', LEDGER_PATH]).split('\n').filter(Boolean);
  const rewrites: string[] = [];
  let previous = '';
  for (const rev of revisions) {
    let content = '';
    try {
      content = git(root, ['show', `${rev}:${LEDGER_PATH}`]);
    } catch {
      content = ''; // deleted in this revision
    }
    if (!content.startsWith(previous)) rewrites.push(rev.slice(0, 8));
    previous = content;
  }
  add('P5', rewrites.length === 0
    ? pass(`${revisions.length} ledger revisions, each extends the previous`, { revisions: revisions.length })
    : fail(`ledger rewritten (not appended) in ${rewrites.join(', ')}`, { revisions: revisions.length }));

  // P6: isolation. The orchestrator only reaches this point from a fresh worktree.
  add('P6', cleanAtStart
    ? pass(`verified in a fresh worktree of ${head.slice(0, 8)} with an allowlisted environment`)
    : fail('working tree was dirty when the advance started'));

  // P7: spend.
  const spend = ledger.filter(e => e.type === 'spend').length;
  add('P7', spend <= SNAPSHOT_SPEND_LIMIT
    ? pass(`${spend}/${SNAPSHOT_SPEND_LIMIT} sanctioned snapshot requests`, { spend })
    : fail(`${spend} sanctioned snapshot requests exceed the limit of ${SNAPSHOT_SPEND_LIMIT}`, { spend }));

  return verdicts;
}
