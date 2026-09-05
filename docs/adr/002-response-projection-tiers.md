# ADR-002: Response Projection Tiers for Agent Context

## Status

Accepted; contract corrections applied September 2026.

## Context

Every handler currently passes raw Exa API responses to the agent via `successResult(JSON.stringify(data))`. A fully-enriched WebsetItem with content can be 5–55 KB. Agents consuming this repeatedly waste context on:

1. **Items that don't pass criteria** — noise the Websets filter was supposed to remove
2. **Fields irrelevant to decisions** — content (1–200 KB), reasoning chains, references, timestamps, configuration details
3. **Structural overhead** — nested polymorphic objects the agent has to parse to extract basic facts

The projection layer presents compact results while retaining IDs and explicit paths to full evidence. Filtering is a caller choice, not a claim that returned rows satisfy every criterion.

## Decision

### 1. All-Domain Projection Layer

Use `src/lib/projections.ts` with one projection function per domain. Each extracts status and primary useful fields. Item and search responses retain parent IDs and timestamps; search recall estimates are preserved unchanged. Entity type is promoted from `properties.type` to a top-level field on items, and from `searches[0].entity.type` on websets.

### 2. Item Filtering

Bulk item operations (`items.list`, `items.getAll`) accept `evaluationPolicy: "any" | "all" | "none"`. `any` remains the default and includes rows with at least one `yes`. `all` requires every reported evaluation to be `yes`; `none` includes all rows. Empty evaluations remain included for all policies. Retained `unclear` values are not converted to false. Workflow projections keep their existing default policy.

`total`, `included`, and `excluded` describe fetched rows, page-local for `items.list`. Filtering never changes provider pagination. A fully filtered page can still have `hasMore: true`. Explicitly expanded Webset `items` remain raw and unfiltered.

### 3. Single-Item Inspection Unchanged

`items.get` returns full raw response — single-item inspection should have all details.

## Projected Fields by Domain

See `src/lib/projections.ts` for exact shapes. Summary:

| Domain | Key Fields Kept | Key Fields Stripped |
|--------|----------------|-------------------|
| Item (bulk) | id, websetId, createdAt, updatedAt, name, url, entityType, description, evaluations[criterion+satisfied], enrichments[enrichmentId+description+format+result+status] | properties.content, evaluation reasoning/references, enrichment reasoning/references, entity sub-objects |
| Webset | id, dashboardUrl, url when supplied, raw expanded items, status, title, entityType, metadata, searches[id+status+query+progress], enrichments[id+status+description+format], monitors[id+status+nextRunAt], imports[id+status+count] | Full search/enrichment/monitor/import objects, configuration |
| Search | id, websetId, count, createdAt, updatedAt, recall, status, query, metadata, progress[found+analyzed+completion+timeLeft], criteria[description+successRate] | Entity config, behavior |
| Enrichment | id, status, description, format, metadata | Options config, timestamps |
| Monitor | id, status, nextRunAt, metadata, lastRun[status+completedAt] | Cadence config, behavior config |
| Monitor Run | id, status, type, completedAt, failedReason | Timing details |
| Webhook | id, status, url, events, metadata | Secret, timestamps |
| Webhook Attempt | eventType, successful, responseStatusCode, attemptedAt | Full payload, headers |
| Import | id, status, count, title, metadata, failedReason, uploadUrl, uploadValidUntil | Other file details, timestamps |
| Event | id, type, createdAt | Data payload (agent should use specific get operations) |
| Research | researchId, status, model, output (completed), cost (completed) | Events, intermediate steps |

## Consequences

- Projected item ~200–500 bytes vs 5–55 KB raw → 10–100× context reduction
- Existing `any` filtering remains the default; callers can select strict all-criteria or unfiltered inspection
- Search recall stays an estimate, and raw item/expansion paths preserve full evidence
- `entityType` promoted to top level → no more parsing `properties.type`
- Single-item get (`items.get`) unchanged → full inspection still available
- Workflow internals still use full raw items for classification/scoring
