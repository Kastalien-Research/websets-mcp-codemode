// The temporal-snapshot contract: S0 (today) -> S5 (terminal).
//
// This file is the single source of truth. CONTRACT.md is rendered from it
// (invariant G5 keeps the two identical), and its hash is pinned in the ledger
// at lock time (invariant P1), so any later edit shows up as an amendment.

import type {
  Criterion,
  Invariant,
  StateSpec,
  TransitionSpec,
} from './kernel.js';

export const CONTRACT_ID = 'temporal-snapshot';
export const CONTRACT_VERSION = 1;

/** Sanctioned live Snapshot requests for the whole process (P7). The account cap is 100. */
export const SNAPSHOT_SPEND_LIMIT = 10;

/** Operations the contract allows to disappear from the registry (G4). */
export const ALLOWED_REMOVALS = [
  'research.create',
  'research.get',
  'research.list',
  'research.pollUntilFinished',
];
/** Test files whose baseline tests may disappear with them (G2). */
export const ALLOWED_REMOVED_TEST_FILES = ['src/handlers/__tests__/research.test.ts'];

/** Files whose hash is pinned at lock. Per-state check files are pinned per transition (P3). */
export const CONTRACT_FILES = [
  'contracts/temporal-snapshot/CONTRACT.md',
  'contracts/temporal-snapshot/contract.ts',
  'contracts/temporal-snapshot/kernel.ts',
  'contracts/temporal-snapshot/render.ts',
  'contracts/temporal-snapshot/verify.ts',
  'contracts/temporal-snapshot/process.ts',
  'contracts/temporal-snapshot/judge.ts',
  'contracts/temporal-snapshot/run.ts',
  'contracts/temporal-snapshot/invariants/global.ts',
  'contracts/temporal-snapshot/harness/offline.vitest.config.ts',
  'contracts/temporal-snapshot/harness/net-guard.setup.ts',
  'contracts/temporal-snapshot/harness/recording-client.ts',
  'contracts/temporal-snapshot/fixtures/baseline.json',
  'contracts/temporal-snapshot/fixtures/exa-spec.json',
  'contracts/temporal-snapshot/fixtures/team-management-spec.yaml',
];

export const STATE_CHECK_FILES: Record<string, string> = {
  S1: 'contracts/temporal-snapshot/invariants/s1.ts',
  S2: 'contracts/temporal-snapshot/invariants/s2.ts',
  S3: 'contracts/temporal-snapshot/invariants/s3.ts',
  S4: 'contracts/temporal-snapshot/invariants/s4.ts',
  S5: 'contracts/temporal-snapshot/invariants/s5.ts',
};

/**
 * Files every transition may touch in addition to its own scope (P4). The
 * contract directory is safe to allow: its definition files are hash-pinned
 * (P1), check files are pinned per transition (P3), the ledger is append-only (P5).
 */
export const ALWAYS_ALLOWED = ['contracts/temporal-snapshot/**', '**/__tests__/**', 'CHANGELOG.md'];

// ---------------------------------------------------------------------------
// Global invariants: hold in every state, S0 included.
// ---------------------------------------------------------------------------

export const GLOBAL_INVARIANTS: Invariant[] = [
  {
    id: 'G1',
    scope: 'global',
    statement: 'The project MUST typecheck: `tsc --noEmit` exits 0.',
    checkedBy: 'Runs `tsc --noEmit -p tsconfig.json` in the verified checkout.',
  },
  {
    id: 'G2',
    scope: 'global',
    statement:
      'The offline test suite (every vitest file except `src/__tests__/e2e/**` and `**/integration/**`) MUST report zero failures, and its passed count MUST be at least the S0 baseline minus the baseline tests of files the contract allows to be deleted.',
    checkedBy:
      'Runs vitest with the contract harness config and a JSON reporter, then compares counts with fixtures/baseline.json.',
  },
  {
    id: 'G3',
    scope: 'global',
    statement:
      'The offline test suite MUST make zero outbound requests to non-loopback hosts (no live Exa spend from tests).',
    checkedBy:
      'A vitest setup file replaces global fetch before any module loads, blocks non-loopback hosts and logs each attempt; the log must be empty.',
  },
  {
    id: 'G4',
    scope: 'global',
    statement:
      'The operation registry MUST contain every S0 operation except the allowed removals (`research.*`).',
    checkedBy: 'Imports OPERATIONS and diffs its keys against fixtures/baseline.json.',
  },
  {
    id: 'G5',
    scope: 'global',
    statement: 'CONTRACT.md MUST be byte-identical to the rendering of contract.ts.',
    checkedBy: 'Renders contract.ts and compares it with the committed CONTRACT.md.',
  },
];

