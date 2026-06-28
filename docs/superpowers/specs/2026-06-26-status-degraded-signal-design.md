# Status tool: surface degradation instead of masking it

**Issue:** [#39](https://github.com/Kastalien-Research/websets-mcp-codemode/issues/39) — `status` tool silently reports zero websets/monitors when Exa is unavailable.

## Problem

`getAccountStatus` (`src/tools/statusTool.ts`) races `exa.websets.list()` +
`exa.websets.monitors.list()` against a 3s timeout. On timeout or any error, the
`catch` block leaves `websetsData` at its default `{ count: 0, hasMore: false,
by_status: {}, recent: [] }` and `monitorsActive` at `0`, with no signal that the
live calls failed. The returned status is indistinguishable from a real, empty
account. An agent calling `status` during a transient Exa outage may conclude the
account is empty and act on false state. This violates the project's fail-fast /
"never swallow exceptions silently" standard.

A secondary defect: the current `Promise.race([Promise.allSettled([...]), timeout])`
discards partial results. `allSettled` only resolves once both calls settle, so if
websets resolves at 1s but monitors hangs, the 3s timeout rejects the whole race and
the websets result is lost too.

## Design

### Response shape (`AccountStatus`)

A failed live section becomes `null` (so `count: 0` never lies), plus a top-level
rollup for quick triage and the failure reason.

```ts
export interface AccountStatus {
  degraded: boolean;                      // NEW — true iff any live section failed
  errors: string[];                       // NEW — sanitized "<section>: <reason>", [] when healthy
  websets: WebsetsSummary | null;         // null when its live call failed
  tasks: {                                // unchanged — in-memory, never null
    running: number;
    active: Array<{ taskId: string; type: string }>;
    recent_errors: Array<{ taskId: string; step: string; message: string }>;
  };
  monitors: { active: number } | null;    // null when its live call failed
  capabilities: { ... };                  // unchanged
  timestamp: string;
}
```

Invariants:
- `degraded === (errors.length > 0)`, i.e. true iff at least one live section is `null`.
- `degraded` and `errors` are always present (`degraded: false`, `errors: []` on success)
  so the shape is stable for consumers.
- `tasks` is sourced from `taskStore.list()` (in-memory, reliable), is never `null`,
  and never contributes to `degraded`.

### Behavior (`getAccountStatus`)

1. **Per-call isolation.** Replace the single shared race with each Exa call wrapped
   in its own 3s timeout via a small `withTimeout(promise, ms, label)` helper. This
   lets websets succeed while monitors degrades independently.
2. A call that resolves → populate that section as today.
3. A call that rejects/times out → set that section to `null`, push a sanitized
   `"<section>: <reason>"` string into `errors`.
4. **Caching:** only cache when `!degraded`. Degraded results are returned but not
   cached, so the next call retries and recovers immediately when Exa is back. The
   10s TTL constant is unchanged.
5. **Error sanitization:** error strings carry the failure category
   (`"timed out after 3s"`, or a generic message for other errors) — never raw API
   payloads or anything key-bearing, consistent with the existing `recent_errors`
   sanitization.

### Tool description

Add one line to the `status` tool `DESCRIPTION` noting that `degraded`/`errors`
signal when live Exa data is unavailable, so agents know to check it.

## Tests

New file `src/tools/__tests__/statusTool.test.ts` (vitest), mocking the `Exa`
client's `websets.list` and `websets.monitors.list`:

- **both succeed** → `degraded: false`, `errors: []`, sections populated.
- **empty-but-healthy** → `websets.count: 0` **with** `degraded: false` (the case
  currently indistinguishable from failure).
- **both time out** → `degraded: true`, `websets: null`, `monitors: null`, two
  `errors`, `tasks` still present.
- **websets ok, monitors times out** → `degraded: true`, `websets` populated,
  `monitors: null`, one error (proves per-call isolation).
- **thrown non-timeout error** → section `null`, sanitized error string, no raw
  payload leakage.
- **caching** → a healthy result is cached (mock called once across two calls); a
  degraded result is not cached (mock re-invoked on the second call).

## Scope

- Changed: `src/tools/statusTool.ts` + new `src/tools/__tests__/statusTool.test.ts`.
- No changes to `server.ts`, operations, or other tools.
- Pre-existing failures in
  `src/handlers/__tests__/integration/errors/type-format.test.ts` are unrelated and
  out of scope.
