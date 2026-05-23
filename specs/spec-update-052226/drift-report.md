# Exa API Spec Drift Report — 2026-05-22

Audit of `specs/exa-api/exa-public-api.yaml` (18,279 lines, OpenAPI 3) against the current MCP server surface in `src/handlers/**` and the `OPERATIONS` registry in `src/tools/operations.ts`.

Method: five parallel domain-scoped audits (websets+searches+items, enrichments+webhooks+events, monitors, imports+research+teams+agentRuns, exa-core-search). Each compared spec paths, request/response schemas, enum values, and SDK call sites against the handler implementations.

---

## TL;DR

- **Two entire API surfaces are missing**: top-level Search Monitors (`/monitors/*`) and Agent Runs (`/agent/runs/*`, beta).
- **One new convenience endpoint missing**: `GET /v0/teams/me`.
- **One silent rename**: `websets.create` field `name` → spec `title`. Callers' renames are dropped on the floor.
- **`exa.search` type enum is badly stale**: handler exposes `neural`/`keyword`/`hybrid` (not in spec); spec adds `instant`/`deep-lite`/`deep-reasoning`.
- **`projectEvent` strips the `data` payload** — events through the channel bridge carry no entity content, breaking dispatch routing that needs to inspect items.
- **Local `tasks.*` collides conceptually with `/agent/runs`** — if we add Agent Runs, name them `agentRuns.*`.

---

## 1. Missing endpoints (zero server coverage)

### 1A. Top-level Search Monitors — `/monitors/*` (HIGH)

Distinct product from `/v0/monitors` Webset Monitors. Standalone scheduled searches with webhook delivery + semantic deduplication. SDK already exposes them as `exa.monitors.*`.

| Method | Path | SDK | Severity |
|---|---|---|---|
| POST | `/monitors` | `exa.monitors.create` | high |
| GET | `/monitors` | `exa.monitors.list` | high |
| GET | `/monitors/{id}` | `exa.monitors.get` | high |
| PATCH | `/monitors/{id}` | `exa.monitors.update` | high |
| DELETE | `/monitors/{id}` | `exa.monitors.delete` | high |
| POST | `/monitors/{id}/trigger` | `exa.monitors.trigger` | high (smallest wrap) |
| GET | `/monitors/{id}/runs` | `exa.monitors.runs.list` | high |
| GET | `/monitors/{id}/runs/{runId}` | `exa.monitors.runs.get` | high |
| POST | `/monitors/batch` | — (raw HTTP) | medium |

The two monitor APIs are entirely separate products. `/v0/monitors` requires a `websetId`; `/monitors` is webset-independent with its own cadence + trigger config. SDK wiring confirms the split: `SearchMonitorsClient` (`exa.monitors.*`) routes to `/monitors{endpoint}`, `WebsetMonitorsClient` (`exa.websets.monitors.*`) routes to `/v0/monitors`. Server handler only uses the latter.

### 1B. Agent Runs — `/agent/runs/*` (HIGH, beta)

Async agent runs. Requires `Exa-Beta: agent-2026-05-07` header on every call.

| Method | Path | Capability | Severity |
|---|---|---|---|
| POST | `/agent/runs` | Create run; supports SSE via `Accept: text/event-stream` | high |
| GET | `/agent/runs` | List with cursor pagination | high |
| GET | `/agent/runs/{id}` | Retrieve single run | high |
| DELETE | `/agent/runs/{id}` | Delete a stored run | medium |
| POST | `/agent/runs/{id}/cancel` | Cancel queued/running; idempotent when terminal | high |
| GET | `/agent/runs/{id}/events` | List or SSE-replay stored events; `Last-Event-ID` resume | high |

**Naming collision risk**: server's existing `tasks.*` operations are local in-process workflow tracking (TaskStore, workflowRegistry) — entirely unrelated to Exa Agent Runs despite the similar verb set (create/get/list/cancel). New handlers must be named distinctly, e.g. `agentRuns.*`.

### 1C. Teams — `/v0/teams/me` (MEDIUM)

`GET /v0/teams/me` returns the authenticated team plus current concurrency usage and limits. Useful for quota-aware orchestration. No handler exists. Base URL per spec server override on the imports block: `https://api.exa.ai/websets`.

---

## 2. High-severity schema drift on existing ops

| Op | Drift | Spec | Handler |
|---|---|---|---|
| `websets.create` | Handler uses `name`; spec field is `title`. Renames sent through MCP are silently unrecognized. | yaml:14729 | `src/handlers/websets.ts:8` |
| `exa.search` | `type` enum: handler has `neural`/`keyword`/`hybrid` (not in spec); spec defines `instant`/`fast`/`auto`/`deep-lite`/`deep`/`deep-reasoning`. Handler is missing `instant`/`deep-lite`/`deep-reasoning`. | yaml:4890-4905 | `src/handlers/exa.ts:8` |
| `exa.getContents` | Missing `ids` field (refetch contents from prior search by document ID — the idiomatic flow). Also models `text`/`highlights`/`summary` only as booleans; spec accepts rich objects with `maxCharacters`/`query`. | yaml:5385-5484 | `src/handlers/exa.ts:49-61` |
| `projectEvent` | Strips the spec's `data` payload. Events through the channel bridge carry only `{id, type, createdAt}` — no entity content. Breaks dispatch routing that reads item/enrichment data. | yaml:3686 | `src/lib/projections.ts:234` |

---

## 3. Medium-severity drift

### Websets / Searches / Items

