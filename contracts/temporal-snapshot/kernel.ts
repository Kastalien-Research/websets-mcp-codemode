// Contract kernel: primitive types and pure evaluation logic shared by the
// verifier (deterministic invariants) and the judge (soft criteria).
//
// Vocabulary borrows from Prime Intellect's verifiers v1:
//   vf.TaskData (immutable row)      ~ StateSpec / TransitionSpec
//   @vf.reward / @vf.metric          ~ Check (pass/fail) / Metrics (raw numbers, never a verdict)
//   vf.Judge (model-backed reward)   ~ Criterion (advisory, never gates a transition)
//   IsolatedVerifierEnv              ~ checks run in a fresh worktree of a committed HEAD
//   IsolatedAgenticJudgeEnv          ~ the judge runs in its own worktree with read-only tools

export const STATE_IDS = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'] as const;
export type StateId = (typeof STATE_IDS)[number];

export const TRANSITION_IDS = ['T1', 'T2', 'T3', 'T4', 'T5'] as const;
export type TransitionId = (typeof TRANSITION_IDS)[number];

export type InvariantScope = 'global' | 'process' | 'state';

export interface Invariant {
  id: string;
  scope: InvariantScope;
  /** Normative statement. Uses MUST / MUST NOT; this is what the user approves. */
  statement: string;
  /** The deterministic procedure that decides it, in one or two sentences. */
  checkedBy: string;
}

export interface StateSpec {
  id: StateId;
  name: string;
  summary: string;
  /**
   * Postconditions first required at this state. They ratchet: every later
   * state must still satisfy them, so statements are phrased to stay true as
   * the system grows (relative to registries, never to a fixed list).
   */
  invariants: Invariant[];
  terminal?: boolean;
}

export interface TransitionSpec {
  id: TransitionId;
  from: StateId;
  to: StateId;
  /** Frame condition: files this transition may change (minimatch-style globs). */
  scope: string[];
}

export const SCORES = [0, 0.25, 0.5, 0.75, 1] as const;
export type Score = (typeof SCORES)[number];

export interface ReviewCriterion {
  kind: 'review';
  id: string;
  transitions: TransitionId[] | '*';
  weight: number;
  question: string;
  anchors: Record<'0' | '0.25' | '0.5' | '0.75' | '1', string>;
}

/**
 * The judge model plays the user of the workspace. It sees one artifact and
 * nothing else, answers questions, and the answers are scored deterministically
 * against expectations fixed in the contract. Score = fraction answered correctly.
 */
export interface ModelAsUserCriterion {
  kind: 'model-as-user';
  id: string;
  transitions: TransitionId[];
  weight: number;
  /** Repo-relative path of the artifact; produced by the transition's generator. */
  artifact: string;
  questions: Array<{
    id: string;
    ask: string;
    expect: string;
    match: 'exact' | 'contains' | 'iso-instant' | 'yes-no';
  }>;
}

export type Criterion = ReviewCriterion | ModelAsUserCriterion;

export type VerdictStatus = 'pass' | 'fail' | 'pending' | 'error';

export interface Verdict {
  id: string;
  status: VerdictStatus;
  evidence: string;
  measurements?: Record<string, number | string>;
}

export interface Baseline {
  commit: string;
  operations: string[];
  tests: { passed: number; failed: number; skipped: number; perFile: Record<string, number> };
}

export interface CheckEnv {
  /** Repository root being verified (an isolated worktree during lock/advance). */
  root: string;
  now: Date;
  mode: 'lock' | 'check';
  baseline: Baseline | null;
  /** Shared results of expensive steps (e.g. the offline suite) across checks. */
  memo: Map<string, unknown>;
}

export type Check = (env: CheckEnv) => Promise<Omit<Verdict, 'id'>>;

export const pass = (evidence: string, measurements?: Verdict['measurements']): Omit<Verdict, 'id'> =>
  ({ status: 'pass', evidence, measurements });
export const fail = (evidence: string, measurements?: Verdict['measurements']): Omit<Verdict, 'id'> =>
  ({ status: 'fail', evidence, measurements });

export const holds = (v: Verdict): boolean => v.status === 'pass';

/** Environment for verifier child processes: enough to run node tooling, no credentials. */
export function verifierEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'NODE_OPTIONS', 'SHELL', 'USER'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, CI: '1', EXA_API_KEY: '', ...extra };
}

/**
 * The current state is computed, never declared: S0 holds when every global
 * invariant passes; Sk holds when S0 holds and every invariant of S1..Sk
 * passes. Pending or erroring checks count as failures (fail-closed).
 */
export function computeState(
  states: StateSpec[],
  globalInvariants: Invariant[],
  verdicts: Map<string, Verdict>,
): { state: StateId | null; blocking: Verdict[] } {
  const failing = (ids: string[]) =>
    ids.map(id => verdicts.get(id) ?? { id, status: 'pending' as const, evidence: 'not evaluated' })
      .filter(v => !holds(v));

  const globalFailures = failing(globalInvariants.map(i => i.id));
  if (globalFailures.length > 0) return { state: null, blocking: globalFailures };

  let state: StateId = 'S0';
  for (const spec of states) {
    if (spec.id === 'S0') continue;
    const blocking = failing(spec.invariants.map(i => i.id));
    if (blocking.length > 0) return { state, blocking };
    state = spec.id;
  }
  return { state, blocking: [] };
}

export function stateIndex(id: StateId): number {
  return STATE_IDS.indexOf(id);
}

/** Minimal glob matcher: `**` crosses directories, `*` stays within one segment. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (file: string, globs: string[]): boolean =>
  globs.some(g => globToRegExp(g).test(file));
