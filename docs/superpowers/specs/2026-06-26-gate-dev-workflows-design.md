# Gate dev/demo event-injection workflows out of the production surface

**Issue:** [#41](https://github.com/Kastalien-Research/websets-mcp-codemode/issues/41) — dev/demo event-injection workflows are registered in the production workflow surface.

## Problem

`webhook.inject` (`src/workflows/webhookInject.ts`) and `semantic.cron.replay`
(`src/workflows/semanticCron.ts`) inject/replay synthetic webhook events. The
injected event flows through `webhookEventBus.publish()` exactly like a real
webhook: persisted, item events upsert into the shadow store and run receiver rules
(candidate emission), and broadcast over SSE to channel bridges. Only *detection* is
synthetic; ingestion + action run live. Both are registered into the normal
`tasks.create` workflow surface with no environment gate, so in production an agent
could inject fake events indistinguishable from real ones downstream.

## Design

Gate registration behind an explicit flag. Scope is gating only; tagging events
with `synthetic: true` is a deliberate non-goal (larger change to the event bus,
persistence, and SSE consumers — a separate issue). With gating, the dev workflows
do not exist in production, so synthetic injection is impossible there.

- **`src/workflows/types.ts`**: add `devWorkflowsEnabled()` (true iff
  `WEBSETS_ENABLE_DEV_WORKFLOWS === '1'`) and `registerDevWorkflow(type, fn, meta)`
  which no-ops unless enabled. The flag is read at registration (import) time.
- **`webhookInject.ts`**: register `webhook.inject` via `registerDevWorkflow`.
- **`semanticCron.ts`**: register `semantic.cron.replay` via `registerDevWorkflow`;
  the real `semantic.cron` stays on `registerWorkflow`.
- **`index.ts`**: when `devWorkflowsEnabled()`, `console.warn` an operator notice
  that synthetic-injection workflows are active and must not be enabled in production.

When gated off (default), the workflows are absent from `workflowRegistry` and
`workflowMetadata`, so `tasks.create` returns "Unknown task type" and they do not
appear in the catalog, `search` tool, or MCP workflow discovery.

## Tests

New `src/workflows/__tests__/devWorkflows.test.ts` (vitest):

- `registerDevWorkflow` registers when `WEBSETS_ENABLE_DEV_WORKFLOWS=1`.
- skips when the flag is unset.
- skips for values other than `"1"` (e.g. `"true"`).
- integration: importing the workflows barrel registers `semantic.cron` but **not**
  `webhook.inject` / `semantic.cron.replay` (flag unset by default).

Runtime verification via the MCP `execute` tool (`callOperation('tasks.create', …)`):
- default boot → both dev types rejected as "Unknown task type"; `semantic.cron`
  accepted.
- `WEBSETS_ENABLE_DEV_WORKFLOWS=1` boot → startup warning logged; both dev types
  accepted and present in discovery.

## Scope

- Changed: `src/workflows/types.ts`, `src/workflows/webhookInject.ts`,
  `src/workflows/semanticCron.ts`, `src/index.ts`.
- Added: `src/workflows/__tests__/devWorkflows.test.ts`.
- Non-goal: `synthetic: true` event tagging.
- Pre-existing unrelated failures in
  `src/handlers/__tests__/integration/errors/type-format.test.ts` are out of scope.