| Op | Drift |
|---|---|
| `websets.create` | Missing top-level `import` (import existing websets/imports), top-level `exclude`, plus `search.scope` (graph/import filter), `search.exclude`, `search.maxPeoplePerCompany`, `search.recall`. |
| `websets.update` | Only passes `metadata`; spec `UpdateWebsetRequest` also accepts `title`. Callers cannot rename. |
| `websets.list` | Missing `search` query param (minLength 2, maxLength 50) — filter by ID/external ID/title. |
| `websets.preview` | Spec requires top-level `search` object containing `query` (required); handler exposes flat fields and re-wraps. |
| `searches.create` | Missing `scope`, `exclude`, `maxPeoplePerCompany`. Marks `count` optional but spec requires it. |

### Enrichments / Webhooks / Events

| Op | Drift |
|---|---|
| `projectEnrichment` | Strips `title`, `websetId`, `instructions`, `options`, timestamps. Callers cannot verify active options after create. |
| `events.list` | Missing `createdBefore` / `createdAfter` (date-time) filter params. |
| `webhooks.create` | `events` typed as `z.array(z.string())` — no enum validation; spec enumerates 19 `EventType` values. |
| `projectWebhookAttempt` | Strips `id`, `createdAt`, and request/response body fields — can't correlate attempts or inspect delivery payloads. |

### Monitors (v0)

| Op | Drift |
|---|---|
| `monitors.list` | Hits `/v0/monitors`; spec's top-level `/monitors` adds `name`/`metadata`/`status` filters this op cannot access. (Note: this is partly a "wrong API" issue, captured in §1A.) |

### Exa Core Search

| Op | Drift |
|---|---|
| `exa.search` | `additionalQueries` capped at 5; spec max is 10. Missing `stream`/`compliance` fields. Category enum has stale `pdf`/`github`/`tweet` and is missing the spec's set: `company`/`research paper`/`news`/`personal site`/`financial report`/`people`. |
| `exa.search` | Exposes `useAutoprompt`, `includeText`, `excludeText` — none in spec's `SearchRequest`. Likely legacy SDK-only. |
| `exa.answer` | Missing `stream` boolean — no SSE path through MCP. |
| `exa.answer` | Exposes `model`, `systemPrompt` — not in spec. Likely SDK-layer extras. |

### Research / Imports

| Op | Drift |
|---|---|
| `research.get` | Spec has `stream=true` query param for SSE (yaml:1872-1879); handler has `events` boolean but no stream surface. |
| `imports.create` | Handler requires `format`/`entity`/`count`/`size`; SDK example uses `source.type+url`. Possible schema divergence from spec's `CreateImportParameters` — needs spot verification before any related change. |

---

## 4. Low-severity / acceptable

- `enrichments.update`: handler synthesizes `{ success: true, enrichmentId }`; spec returns 200 with no body. Safe but synthetic.
- `webhooks.create` events: enum-validation gap (low because Exa rejects unknown values).
- `projectWebhook` strips `createdAt`/`updatedAt`/`object`. The secret strip is intentional (only present at create time per spec).
- `websets.preview` flat-vs-nested-search: cosmetic shape divergence.
- Convenience auto-paginators (`*.getAll`, `waitUntilIdle`, `pollUntilFinished`): intentional server additions, no spec equivalent expected.
- `exa.findSimilar`: **no public spec backing**. Exists only in the SDK wrapper (delegates to `exa.findSimilarAndContents()`-style internal routing). Works in practice; carries no API guarantee. Worth a docstring note.

---

## 5. EventType enum (canonical list)

Spec defines 19 values. Server accepts `z.string()` — no client-side validation:

```
webset.created
webset.deleted
webset.paused
webset.idle
webset.search.created
webset.search.canceled
webset.search.completed
webset.search.updated
import.created
import.completed
webset.item.created
webset.item.enriched
monitor.created
monitor.updated
monitor.deleted
monitor.run.created
monitor.run.completed
webset.export.created
webset.export.completed
```

Notes: `webset.export.created` / `webset.export.completed` imply an Exports domain not present in scope-of-audit; not investigated further. Spec code samples reference `webset.completed` and `enrichment.completed` informally — neither appears in the formal `EventType` enum and they should not be treated as valid.

---

## 6. Suggested order of attack

1. **Quick wins, high impact (one PR)**: fix `websets.create` `name`→`title`, fix `exa.search` `type` enum, restore `projectEvent` `data` payload.
2. **New top-level Monitors API**: meaningful new product surface; SDK already wired. Lowest-friction op first (`monitors.trigger`), then full CRUD, then `batch`. Consider naming: keep existing `monitors.*` mapped to v0, add new namespace (`searchMonitors.*`?) to avoid confusion.
3. **Agent Runs**: beta-gated, larger lift (SSE handling, header propagation, channel-bridge integration). Worth a separate design pass. Use `agentRuns.*` namespace.
4. **Sweep medium-severity missing fields** on existing ops in one schema-only pass.
5. **`teams.me`**: trivial one-op addition; useful for quota-aware orchestration logic.
6. **Streaming surface decision**: `/search` (when `outputSchema` is set), `/answer`, `/research/v1` (`stream=true`), and `/agent/runs` all support SSE in spec. None is reachable through MCP today. May be intentional given the StreamableHTTP transport choice — but worth an explicit call.

---

## 7. Audit provenance

- Spec: `specs/exa-api/exa-public-api.yaml` (18,279 lines)
- Server registry: `src/tools/operations.ts` (lines 36–110)
- Handlers: `src/handlers/{websets,searches,items,enrichments,webhooks,events,monitors,imports,research,exa,tasks,github,types}.ts`
- Projections: `src/lib/projections.ts`
- SDK: `exa-js@2.12.1` (verified via `node_modules/exa-js/dist/**`)
- Method: 5 parallel cartographer subagents returning structured JSON, synthesized 2026-05-22.