// ---------------------------------------------------------------------------
// Process invariants: hold across the whole sequence of transitions. Checked
// by the orchestrator from git history and the ledger.
// ---------------------------------------------------------------------------

export const PROCESS_INVARIANTS: Invariant[] = [
  {
    id: 'P1',
    scope: 'process',
    statement:
      'The contract MUST be locked before any transition, and the hash of the contract files at HEAD MUST equal the latest lock or amendment hash in the ledger.',
    checkedBy: 'Hashes CONTRACT_FILES at HEAD and compares with the last `lock`/`amend` ledger entry.',
  },
  {
    id: 'P2',
    scope: 'process',
    statement:
      'Transitions MUST advance one state at a time, in order: advancing to Sk requires the last recorded state to be S(k-1).',
    checkedBy: 'Reads `advance` entries from the ledger.',
  },
  {
    id: 'P3',
    scope: 'process',
    statement:
      'Checks come before code: a `check-lock` entry MUST pin the hash of the target state\'s check file before any commit of the transition touches files outside the contract directory, and at advance the check file MUST still match the latest pin.',
    checkedBy:
      'Walks commits between the transition base and HEAD; compares the check file hash at HEAD with the latest `check-lock`.',
  },
  {
    id: 'P4',
    scope: 'process',
    statement:
      'Frame condition: every file changed between the transition base and HEAD MUST match the transition scope or the always-allowed set.',
    checkedBy: '`git diff --name-only base..HEAD`, matched against globs.',
  },
  {
    id: 'P5',
    scope: 'process',
    statement: 'The ledger MUST be append-only: the ledger at HEAD extends the ledger at the transition base.',
    checkedBy: 'Prefix comparison of `git show base:ledger.jsonl` and the ledger at HEAD.',
  },
  {
    id: 'P6',
    scope: 'process',
    statement:
      'Advance verdicts MUST come from a fresh worktree of a committed HEAD, with a clean working tree and no Exa or Anthropic credentials in the verifier environment.',
    checkedBy:
      'The orchestrator refuses to advance on a dirty tree, creates the worktree itself, and launches the verifier with an allowlisted environment.',
  },
  {
    id: 'P7',
    scope: 'process',
    statement: `Live Snapshot requests made by contract tooling MUST total at most ${SNAPSHOT_SPEND_LIMIT} over the whole process (from S3, the server's own spend ledger counts too).`,
    checkedBy: 'Sums `spend` entries in the ledger (plus the S3 spend table once it exists).',
  },
];

// ---------------------------------------------------------------------------
// States. Each state's invariants are postconditions that ratchet forward.
// ---------------------------------------------------------------------------

