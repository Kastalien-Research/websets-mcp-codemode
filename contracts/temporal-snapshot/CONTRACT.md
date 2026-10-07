# Contract: temporal-snapshot (v1)

<!-- Generated from contract.ts by `run.ts render`. Do not edit by hand (invariant G5). -->

This contract takes the server from S0 (today) to S5 (terminal) through five transitions.
Invariants are hard boundaries decided by deterministic code; criteria are soft, judged by
an isolated Claude Agent SDK judge, recorded in the ledger, and never block a transition.

## How state is decided

- The current state is computed, never declared: S0 holds when every global invariant passes;
  Sk holds when S0 holds and every invariant of S1..Sk passes.
- Invariants ratchet: once required, they stay required in every later state.
- A missing or crashing check counts as a failure.
- Advances run in a fresh worktree of a committed HEAD and are recorded in the append-only
  `ledger.jsonl`, together with the contract hash that judged them.

## Global invariants (every state)

| ID | Statement | Checked by |
|---|---|---|
| G1 | The project MUST typecheck: `tsc --noEmit` exits 0. | Runs `tsc --noEmit -p tsconfig.json` in the verified checkout. |
| G2 | The offline test suite (every vitest file except `src/__tests__/e2e/**` and `**/integration/**`) MUST report zero failures, and its passed count MUST be at least the S0 baseline minus the baseline tests of files the contract allows to be deleted. | Runs vitest with the contract harness config (forked-process pool) and a JSON reporter, then compares counts with fixtures/baseline.json. A run that dies without writing a report is retried at most twice and fails if it never completes; test failures are never retried. |
| G3 | The offline test suite MUST make zero outbound requests to non-loopback hosts (no live Exa spend from tests). | A vitest setup file replaces global fetch before any module loads, blocks non-loopback hosts and logs each attempt; the suite must have completed and the log must be empty. |
| G4 | The operation registry MUST contain every S0 operation except the allowed removals (`research.*`). | Imports OPERATIONS and diffs its keys against fixtures/baseline.json. |
| G5 | CONTRACT.md MUST be byte-identical to the rendering of contract.ts, and the contract MUST be well-formed: unique ids, at least one invariant in every state after S0, and transitions that chain S0 to the terminal state one step at a time. | Renders contract.ts and compares it with the committed CONTRACT.md, then checks ids, state invariant counts and the transition chain. |

Allowed removals: `research.create`, `research.get`, `research.list`, `research.pollUntilFinished`.

## Process invariants (across transitions)

