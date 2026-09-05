# Websets Code Mode MCP

Docker-first HTTP MCP server for [Exa's Websets API](https://docs.exa.ai/reference/websets). Wraps the entire Websets surface (websets, items, monitors, imports, enrichments, webhooks) as a Code Mode interface — three MCP tools (`search`, `execute`, `status`) instead of one tool per operation. Includes a workflow registry for long-running operations and a webhook receiver for inbound Exa events.

The current runtime model is HTTP MCP behind Docker. Not a published npm package; non-Docker runtimes are future work and not designed yet.

## Current Shape

- MCP transport: HTTP at `/mcp`
- Primary runtime: Docker Compose
- Three MCP tools: `search`, `execute`, `status`
- Workflow registry exposed via `tasks.create` / `tasks.get` / `tasks.cancel` operations (`semantic.cron`, `research.deep`, `convergent.search`, `verify.enrichments`, several retrieval workflows, more — see [Workflows](#workflows))
- Webhook receiver at `/webhooks/exa` with per-webhook secret capture
- SQLite shadow store at `data/websets.db` (items, snapshots, webhook secrets, events)

## Quick Start

### Prerequisites

- Docker / Docker Compose
- `EXA_API_KEY` from a Websets-enabled Exa account

### Run

```bash
EXA_API_KEY=your-key docker compose up --build
```

The server listens on port `7860` by default.

### Connect an MCP Client

For Claude Code, copy the checked-in template (`.mcp.json` is gitignored):

```bash
cp .mcp.json.template .mcp.json
```

Claude Code picks it up on next launch in this directory. The server name
**must** be `websets-codemode-local` — the bundled workflows (e.g.
`source-candidates`) reference tools by that exact name; a differently-named
server will connect fine but the workflows will not find it. The template's
second entry (`websets-channel`, the webhook notification bridge) needs a local
`pnpm run build` first; if you skip that it shows as disconnected, which is
harmless — the recruiter workflow doesn't use it.

For other MCP clients:

```json
{
  "mcpServers": {
    "websets-codemode-local": {
      "type": "http",
      "url": "http://localhost:7860/mcp"
    }
  }
}
```

## Environment Variables

| Name | Required | Default | Purpose |
|------|----------|---------|---------|
| `EXA_API_KEY` | yes | — | Exa API key (Websets-enabled account) |
| `PORT` | no | `7860` | HTTP port |
| `WEBSETS_PUBLIC_URL` | no* | — | Public URL of this server. Workflows that auto-register webhooks (`semantic.cron`) use it to tell Exa where to deliver events. *Required if you want auto-registration. Leave unset to disable. |
| `EXA_WEBHOOK_SECRET` | no | — | Account-level fallback secret for inbound webhook signature verification. New deployments shouldn't need this; per-webhook secrets are captured automatically (see [Webhook Receiver](#webhook-receiver)). |
| `WEBSETS_DB_PATH` | no | `data/websets.db` | Path to the SQLite shadow store. |
| `MANAGE_WEBSETS_DEFAULT_COMPAT_MODE` | no | `strict` | Default arg-coercion mode (`strict` or `safe`). Per-call `args.compat.mode` overrides. |
| `GITHUB_TOKEN` | no | — | Used by GitHub-touching operations (`verify.enrichments` workflow, github handlers). Anonymous rate limits apply when unset. |
| `WEBSETS_CHANNEL_CONFIG` | no | `data/channel-config.json` | Path to the per-webset filter config consumed by the Claude Code channel bridge. |
| `WEBSETS_SERVER_URL` | no | `http://localhost:7860` | Used by the channel bridge to reach this server's SSE stream. |

## Tools

The server exposes three MCP tools.

### `search` — Discover operations

Find available API operations by keyword, domain, or pattern. Use before writing code for `execute`.

```json
{ "query": "create", "detail": "brief", "domain": "websets", "limit": 10 }
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Keyword, domain name, or description |
| `detail` | `"brief"` \| `"detailed"` \| `"full"` | `"detailed"` | Schema detail level |
| `domain` | string | — | Filter to a domain |
| `limit` | number | 10 | Max results |

### `execute` — Run code in sandbox

Execute JavaScript with `callOperation(name, args)` and an authenticated `exa` SDK client injected into a sandboxed VM.

```json
{
  "code": "const ws = await callOperation('websets.create', { searchQuery: 'AI startups', entity: { type: 'company' }, searchCount: 10 });\nawait callOperation('websets.waitUntilIdle', { id: ws.id });\nreturn await callOperation('items.getAll', { websetId: ws.id });",
  "timeout": 60000
}
```

Sandbox globals:
- `callOperation(name, args)` — dispatch to any registered operation
- `console.log` / `console.warn` / `console.error` — captured and returned with results

### `status` — Account overview

Returns current account state: webset counts by status, running tasks, active monitors, and server capabilities. Call this first to orient.

### Provider inputs and compact results

Custom entities require `{ type: "custom", description: "what to find" }` in Webset create/preview, search create, and import create. The same entity schema is used for all four operations.

`imports.create` accepts `format: "csv"` and optional `csv: { identifier: 1 }`, and preserves `uploadUrl` and `uploadValidUntil`. The host uploads the CSV to that URL before expiry, then inspects `imports.get` or waits with `imports.waitUntilCompleted`. Creating the import does not upload the file; this server supplies the handoff, with no separate upload service. See [Exa's import contract](https://exa.ai/docs/websets/api/imports/create-an-import).

`searches.*` responses retain the requested count, parent Webset ID, timestamps, and provider `recall` unchanged. Recall values are estimates. Webset responses preserve `dashboardUrl` (and `url` when supplied) and explicitly expanded `items`; expanded items are raw provider payloads with no implicit filtering. Compact items retain parent IDs, timestamps, evaluation values (including `unclear`), and enrichment statuses. Use `items.get` for full evidence, including reasoning and references.

Bulk reads (`items.list` and `items.getAll`) accept `evaluationPolicy`:

| Policy | Included rows |
|--------|---------------|
| `any` (default) | At least one `yes` evaluation |
| `all` | Every reported evaluation is `yes` |
| `none` | Every row, including negative and unclear evaluations |

Empty evaluations are included under every policy. `total`, `included`, and `excluded` describe the fetched rows, page-local for `items.list`. Provider `hasMore` and `nextCursor` remain independent of filtering: continue even when a page has zero matches. `items.getAll.maxItems` caps fetched rows before filtering.

## Workflows

Long-running operations are registered in a workflow registry and invoked through three operations:

```js
const t = await callOperation('tasks.create', { type: 'semantic.cron', args: { /* config */ } });
// poll
const result = await callOperation('tasks.get', { taskId: t.taskId });
// cancel
await callOperation('tasks.cancel', { taskId: t.taskId });
```

Tasks transition `pending` → `working` → `completed` / `failed` / `cancelled`. Terminal status, timestamps, and expiry are immutable, including after late workflow progress or completion. Cancellation records local task state; it does not confirm provider cancellation. `tasks.list` accepts `working`, with `running` retained as an input alias.

Each registered workflow has an authoritative argument schema used for discovery, parameter docs, and validation before task creation or provider dispatch. Nested `args` and flattened arguments remain supported. Use `search` with `domain: "workflow"` and `detail: "full"`, or its linked workflow resource, to inspect the contract. Domains are derived from the registry. JSON Schema preserves representable constraints; custom refinements remain runtime checks and are described in the workflow contract.

Registered workflows:

| Type | Purpose |
|------|---------|
| `semantic.cron` | Multi-lens substrate detector. Cross-lens entity correlation with composite signal evaluation. See below. |
| `semantic.cron.replay` | Re-emit signal-state events from a stored snapshot (e.g. when a subscriber reconnects). |
| `convergent.search` | Iterative web search converging toward a query target. |
| `research.deep` | Deep multi-step research workflow. |
| `retrieval.searchAndRead` | Search + fetch readable content. |
| `retrieval.expandAndCollect` | Expand a query and collect results. |
| `retrieval.verifiedAnswer` | Answer a question with verification against retrieved sources. |
| `verify.enrichments` | Verify enrichment values against external sources (uses `GITHUB_TOKEN` for GitHub-derived enrichments). |
| `lifecycle.harvest` | Harvest items + enrichments at the end of a webset's lifecycle. |
| `connect.enrich` | Attach external results only to uniquely matched input IDs; unmatched and duplicate output IDs are reported. |
| `thesis.investigate` | Record source-domain retrieval statistics and query results in a notebook. |
| `echo` | Trivial workflow used for harness testing. |

### `semantic.cron`

Multi-lens substrate detector. Creates N parallel websets ("lenses") observing different facets of the same underlying phenomenon, evaluates items against shape predicates on enrichment values, joins evidence across lenses by entity or temporal proximity, and fires a composite signal when configured cross-lens conditions are met.

Config shape (high level):

- `name` (recommended): used for snapshot persistence, delta computation, and replay. A run with no `name` skips persistence and warns at validate time.
- `lenses`: array of `{ id, source: { query, entity?, criteria?, enrichments?, count? } }`. Each lens becomes one webset.
- `shapes`: array of `{ lensId, conditions, logic }`. Predicates over enrichment values; items must pass at least one shape per lens to qualify.
- `join`: `{ by, minLensOverlap?, temporal?, entityMatch?, keyEnrichment? }`. Modes: `entity`, `entity+temporal`, `cooccurrence`, `temporal`. `entityMatch: { method: "exact" }` uses case-insensitive exact names or exact enrichment keys; URLs remain exact. Fuzzy mode uses Dice-coefficient name matching.
- `signal`: `{ requires: { type, min?, sufficient? } }`. Types: `all`, `any`, `threshold`, `combination`. Validate-time rejects degenerate combinations (e.g. 1-lens with type `all` is vacuous).
- `monitor` (optional): `{ cron, timezone }` to register an Exa-side cron schedule for auto-rerun.

On each run, the workflow persists a snapshot to SQLite (keyed by `config.name`) and emits state-transition events to the webhook event bus:

- `semantic-cron.signal-fired` — false→true, OR true→true with new entities ("substrate spread")
- `semantic-cron.signal-resolved` — true→false

`tasks.get` returns the snapshot at the end of the run. Re-evaluation runs (`existingWebsets` arg supplied) compute a delta against the previous snapshot.

Temporal conditions must qualify within one common inclusive window; memberships from separate windows cannot jointly satisfy a signal. Qualifying windows retain item IDs and timestamps as witnesses, and final entities are deduplicated. Missing or invalid timestamps cannot qualify. These timestamps are provider item-creation times, not proof of when a real-world event occurred.

### Thesis notebooks

`thesis.investigate` returns `retrievalBalance` (`thesis-heavy`, `antithesis-heavy`, `mixed`, or `sparse`), `retrievalScore`, `thesisQueryDomains`, `antithesisQueryDomains`, and `thesisQueryShare`. These are source-domain retrieval statistics, not factual verdicts or calibrated confidence. The score retains the previous arithmetic: `clamp((distinct domains / requested count) * abs(thesisQueryShare - 0.5) * 2, 0, 1)`.

New generated runs use `kind: "retrieval"` and query-side result lists. Legacy verdict/confidence runs remain readable and unchanged. The notebook index adds `latest_run_kind`, `latest_retrieval_balance`, and `latest_retrieval_score`; a latest retrieval run clears stale legacy latest-verdict/confidence values. `notebook.list` returns both kinds, while its optional `verdict` filter applies to latest legacy runs. The index upgrade is additive and preserves historical run files.

## Webhook Receiver

This section is operator-grade. Skip if you only want to consume the MCP surface.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/webhooks/exa` | Accepts Exa-signed event payloads. Verifies `Exa-Signature` against any locally stored secret. |
| `GET` | `/webhooks/events` | SSE stream of received events. **Currently consumed only by the Claude Code channel bridge** (see below). |
| `GET` | `/webhooks/status` | Receiver health: SSE subscriber count, env-secret configured, stored secrets count, signature-verification enabled flag. |
| `GET` | `/health` | Liveness probe (used by Docker / k8s healthchecks). |

### Signing & Per-Webhook Secret Capture

Exa returns the signing secret for a webhook **only once**, at the moment of `webhooks.create`. This server captures it server-side and persists to a `webhook_secrets` SQLite table on every successful create — both via the MCP `webhooks.create` operation and via the auto-create path inside `semantic.cron`. The secret is never returned to the model (the projection at `src/lib/projections.ts` strips it).

On each incoming POST to `/webhooks/exa`, the receiver:

1. Loads every row from `webhook_secrets` plus the optional `EXA_WEBHOOK_SECRET` env-var fallback
2. Tries each candidate against the request's `Exa-Signature` header (HMAC-SHA256 over `${timestamp}.${rawBody}` with a 5-minute timestamp tolerance)
3. Accepts if any matches; rejects 401 with a loud log otherwise
4. If zero secrets are known anywhere (no env var, no stored rows), accepts unsigned payloads with a boot-time warning. As soon as any webhook is registered, signature verification becomes mandatory.

`webhooks.delete` clears the corresponding stored secret. Pre-existing webhooks created before secret-capture was added are orphans — their incoming events will 401 since their secret was never captured. Delete them via `webhooks.delete` and re-create.

### Event Delivery

The receiver currently has **one opinionated downstream consumer: the Claude Code channel bridge** at `src/channel.ts`. The bridge is a separate stdio MCP process that long-polls `GET /webhooks/events`, dedupes by event id (60s window), coalesces per-item notifications after a quiet interval (60s by default; `CHANNEL_ITEM_COALESCE_MS` overrides it), filters by `data/channel-config.json`, and emits `notifications/claude/channel` notifications into a connected Claude Code session.

Item events carry server-resolved `expectedEnrichmentIds`. `webset.item.ready` requires valid item identity and evaluations, no `no` evaluation, and a `completed` result for every expected enrichment ID. `unclear` remains eligible for later verification. Failed lookups, missing definitions, pending/failed results, and incomplete payloads do not become ready; confirmed empty definitions require no enrichment work. Explicitly enabled raw `webset.item.created`/`webset.item.enriched` events remain available when readiness fails. A quiet interval describes the latest observed state and does not make it immutable.

**For non-Claude-Code consumers** (DeepAgents, custom MCP clients, anything connected at `/mcp`):

- The MCP transport at `/mcp` does not push notifications down to clients. Workflow output reaches the client through the `tasks.create` → `tasks.get` polling loop synchronously.
- Subscribing to `GET /webhooks/events` over SSE works as a parallel side channel, but it is unauthenticated. Don't expose it publicly.
- There is no built-in webhook-out fan-out (e.g. forwarding events to a third party's URL). Write your own SSE consumer if needed.

### Smoke Tests

Two scripts under `scripts/` exercise the receive path end-to-end:

- `scripts/webhook-smoke.mjs` — in-process: boots the server, plants a test secret, fires correctly-signed / unsigned / wrong-secret POSTs, asserts 200 / 401 / 401.
- `scripts/webhook-smoke-http.mjs` — HTTP-only: assumes the server is already running and a known secret is seeded.

## Local Development

This repo uses **pnpm** via Corepack (`packageManager: "pnpm@10.32.1"` in `package.json`). npm will not produce a working install.

```bash
pnpm install
pnpm run build
pnpm start
```

For iterative development, Docker remains the primary runtime. Local Node is for fast feedback while editing the server itself.

To verify the bounded correctness contracts without provider access:

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run --exclude '**/{integration,e2e}/**'
docker build -t websets-correctness .
docker run --rm --network none --tmpfs /app/data \
  -v "$PWD/scripts/correctness-smoke.mjs:/app/scripts/correctness-smoke.mjs:ro" \
  websets-correctness node /app/scripts/correctness-smoke.mjs
```

The smoke test boots the built production entry point, connects over HTTP/MCP, and replaces provider HTTP responses with deterministic fixtures. SQLite and notebooks use temporary container storage. It exercises discovery, the published example, provider-field preservation, filtering/pagination, and mixed notebook histories.

## Compatibility Mode

`MANAGE_WEBSETS_DEFAULT_COMPAT_MODE` controls the default argument coercion mode:

- `strict` (default) — reject malformed args
- `safe` — coerce common shape mistakes (e.g. string `criteria` → `[{description: "..."}]`)

Per-call `args.compat.mode` overrides the server default.

## Validation Footguns

- `criteria` must be objects: `[{"description":"..."}]`
- `entity` must be an object: `{"type":"company"}`
- `options` must be objects: `[{"label":"..."}]`
- `cron` must use 5 fields (no seconds, no year)

## Useful Commands

```bash
pnpm test                  # full suite
pnpm run test:integration  # handlers/integration/
pnpm run test:e2e          # __tests__/e2e/
pnpm run test:workflows    # workflows/__tests__/
pnpm run docker:up         # docker compose up --build
pnpm run docker:down       # docker compose down
```

## Resources

- [Exa Websets Documentation](https://docs.exa.ai/reference/websets)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