export const STATES: StateSpec[] = [
  {
    id: 'S0',
    name: 'Baseline',
    summary:
      'The repository as locked: build and offline suite green, `snapshotAsOf` silently dropped by the Exa schemas, `research.*` still registered.',
    invariants: [],
  },
  {
    id: 'S1',
    name: 'Strict surface',
    summary: 'Nothing a caller sends is dropped without an error.',
    invariants: [
      {
        id: 'S1.1',
        scope: 'state',
        statement:
          'For every registered operation, a call carrying an unknown top-level key MUST be rejected before any handler runs, and the error text MUST name that key.',
        checkedBy:
          'Dispatches every operation with a probe key in compat preview mode against a client that records calls; each must return isError naming the key, with zero calls.',
      },
      {
        id: 'S1.2',
        scope: 'state',
        statement:
          'No object schema reachable from any operation schema MAY use zod\'s default `strip` mode; each MUST be `strict` or `passthrough`.',
        checkedBy: 'Walks every operation schema through wrappers, unions, arrays and records.',
      },
      {
        id: 'S1.3',
        scope: 'state',
        statement:
          '`snapshotAsOf` MUST NOT be silently dropped by `exa.search` (inside `contents`) or `exa.getContents` (top level, both the urls and the ids path): each call either fails with an error naming it or forwards it unchanged in the outgoing request.',
        checkedBy: 'Runs the real handlers against a recording client and inspects the recorded request.',
      },
    ],
  },
  {
    id: 'S2',
    name: 'Temporal cursor',
    summary:
      'A run can be pinned to an instant. Pinning is enforced at the client boundary, so no handler or workflow can reach the live web from a pinned run.',
    invariants: [
      {
        id: 'S2.1',
        scope: 'state',
        statement:
          'The `execute` tool MUST accept an optional `asOf` (ISO 8601 date or date-time) and MUST reject malformed values, instants in the future, and instants older than the documented 5-month Snapshot window.',
        checkedBy: 'Probes the registered input schema and the asOf parser with an injected clock.',
      },
      {
        id: 'S2.2',
        scope: 'state',
        statement:
          'In a pinned run, every operation not in `PINNABLE_OPERATIONS` MUST fail with a `TEMPORAL_BOUNDARY` error before validation and before any Exa call.',
        checkedBy: 'Dispatches every non-pinnable operation under `asOf` against a recording client; zero calls, tagged error.',
      },
      {
        id: 'S2.3',
        scope: 'state',
        statement:
          'In a pinned run, handlers and workflows MUST receive only a pinned client: every client method outside the pinnable set MUST throw `TEMPORAL_BOUNDARY`, and `new Exa(` MUST appear only in declared bootstrap files.',
        checkedBy: 'Calls each known SDK method path on the pinned client; greps `src/` for client construction.',
      },
      {
        id: 'S2.4',
        scope: 'state',
        statement:
          'Pinned `exa.search` and `exa.getContents` requests MUST carry `snapshotAsOf` no later than `asOf` (injected when absent); a per-call `snapshotAsOf` later than `asOf` MUST be rejected with zero calls.',
        checkedBy: 'Recording client under `asOf`, with and without per-call values on both sides of the ceiling.',
      },
      {
        id: 'S2.5',
        scope: 'state',
        statement:
          'Any request carrying a snapshot MUST be rejected with zero calls when it also sets `livecrawl`, `livecrawlTimeout`, `maxAgeHours` or `subpages`, or, on search, a deep `type` or a `category`.',
        checkedBy: 'One probe per forbidden field, pinned and per-call.',
      },
      {
        id: 'S2.6',
        scope: 'state',
        statement:
          'Every result returned under a snapshot MUST carry `snapshotAt` no later than the effective `snapshotAsOf`; a later or missing `snapshotAt` MUST turn the call into a `TEMPORAL_LEAK` error that returns none of the offending content.',
        checkedBy: 'Recording client returns crafted late and missing `snapshotAt` values; output must be the tagged error without the content.',
      },
      {
        id: 'S2.7',
        scope: 'state',
        statement:
          'A pinned `execute` response MUST carry `asOf` at its top level, and pinned search responses MUST state that discovery used current ranking.',
        checkedBy: 'Runs `execute` in-process under `asOf` with a recording client and inspects the envelope.',
      },
      {
        id: 'S2.8',
        scope: 'state',
        statement:
          'Without `asOf` and without a per-call `snapshotAsOf`, outgoing requests MUST NOT contain `snapshotAsOf`.',
        checkedBy: 'Recording client, live mode.',
      },
      {
        id: 'S2.9',
        scope: 'state',
        statement:
          'A recorded live fixture of one pinned search and one pinned contents call (at most 2 sanctioned requests) MUST exist and MUST show the response fields S2.6 depends on.',
        checkedBy: 'Reads fixtures/t2-live-probe.json and its matching `spend` ledger entries.',
      },
    ],
  },
  {
    id: 'S3',
    name: 'Page history',
    summary: 'Every version the workspace has seen is kept locally, re-reads are free when provably correct, and the quota is visible.',
    invariants: [
      {
        id: 'S3.1',
        scope: 'state',
        statement:
          'Every snapshot response MUST be persisted as page versions keyed by (url, snapshotAt) with a content hash, and for every stored row sha256(content) MUST equal the stored hash.',
        checkedBy: 'Runs pinned reads against a recording client into a temp store, then rehashes every row.',
      },
      {
        id: 'S3.2',
        scope: 'state',
        statement:
          'With an immutable upstream history, a pinned read MUST return exactly the newest version at or before `asOf`, and MUST call upstream if and only if `asOf` falls outside every recorded interval [snapshotAt, requestedAsOf] for that URL.',
        checkedBy: 'Property check over seeded random version timelines and request sequences.',
      },
      {
        id: 'S3.3',
        scope: 'state',
        statement:
          'A served version MUST never have `snapshotAt` later than the requested instant, including after upstream history is backfilled.',
        checkedBy: 'Property check with backfill events injected between requests.',
      },
      {
        id: 'S3.4',
        scope: 'state',
        statement:
          'Each upstream request carrying `snapshotAsOf` MUST increment the local spend ledger by exactly 1, and cache hits MUST NOT increment it.',
        checkedBy: 'Compares recorded upstream calls with the ledger delta over the S3.2 sequences.',
      },
      {
        id: 'S3.5',
        scope: 'state',
        statement:
          'When the local spend count reaches `SNAPSHOT_BUDGET` (default 100), uncached pinned requests MUST fail with `TEMPORAL_BUDGET` and zero upstream calls, while cached reads still succeed.',
        checkedBy: 'Seeds the ledger at the budget and probes cached and uncached reads.',
      },
      {
        id: 'S3.6',
        scope: 'state',
        statement:
          'The `status` tool MUST report snapshot `used`, `budget` and the valid window `{from, to}`, with `used` equal to the ledger count.',
        checkedBy: 'Calls the status builder in-process against a seeded store.',
      },
    ],
  },
  {
    id: 'S4',
    name: 'Backtest and compare',
    summary: 'Whole workflows can run in the past, the local store respects the cursor, and versions can be compared.',
    invariants: [
      {
        id: 'S4.1',
        scope: 'state',
        statement:
          '`snapshot.diff({url, from, to})` MUST return no changes when both sides resolve to the same version, MUST include the changed line of each fixture pair, MUST reject `from` later than `to`, and MUST refuse `to: "live"` in a pinned run.',
        checkedBy: 'Fixture version pairs through a recording client.',
      },
      {
        id: 'S4.2',
        scope: 'state',
        statement:
          '`tasks.create` MUST accept `asOf`, and every registered workflow type run under it MUST make zero unpinned Exa calls, failing with `TEMPORAL_BOUNDARY` where it needs a capability that cannot be pinned.',
        checkedBy: 'Runs each workflow type under `asOf` with a recording client underneath the pinned client.',
      },
      {
        id: 'S4.3',
        scope: 'state',
        statement:
          'Store reads admitted to `PINNABLE_OPERATIONS` MUST return only records created at or before `asOf`.',
        checkedBy: 'Seeds records on both sides of `asOf` and reads them pinned.',
      },
      {
        id: 'S4.4',
        scope: 'state',
        statement: 'Verdict evidence MUST round-trip `(url, snapshotAt, contentHash)` tuples unchanged through the store.',
        checkedBy: 'Write then read through the store operations.',
      },
    ],
  },
  {
    id: 'S5',
    name: 'Gap closure',
    summary: 'The rest of the Exa API is covered, retired surface is gone, and the docs match.',
    terminal: true,
    invariants: [
      {
        id: 'S5.1',
        scope: 'state',
        statement:
          'Every operationId in the pinned Exa OpenAPI spec MUST map to a registered operation; the team-management read endpoints (list, get, usage) MUST be mapped and its write endpoints MUST NOT.',
        checkedBy: 'Joins fixtures/exa-spec.json and fixtures/team-management-spec.yaml with SPEC_OPERATION_MAP.',
      },
      {
        id: 'S5.2',
        scope: 'state',
        statement:
          'For the core endpoints (search, contents, answer, findSimilar, agent runs, batches, search monitors), every top-level schema key MUST exist in the spec request (body, path or query) or in the declared local extensions.',
        checkedBy: 'Compares schema keys with spec request properties plus LOCAL_EXTENSIONS.',
      },
      {
        id: 'S5.3',
        scope: 'state',
        statement:
          '`exa.search` category values MUST equal the spec enum; `agentRuns.create` effort values MUST equal the spec `AgentEffort` enum, and `budget` MUST accept the spec `AgentBudget` fields.',
        checkedBy: 'Set equality between zod enums and spec enums.',
      },
      {
        id: 'S5.4',
        scope: 'state',
        statement:
          '`research.*` operations, their handler, and `startCrawlDate`/`endCrawlDate` MUST be gone from the registry, the catalog and every schema.',
        checkedBy: 'Registry, catalog and schema walk.',
      },
      {
        id: 'S5.5',
        scope: 'state',
        statement:
          'Requests with `highlights.dynamic: true` MUST carry the header `Exa-Beta: dynamic-highlights-2026-08-28`.',
        checkedBy: 'Captures outgoing headers through a stubbed fetch.',
      },
      {
        id: 'S5.6',
        scope: 'state',
        statement: 'The `search` tool catalog MUST list exactly the registered operations, plus workflows.',
        checkedBy: 'Set comparison between the catalog and OPERATIONS.',
      },
      {
        id: 'S5.7',
        scope: 'state',
        statement:
          'Documented operation counts MUST match the registry, and no document MAY reference a removed operation.',
        checkedBy: 'Greps CLAUDE.md, README.md and docs/ for counts and removed names.',
      },
      {
        id: 'S5.8',
        scope: 'state',
        statement: '`docker compose build` MUST succeed.',
        checkedBy: 'Runs the build; an unavailable Docker daemon counts as a failure.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Transitions and their frame conditions.
// ---------------------------------------------------------------------------

export const TRANSITIONS: TransitionSpec[] = [
  {
    id: 'T1',
    from: 'S0',
    to: 'S1',
    scope: ['src/handlers/**', 'src/tools/**', 'src/workflows/**'],
  },
  {
    id: 'T2',
    from: 'S1',
    to: 'S2',
    scope: [
      'src/temporal/**',
      'src/handlers/**',
      'src/tools/**',
      'src/workflows/**',
      'src/server.ts',
      'src/index.ts',
    ],
  },
  {
    id: 'T3',
    from: 'S2',
    to: 'S3',
    scope: ['src/temporal/**', 'src/store/**', 'src/handlers/**', 'src/tools/**', 'src/server.ts'],
  },
  {
    id: 'T4',
    from: 'S3',
    to: 'S4',
    scope: ['src/temporal/**', 'src/store/**', 'src/handlers/**', 'src/workflows/**', 'src/tools/**'],
  },
  {
    id: 'T5',
    from: 'S4',
    to: 'S5',
    scope: [
      'src/handlers/**',
      'src/tools/**',
      'src/workflows/**',
      'src/lib/**',
      'src/server.ts',
      'CLAUDE.md',
      'README.md',
      'TOOL_SCHEMAS.md',
      'WORKFLOWS.md',
      'EXAMPLES.md',
      'QUICKSTART.md',
      'AGENTS.md',
      'docs/**',
    ],
  },
];

// ---------------------------------------------------------------------------
// S5 lookup tables.
// ---------------------------------------------------------------------------

export const SPEC_OPERATION_MAP: Record<string, string> = {
  search: 'exa.search',
  getContents: 'exa.getContents',
  answer: 'exa.answer',
  findSimilar: 'exa.findSimilar',
  createMonitor: 'searchMonitors.create',
  listMonitors: 'searchMonitors.list',
  batchMonitors: 'searchMonitors.batch',
  getMonitor: 'searchMonitors.get',
  updateMonitor: 'searchMonitors.update',
  deleteMonitor: 'searchMonitors.delete',
  triggerMonitor: 'searchMonitors.trigger',
  listRuns: 'searchMonitors.runs.list',
  getRun: 'searchMonitors.runs.get',
  createAgentRun: 'agentRuns.create',
  listAgentRuns: 'agentRuns.list',
  getAgentRun: 'agentRuns.get',
  deleteAgentRun: 'agentRuns.delete',
  cancelAgentRun: 'agentRuns.cancel',
  stopAgentRun: 'agentRuns.stop',
  listAgentRunEvents: 'agentRuns.events',
  createBatch: 'batches.create',
  listBatches: 'batches.list',
  getBatch: 'batches.get',
  deleteBatch: 'batches.delete',
  cancelBatch: 'batches.cancel',
  'teams-me-get': 'teams.me',
  'websets-create': 'websets.create',
  'websets-list': 'websets.list',
  'websets-get': 'websets.get',
  'websets-update': 'websets.update',
  'websets-delete': 'websets.delete',
  'websets-cancel': 'websets.cancel',
  'websets-preview': 'websets.preview',
  'websets-searches-create': 'searches.create',
  'websets-searches-get': 'searches.get',
  'websets-searches-cancel': 'searches.cancel',
  'websets-enrichments-create': 'enrichments.create',
  'websets-enrichments-update': 'enrichments.update',
  'websets-enrichments-get': 'enrichments.get',
  'websets-enrichments-delete': 'enrichments.delete',
  'websets-enrichments-cancel': 'enrichments.cancel',
  'websets-items-get': 'items.get',
  'websets-items-delete': 'items.delete',
  'websets-items-list': 'items.list',
  'monitors-create': 'monitors.create',
  'monitors-list': 'monitors.list',
  'monitors-get': 'monitors.get',
  'monitors-update': 'monitors.update',
  'monitors-delete': 'monitors.delete',
  'monitors-runs-list': 'monitors.runs.list',
  'monitors-runs-get': 'monitors.runs.get',
  'imports-create': 'imports.create',
  'imports-list': 'imports.list',
  'imports-get': 'imports.get',
  'imports-update': 'imports.update',
  'imports-delete': 'imports.delete',
  'webhooks-create': 'webhooks.create',
  'webhooks-list': 'webhooks.list',
  'webhooks-get': 'webhooks.get',
  'webhooks-update': 'webhooks.update',
  'webhooks-delete': 'webhooks.delete',
  'webhooks-attempts-list': 'webhooks.list_attempts',
  'events-list': 'events.list',
  'events-get': 'events.get',
};

export const TEAM_SPEC_READ_MAP: Record<string, string> = {
  'list-api-keys': 'teams.apiKeys.list',
  'get-api-key': 'teams.apiKeys.get',
  'get-api-key-usage': 'teams.apiKeys.usage',
};
export const TEAM_SPEC_WRITE_IDS = ['create-api-key', 'update-api-key', 'delete-api-key'];

/** Schema keys that are local to this server rather than part of the Exa request. */
export const LOCAL_EXTENSIONS: Record<string, string[]> = {
  '*': ['compat'],
  'exa.search': ['stream'],
  'exa.answer': ['stream'],
  'exa.getContents': ['urls'],
  'agentRuns.create': ['stream'],
};

// ---------------------------------------------------------------------------
// Soft criteria. Advisory: recorded in the ledger, never gate a transition.
// ---------------------------------------------------------------------------

const REVIEW_ANCHORS = (best: string, worst: string) => ({
  '0': worst,
  '0.25': 'Mostly falls short; one or two redeeming parts.',
  '0.5': 'Mixed: about as many problems as strengths.',
  '0.75': 'Good, with minor issues a reviewer would mention.',
  '1': best,
});

/** Fixture constants the model-as-user expectations depend on (generators must use them). */
export const FIXTURE_CONSTANTS = {
  t2: {
    asOf: '2026-08-01T00:00:00.000Z',
    firstResultUrl: 'https://example.com/pricing',
    firstResultSnapshotAt: '2026-07-14T03:12:00.000Z',
  },
  t3: { used: 37, budget: 100, windowFrom: '2026-05-05' },
  t4: { url: 'https://example.com/pricing', before: '$20', after: '$25' },
};

export const CRITERIA: Criterion[] = [
  {
    kind: 'review',
    id: 'C1-idiom',
    transitions: '*',
    weight: 1,
    question:
      'Does the new and changed code read like the code around it: naming, comment density, error handling through successResult/errorResult, schema style, module layout?',
    anchors: REVIEW_ANCHORS(
      'Indistinguishable from the surrounding code by a careful reader.',
      'Conspicuously foreign: new conventions, wrappers or styles the codebase does not use.',
    ),
  },
  {
    kind: 'review',
    id: 'C2-minimality',
    transitions: '*',
    weight: 1,
    question:
      'Is this the smallest change that reaches the target state? Look for speculative abstraction, options nobody uses, unrelated edits, and code that a deletion would not miss.',
    anchors: REVIEW_ANCHORS(
      'Nothing could be removed without failing an invariant or losing a stated behavior.',
      'Large parts of the change are unrelated to the target state or speculative.',
    ),
  },
  {
    kind: 'review',
    id: 'C3-check-fidelity',
    transitions: '*',
    weight: 2,
    question:
      'For each invariant of the target state, does its deterministic check (in contracts/temporal-snapshot/invariants/) test what the statement says, including the negative cases, rather than a weaker or happy-path-only property? Cite the statement and the check line for every gap.',
    anchors: REVIEW_ANCHORS(
      'Every check is at least as strong as its statement, including negative cases.',
      'Several checks would pass on an implementation that clearly violates the statement.',
    ),
  },
  {
    kind: 'review',
    id: 'C4-test-quality',
    transitions: '*',
    weight: 1,
    question:
      'Do the new tests pin behavior rather than implementation details, and would each failure message tell a reader what broke?',
    anchors: REVIEW_ANCHORS(
      'Tests read as a behavioral spec; failures are self-explaining.',
      'Tests mirror the implementation or would fail without explaining why.',
    ),
  },
  {
    kind: 'review',
    id: 'C5-rejection-usefulness',
    transitions: ['T1'],
    weight: 1,
    question:
      'From the error text alone, could a model that sent a wrong key fix its call? Consider whether the error names the key, points at the valid keys or the nearest match, and stays short.',
    anchors: REVIEW_ANCHORS(
      'A model would fix the call on the first retry for typos and stale parameter names alike.',
      'The error names nothing actionable.',
    ),
  },
  {
    kind: 'review',
    id: 'C6-refusal-usefulness',
    transitions: ['T2'],
    weight: 1,
    question:
      'When a pinned run refuses an operation or a parameter, does the message say why it cannot be pinned and what to do instead (a pinnable alternative, or leaving pinned mode)?',
    anchors: REVIEW_ANCHORS(
      'Every refusal explains the boundary and names a concrete next step.',
      'Refusals are bare error codes.',
    ),
  },
  {
    kind: 'model-as-user',
    id: 'C7-pinned-legibility',
    transitions: ['T2'],
    weight: 2,
    artifact: 'contracts/temporal-snapshot/fixtures/t2-pinned-response.json',
    questions: [
      {
        id: 'bound',
        ask: 'Up to which instant is the page content in this response guaranteed to be bounded? Answer with the ISO 8601 instant only.',
        expect: FIXTURE_CONSTANTS.t2.asOf,
        match: 'iso-instant',
      },
      {
        id: 'ranking',
        ask: 'Could the choice and order of these search results have been influenced by information from after that instant? Answer yes or no.',
        expect: 'yes',
        match: 'yes-no',
      },
      {
        id: 'crawl',
        ask: `When was the stored version of ${FIXTURE_CONSTANTS.t2.firstResultUrl} in this response crawled? Answer with the ISO 8601 instant only.`,
        expect: FIXTURE_CONSTANTS.t2.firstResultSnapshotAt,
        match: 'iso-instant',
      },
    ],
  },
  {
    kind: 'model-as-user',
    id: 'C8-status-legibility',
    transitions: ['T3'],
    weight: 1,
    artifact: 'contracts/temporal-snapshot/fixtures/t3-status.json',
    questions: [
      {
        id: 'remaining',
        ask: 'How many more snapshot requests can this server make before hitting its budget? Answer with a number only.',
        expect: String(FIXTURE_CONSTANTS.t3.budget - FIXTURE_CONSTANTS.t3.used),
        match: 'exact',
      },
      {
        id: 'earliest',
        ask: 'What is the earliest date you could pin a run to? Answer with the date in YYYY-MM-DD form only.',
        expect: FIXTURE_CONSTANTS.t3.windowFrom,
        match: 'contains',
      },
    ],
  },
  {
    kind: 'model-as-user',
    id: 'C9-diff-usefulness',
    transitions: ['T4'],
    weight: 2,
    artifact: 'contracts/temporal-snapshot/fixtures/t4-diff.json',
    questions: [
      {
        id: 'before',
        ask: `What was the Pro plan's monthly price on ${FIXTURE_CONSTANTS.t4.url} in the earlier version? Answer with the price only.`,
        expect: FIXTURE_CONSTANTS.t4.before,
        match: 'contains',
      },
      {
        id: 'after',
        ask: 'And in the later version? Answer with the price only.',
        expect: FIXTURE_CONSTANTS.t4.after,
        match: 'contains',
      },
    ],
  },
  {
    kind: 'review',
    id: 'C10-operation-descriptions',
    transitions: ['T5'],
    weight: 1,
    question:
      'Are the new operation summaries, schemas and hints accurate against fixtures/exa-spec.json, and concise enough that a model searching the catalog picks the right operation?',
    anchors: REVIEW_ANCHORS(
      'Accurate and unambiguous; each operation is findable by the words a user would use.',
      'Inaccurate against the spec or indistinguishable from neighbors.',
    ),
  },
  {
    kind: 'review',
    id: 'C11-docs',
    transitions: ['T5'],
    weight: 1,
    question:
      'Do the docs describe the temporal cursor, its limits (5-month window, request cap, discovery is not historical) and the new operations coherently, without stale statements?',
    anchors: REVIEW_ANCHORS(
      'A newcomer could use pinned runs correctly from the docs alone.',
      'Docs are stale or contradict the code.',
    ),
  },
];