| ID | Statement | Checked by |
|---|---|---|
| P1 | The contract MUST be locked before any transition, and the hash of the contract files at HEAD MUST equal the latest lock or amendment hash in the ledger. | Hashes CONTRACT_FILES at HEAD and compares with the last `lock`/`amend` ledger entry. |
| P2 | Transitions MUST advance one state at a time, in order: advancing to Sk requires the last recorded state to be S(k-1). | Reads `advance` entries from the ledger. |
| P3 | Checks come before code: a `check-lock` entry MUST pin the hash of the target state's check file before any commit of the transition touches files outside the contract directory, and at every advance each check file ever pinned (earlier states included) MUST still match its latest pin; re-pins are allowed and recorded. | Walks commits between the transition base and HEAD; compares every pinned check file at HEAD with its latest `check-lock`. |
| P4 | Frame condition: every file changed between the transition base and HEAD MUST match the transition scope or the always-allowed set. | `git diff --name-only base..HEAD`, matched against globs. |
| P5 | The ledger MUST be append-only: every committed revision of the ledger extends the previous one. | Walks `git log -- ledger.jsonl` up to HEAD and prefix-compares consecutive revisions. |
| P6 | Advance verdicts MUST come from a fresh worktree of a committed HEAD, with a clean working tree and no Exa or Anthropic credentials in the verifier environment. | The orchestrator refuses to advance on a dirty tree, creates the worktree itself, and launches the verifier with an allowlisted environment. |
| P7 | Live Snapshot requests made by contract tooling MUST total at most 10 over the whole process (from S3, the server's own spend ledger counts too). | Sums `spend` entries in the ledger (plus the S3 spend table once it exists). |

Live Snapshot spend limit for contract tooling: 10 requests.

## States

### S0: Baseline

The repository as locked: build and offline suite green, `snapshotAsOf` silently dropped by the Exa schemas, `research.*` still registered.

### S1: Strict surface

Nothing a caller sends is dropped without an error.

| ID | Statement | Checked by |
|---|---|---|
| S1.1 | For every registered operation, a call carrying an unknown top-level key MUST be rejected before any handler runs, and the error text MUST name that key. | Dispatches every operation with a probe key in compat preview mode against a client that records calls; each must return isError naming the key, with zero calls. |
| S1.2 | No object schema reachable from any operation schema MAY use zod's default `strip` mode; each MUST be `strict` or `passthrough`. | Walks every operation schema through wrappers, unions, arrays and records. |
| S1.3 | `snapshotAsOf` MUST NOT be silently dropped by `exa.search` (inside `contents`) or `exa.getContents` (top level, both the urls and the ids path): each call either fails with an error naming it or forwards it unchanged in the outgoing request. | Runs the real handlers against a recording client and inspects the recorded request. |

### S2: Temporal cursor

A run can be pinned to an instant. Pinning is enforced at the client boundary, so no handler or workflow can reach the live web from a pinned run.

| ID | Statement | Checked by |
|---|---|---|
| S2.1 | The `execute` tool MUST accept an optional `asOf` (ISO 8601 date or date-time) and MUST reject malformed values, instants in the future, and instants older than the documented 5-month Snapshot window. | Probes the registered input schema and the asOf parser with an injected clock. |
| S2.2 | In a pinned run, every operation not in `PINNABLE_OPERATIONS` MUST fail with a `TEMPORAL_BOUNDARY` error before validation and before any Exa call. | Dispatches every non-pinnable operation under `asOf` against a recording client; zero calls, tagged error. |
| S2.3 | In a pinned run, handlers and workflows MUST receive only a pinned client: every client method outside the pinnable set MUST throw `TEMPORAL_BOUNDARY`, and `new Exa(` MUST appear only in CLIENT_BOOTSTRAP_FILES. | Calls each known SDK method path on the pinned client over a recording client; greps non-test files in `src/` for client construction. |
| S2.4 | Pinned `exa.search` and `exa.getContents` requests MUST carry `snapshotAsOf` no later than `asOf` (injected when absent); a per-call `snapshotAsOf` later than `asOf` MUST be rejected with zero calls. | Recording client under `asOf`, with and without per-call values on both sides of the ceiling. |
| S2.5 | Any request carrying a snapshot MUST be rejected with zero calls when it also sets `livecrawl`, `livecrawlTimeout`, `maxAgeHours` or `subpages`, or, on search, a deep `type`, a `category` or streaming. | One probe per forbidden field, pinned and per-call. |
| S2.6 | Responses under a snapshot MUST be checked with every field the API provides: a `snapshotAt` later than the effective `snapshotAsOf` (or unparseable), or a contents status reporting a `source` other than `cached`, MUST turn the call into a `TEMPORAL_LEAK` error that returns none of the offending content. Results without `snapshotAt` MUST be labeled as bounded by the provider's guarantee, not as verified. | Recording client returns crafted late, unparseable, live-sourced and missing `snapshotAt` results; leaks must be tagged errors without the content, and unverifiable results must carry the provider-guaranteed label. |
| S2.7 | A pinned `execute` response MUST carry `asOf` at its top level, and every search or contents response under a snapshot MUST carry a `temporal` block stating the bound and how it was verified; search responses MUST also state that discovery used current ranking. | Runs `execute` in-process under `asOf` with a recording client and inspects the envelope and the temporal blocks. |
| S2.8 | Without `asOf` and without a per-call `snapshotAsOf`, outgoing requests MUST NOT contain `snapshotAsOf`. | Recording client, live mode. |
| S2.9 | Recorded live responses of one pinned search and one pinned contents call (at most 2 sanctioned requests) MUST exist, and replaying them through the pinned path MUST succeed without a false `TEMPORAL_LEAK`, carrying the verification label their fields justify. | Reads fixtures/t2-live-probe-{search,contents}.json, matches each requestId to a `spend` ledger entry, and replays both through a recording client. |

### S3: Page history

Every version the workspace has seen is kept locally, re-reads are free when provably correct, and the quota is visible.

| ID | Statement | Checked by |
|---|---|---|
| S3.1 | Every snapshot response MUST be persisted as page versions keyed by (url, snapshotAt) with a content hash, and for every stored row sha256(content) MUST equal the stored hash. | Runs pinned reads against a recording client into a temp store, then rehashes every row. |
| S3.2 | With an immutable upstream history, a pinned read MUST return exactly the newest version at or before `asOf`, and MUST call upstream if and only if `asOf` falls outside every recorded interval [snapshotAt, requestedAsOf] for that URL. | Property check over seeded random version timelines and request sequences. |
| S3.3 | A served version MUST never have `snapshotAt` later than the requested instant, including after upstream history is backfilled. | Property check with backfill events injected between requests. |
| S3.4 | Each upstream request carrying `snapshotAsOf` MUST increment the local spend ledger by exactly 1, and cache hits MUST NOT increment it. | Compares recorded upstream calls with the ledger delta over the S3.2 sequences. |
| S3.5 | When the local spend count reaches `SNAPSHOT_BUDGET` (default 100), uncached pinned requests MUST fail with `TEMPORAL_BUDGET` and zero upstream calls, while cached reads still succeed. | Seeds the ledger at the budget and probes cached and uncached reads. |
| S3.6 | The `status` tool MUST report snapshot `used`, `budget` and the valid window `{from, to}`, with `used` equal to the ledger count. | Calls the status builder in-process against a seeded store. |

### S4: Backtest and compare

Whole workflows can run in the past, the local store respects the cursor, and versions can be compared.

| ID | Statement | Checked by |
|---|---|---|
| S4.1 | `snapshot.diff({url, from, to})` MUST return no changes when both sides resolve to the same version, MUST include the changed line of each fixture pair, MUST reject `from` later than `to`, and MUST refuse `to: "live"` in a pinned run. | Fixture version pairs through a recording client. |
| S4.2 | `tasks.create` MUST accept `asOf`, and every registered workflow type run under it MUST make zero unpinned Exa calls, failing with `TEMPORAL_BOUNDARY` where it needs a capability that cannot be pinned. | Runs each workflow type under `asOf` with a recording client underneath the pinned client. |
| S4.3 | Store reads admitted to `PINNABLE_OPERATIONS` MUST return only records created at or before `asOf`. | Seeds records on both sides of `asOf` and reads them pinned. |
| S4.4 | Verdict evidence MUST round-trip `(url, snapshotAt, contentHash)` tuples unchanged through the store. | Write then read through the store operations. |

### S5: Gap closure (terminal)

The rest of the Exa API is covered, retired surface is gone, and the docs match.

| ID | Statement | Checked by |
|---|---|---|
| S5.1 | Every operationId in the pinned Exa OpenAPI spec MUST map to a registered operation; the team-management read endpoints (list, get, usage) MUST be mapped and its write endpoints MUST NOT. | Joins fixtures/exa-spec.json and fixtures/team-management-spec.yaml with SPEC_OPERATION_MAP. |
| S5.2 | For the core endpoints (search, contents, answer, findSimilar, agent runs, batches, search monitors), every top-level schema key MUST exist in the spec request (body, path or query) or in the declared local extensions. | Compares schema keys with spec request properties plus LOCAL_EXTENSIONS. |
| S5.3 | `exa.search` category values MUST equal the spec enum; `agentRuns.create` effort values MUST equal the spec `AgentEffort` enum, and `budget` MUST accept the spec `AgentBudget` fields. | Set equality between zod enums and spec enums. |
| S5.4 | `research.*` operations, their handler, and `startCrawlDate`/`endCrawlDate` MUST be gone from the registry, the catalog and every schema. | Registry, catalog and schema walk. |
| S5.5 | Requests with `highlights.dynamic: true` MUST carry the header `Exa-Beta: dynamic-highlights-2026-08-28`. | Captures outgoing headers through a stubbed fetch. |
| S5.6 | The `search` tool catalog MUST list exactly the registered operations, plus workflows. | Set comparison between the catalog and OPERATIONS. |
| S5.7 | Documented operation counts MUST match the registry, and no document MAY reference a removed operation. | Greps CLAUDE.md, README.md and docs/ for counts and removed names. |
| S5.8 | `docker compose build` MUST succeed. | Runs the build; an unavailable Docker daemon counts as a failure. |

## Transitions

| ID | From | To | May change |
|---|---|---|---|
| T1 | S0 | S1 | `src/handlers/**`, `src/tools/**`, `src/workflows/**` |
| T2 | S1 | S2 | `src/temporal/**`, `src/handlers/**`, `src/tools/**`, `src/workflows/**`, `src/server.ts`, `src/index.ts`, `src/lib/exa.ts`, `vitest.config.ts` |
| T3 | S2 | S3 | `src/temporal/**`, `src/store/**`, `src/handlers/**`, `src/tools/**`, `src/server.ts` |
| T4 | S3 | S4 | `src/temporal/**`, `src/store/**`, `src/handlers/**`, `src/workflows/**`, `src/tools/**` |
| T5 | S4 | S5 | `src/handlers/**`, `src/tools/**`, `src/workflows/**`, `src/lib/**`, `src/server.ts`, `CLAUDE.md`, `README.md`, `TOOL_SCHEMAS.md`, `WORKFLOWS.md`, `EXAMPLES.md`, `QUICKSTART.md`, `AGENTS.md`, `docs/**` |

Every transition may also change: `contracts/temporal-snapshot/**`, `**/__tests__/**`, `CHANGELOG.md`.

## Soft criteria (advisory)

| ID | Applies to | Weight | Kind | What is judged |
|---|---|---|---|---|
| C1-idiom | every transition | 1 | review | Does the new and changed code read like the code around it: naming, comment density, error handling through successResult/errorResult, schema style, module layout? |
| C2-minimality | every transition | 1 | review | Is this the smallest change that reaches the target state? Look for speculative abstraction, options nobody uses, unrelated edits, and code that a deletion would not miss. |
| C3-check-fidelity | every transition | 2 | review | For each invariant of the target state, does its deterministic check (in contracts/temporal-snapshot/invariants/) test what the statement says, including the negative cases, rather than a weaker or happy-path-only property? Cite the statement and the check line for every gap. |
| C4-test-quality | every transition | 1 | review | Do the new tests pin behavior rather than implementation details, and would each failure message tell a reader what broke? |
| C5-rejection-usefulness | T1 | 1 | review | From the error text alone, could a model that sent a wrong key fix its call? Consider whether the error names the key, points at the valid keys or the nearest match, and stays short. |
| C6-refusal-usefulness | T2 | 1 | review | When a pinned run refuses an operation or a parameter, does the message say why it cannot be pinned and what to do instead (a pinnable alternative, or leaving pinned mode)? |
| C7-pinned-legibility | T2 | 2 | model-as-user | A fresh model sees only `contracts/temporal-snapshot/fixtures/t2-pinned-response.json` and answers: "Up to which instant is the page content in this response guaranteed to be bounded? Answer with the ISO 8601 instant only." "Could the choice and order of these search results have been influenced by information from after that instant? Answer yes or no." "Did the tool itself verify when each page version was crawled, or does the time bound rest on the data provider's guarantee? Answer with one word: verified or provider." |
| C8-status-legibility | T3 | 1 | model-as-user | A fresh model sees only `contracts/temporal-snapshot/fixtures/t3-status.json` and answers: "How many more snapshot requests can this server make before hitting its budget? Answer with a number only." "What is the earliest date you could pin a run to? Answer with the date in YYYY-MM-DD form only." |
| C9-diff-usefulness | T4 | 2 | model-as-user | A fresh model sees only `contracts/temporal-snapshot/fixtures/t4-diff.json` and answers: "What was the Pro plan's monthly price on https://example.com/pricing in the earlier version? Answer with the price only." "And in the later version? Answer with the price only." |
| C10-operation-descriptions | T5 | 1 | review | Are the new operation summaries, schemas and hints accurate against fixtures/exa-spec.json, and concise enough that a model searching the catalog picks the right operation? |
| C11-docs | T5 | 1 | review | Do the docs describe the temporal cursor, its limits (5-month window, request cap, discovery is not historical) and the new operations coherently, without stale statements? |
