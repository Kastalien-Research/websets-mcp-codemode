# Exa Connect Enrichment — Design

**Date:** 2026-06-25
**Status:** Draft for review
**Scope:** Thin primitives + one background workflow

## 1. Context & problem

Exa shipped **Exa Connect**: a way to attach premium data partners (Similarweb,
Fiber.ai, Crunchbase, Harmonic, ZoomInfo, OpenAlex, …) to an Exa Agent run. We
want an agent operating this Websets MCP server to call Connect and use the
results to **enrich the local Webset store** — adding partner data (traffic,
firmographics, funding, KYB, scholarly metadata) on top of Exa-native
enrichments, without touching Exa's server-side infrastructure.

### Key finding: Connect is a request parameter, not a new integration

Connect is **not** a separate API, OAuth flow, or per-partner SDK. It is a single
field — `dataSources: [{ provider: "<id>" }]` (up to 5) — on
`POST /agent/runs`, the *exact endpoint this server already calls* in
`agentRuns.create` (`src/handlers/agentRuns.ts`, via `agentFetch` with the
`Exa-Beta: agent-2026-05-07` header). The Exa Agent selects the right partner
tool per `outputSchema` field, fuses partner data with web search, and returns
structured output plus grounding citations. Pricing is additive: standard Agent
compute + a per-call provider charge.

Empirically (confirmed against the live server catalog), `agentRuns.create`
currently exposes only `query / outputSchema / input / effort / stream` —
**`dataSources` is absent**, so it is stripped at Zod validation and Connect is
un-callable today. The Agent API also accepts `systemPrompt`, `previousRunId`,
and an `xhigh` effort tier that the current schema omits.

**Consequence:** enabling the *call* is ~10 lines. The real design work is the
**enrichment workflow + persistence** of arbitrary, schema-shaped output into the
local store.

### How this "does better" than Exa's reference MCP

Exa's own MCP (`agent_create_run`) exposes Connect as a stateless raw call. Our
edge in this architecture:

1. **Persistence + fusion** — Connect output lands in the local SQLite store,
   joined to Webset items, annotations, scores, and notebooks.
2. **Provider catalog as data** (`connect.providers`) — the agent routes
   correctly and never hallucinates provider IDs or input keys.
3. **Batch enrichment via `input.data`** — one Agent run enriches a whole
   worklist, far cheaper than one run per item.
4. **Feeds the investigation loop** — Connect fields become lens hits, score
   components, and notebook evidence via existing `store.*` ops.

## 2. Goals / non-goals

**Goals**
- Make Connect callable from Code Mode (`execute`) and from a one-call bulk
  workflow.
- Persist Connect output to the local store, queryable via `store.query`.
- Give the agent a verified provider catalog so it builds correct runs.
- Surface cost; never silently spend without reporting.

**Non-goals (this increment)**
- Per-provider typed *tables* (see §4 for the tension and the view-based
  resolution).
- Auto-enrichment triggers from monitors/webhooks.
- Hardcoding scoring rules for Connect fields (left to Code Mode / downstream).
- Wiring "contact-us" providers whose IDs aren't published.

## 3. Architecture

Four components, smallest-surface-first.

### 3.1 Extend `agentRuns.create` (the Connect call)

`src/handlers/agentRuns.ts` — add to the `create` schema and forward in the body:

- `dataSources`: `z.array(z.object({ provider: z.string() }).passthrough()).max(5).optional()`
- `systemPrompt`: `z.string().optional()`
- `previousRunId`: `z.string().optional()`
- `effort`: extend enum to `['low','medium','high','xhigh','auto']`

No transport changes — `agentFetch` already targets `/agent/runs` with the beta
header. This alone makes Connect usable from `execute`.

### 3.2 `connect.providers` (provider catalog as data)

New handler `src/handlers/connect.ts`, registered as operation
`connect.providers`. Returns a **static, curated** catalog (no API call) so the
agent can pick providers and shape `outputSchema` correctly. Each entry:

```ts
{
  id: string | null,        // null when not publicly published
  label: string,
  category: string,         // 'web-analytics' | 'firmographics' | 'kyb' | ...
  status: 'active' | 'gated',// active = usable ID now; gated = contact-us
  selfServe: boolean,
  pricePerCall: number | null,
  inputKeys: string[],      // 'domain' | 'company_name' | 'ticker' | 'person_name' | ...
  bestEntityTypes: string[],// 'company' | 'person' | 'research_paper' | ...
  notes: string,
}
```

Optional `domain`/`status` filter args. Only doc-verified IDs are marked
`active` (see §6). Contact-us providers are listed with `id: null,
status: 'gated'` so the agent knows they exist but cannot fabricate an ID.

### 3.3 Persistence — `connect_enrichments` table + `store.attachConnect`

**Store of record** — one generic table (`src/store/db.ts`), typed envelope +
JSON payload:

```sql
CREATE TABLE IF NOT EXISTS connect_enrichments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT NOT NULL REFERENCES items(id),
  providers   JSON NOT NULL,        -- ["similarweb","fiber_ai"]
  query       TEXT,
  schema_hash TEXT NOT NULL,        -- hash(sorted(providers) + canonical(outputSchema))
  structured  JSON,                 -- the outputSchema result object
  grounding   JSON,                 -- citations
  cost_dollars REAL,
  effort      TEXT,
  run_id      TEXT,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_id, schema_hash)      -- re-running same enrichment updates in place
);
CREATE INDEX IF NOT EXISTS idx_connect_item ON connect_enrichments(item_id);
CREATE INDEX IF NOT EXISTS idx_connect_run  ON connect_enrichments(run_id);
```

`store.attachConnect({ itemId, providers, query, structured, grounding, cost,
runId, effort })` upserts a row. It **rejects unknown `itemId`** (mirrors the
`attachYelp` orphan-rejection fixed in d471840) — call `store.syncItem` first.
Idempotent on `(item_id, schema_hash)`: re-enriching with the same
providers+schema refreshes the row instead of duplicating.

**Typed ergonomics via SQL views** (the resolution to the typed-table tension,
§4). Ship two starter views projecting hot JSON paths into named columns:

```sql
CREATE VIEW IF NOT EXISTS similarweb_v AS
SELECT item_id, run_id,
  json_extract(structured,'$.monthlyVisits') AS monthly_visits,
  json_extract(structured,'$.globalRank')    AS global_rank,
  json_extract(structured,'$.bounceRate')    AS bounce_rate,
  cost_dollars, fetched_at
FROM connect_enrichments WHERE providers LIKE '%similarweb%';

CREATE VIEW IF NOT EXISTS firmographics_v AS
SELECT item_id, run_id,
  json_extract(structured,'$.employee_count')   AS employee_count,
  json_extract(structured,'$.funding_stage')    AS funding_stage,
  json_extract(structured,'$.estimated_revenue') AS estimated_revenue,
  cost_dollars, fetched_at
FROM connect_enrichments WHERE providers LIKE '%fiber_ai%';
```

Views cost nothing to maintain (no migration, no write-path code), are lossless
(JSON keeps everything), and more are added only as a provider+schema pattern
stabilizes. For frequently-queried JSON paths, add expression indexes
(`CREATE INDEX ... ON connect_enrichments(json_extract(structured,'$.x'))`).

### 3.4 `connect.enrich` workflow (bulk, background)

New workflow `src/workflows/connectEnrich.ts`, `registerWorkflow('connect.enrich',
…)`, invoked via `tasks.create({ type: 'connect.enrich', args })`. Mirrors
`verifyEnrichments.ts` structure (step tracker, `collectItems`,
`store.updateProgress`, `withSummary`).

Args:
- `websetId` (required)
- `providers`: `string[]` — provider IDs (validated against the active catalog)
- `outputSchema` (required) — the enrichment shape
- `query?` — natural-language framing; a sensible default is generated per
  entity type if omitted
- `maxItems?` (default 50), `filter?` — `'uninvestigated' | 'all'`
- `effort?` (default `'low'`), `batchSize?` (default e.g. 25)
- `dryRun?` (default false)

Flow:
1. Load webset, determine entity type; resolve each item's input anchor
   (domain/name/ticker) for the chosen providers from the catalog `inputKeys`.
2. Build `input.data` rows, each carrying a passthrough `_itemId` for
   correlation.
3. **Cost estimate** = `rows × providers × pricePerCall` (+ note Agent compute is
   additional). Emit a `log`/progress warning. If `dryRun`, return the estimate
   and stop. If `CONNECT_MAX_ITEMS` env is set and exceeded, cap to it and warn
   (no hard cap by default — see §5).
4. Call the Agent in batches of `batchSize` (one run per batch via `input.data`),
   throttled for 429 with retry/backoff.
5. Correlate each output row back to its `_itemId`; `store.syncItem` if needed,
   then `store.attachConnect`.
6. Return `{ enriched, failed, costDollars, runIds }` via `withSummary`.

## 4. The typed-table tension (decision record)

Pure per-provider typed tables (the `yelp_businesses` model) fight Connect's
grain for four reasons:

1. **Schema ownership.** Yelp's API owns its stable response shape; Connect's
   shape is owned by the caller's arbitrary, per-run `outputSchema`. A typed
   `similarweb_metrics` table would need an unknowable superset of columns, would
   silently drop un-modeled fields, or would require a migration per new request.
2. **Nullable everything.** The Agent is LLM-driven; requested fields come back
   absent when the partner lacks data, so no column can be `NOT NULL` — eroding
   the typing benefit.
3. **Nested fields.** The valuable outputs (`topCompetitors[]`, `officers[]`,
   `articles[]`) are arrays/objects that become JSON inside any table anyway.
4. **Fused multi-provider output.** One run fuses up to 5 providers into one
   object; that row belongs to no single provider table.

Plus operational reality: Exa added a dozen providers in a week and offers more
on request — a table+migration+handler per provider does not scale and is the
maintenance burden the project standards warn against.

**Decision:** generic `connect_enrichments` table (typed envelope + JSON
payload) as the store of record, with **typed SQL views** for high-value
providers to recover named-column ergonomics losslessly and on demand. This
preserves the "typed and queryable" goal without the brittleness. *(Open for
explicit sign-off at the review gate.)*

## 5. Cost posture

Per the chosen posture: **warn and proceed; no hard cap by default.**
- The workflow always computes and reports an estimate before running and the
  actual cost after.
- `dryRun: true` returns the estimate without spending.
- An optional `CONNECT_MAX_ITEMS` env var, when set, caps items and warns; unset
  means no cap.
- No per-invocation confirmation round-trip.

## 6. Provider catalog (initial contents)

Verified self-serve IDs (mark `active`):

| id | category | price/call | input keys | best entity types |
|----|----------|-----------|-----------|-------------------|
| `fiber_ai` | firmographics/people | $0.02 | domain, company_name, linkedin_url, email | company, person |
| `similarweb` | web-analytics | $0.03 | domain | company |
| `baselayer` | kyb | $0.022 | company_name + state | company |
| `financial_datasets` | finance-news | $0.01 | ticker | company, article |
| `particle_news` | media | $0.015 | person_name, topic | person |
| `affiliate_com` | commerce | $0.015 | product | (weak fit) |
| `jinko` | travel | $0.005 | airport, budget | (weak fit) |
| `harmonic` | startup-intel | n/a | domain, company_name, founder | company, person |

`harmonic` has a published ID but requires contact-us activation → list as
`status: 'gated'`. Contact-us providers with **no published ID** →
`id: null, status: 'gated'`: Crunchbase, ZoomInfo, Intellizence, Kernel,
DefinitiveHealthcare, Faraday, OpenAlex, DataBento, Alpha Vantage, Traject Data.
OpenAlex is flagged as the strongest `research_paper` enricher if/when its ID is
available.

**Verify-before-writing:** the IDs `financial_datasets`, `particle_news`, and
`affiliate_com` were asserted by research from partner doc pages but MUST be
re-confirmed against `https://exa.ai/docs` (the Connect partner pages) during
implementation before being shipped as `active`. `fiber_ai`, `similarweb`,
`baselayer`, `harmonic` are confirmed in the Connect overview/agent guide.

## 7. Error handling

- **429 (concurrency cap):** batch throttle + exponential backoff retry in the
  workflow; surface a partial result with `failed` count rather than aborting.
- **Partial partner data:** missing `outputSchema` fields persist as
  absent/null in `structured`; never fabricated.
- **Unknown itemId:** `store.attachConnect` rejects with a clear message
  pointing to `store.syncItem`.
- **Row correlation:** rely on the `_itemId` passthrough in `input.data`; if the
  Agent drops it, fall back to positional correlation and flag low confidence.
- **Idempotency:** `UNIQUE(item_id, schema_hash)` upsert prevents duplicate rows
  on re-runs.

## 8. Testing

- **Unit:** schema accepts/forwards `dataSources`/`systemPrompt`/`xhigh`;
  `store.attachConnect` upsert + orphan rejection + idempotent re-run; views
  return projected columns; `schema_hash` stability.
- **Catalog:** `connect.providers` returns only verified IDs as `active`; filter
  args work.
- **Workflow (mocked Agent):** `input.data` batching, cost estimate math,
  `dryRun` short-circuit, `CONNECT_MAX_ITEMS` capping, row→item correlation,
  429 backoff path, partial-failure summary.
- **No live billing in tests** — mock `agentFetch`/`agentRuns.create`.

## 9. Out of scope (future increments)

- Typed views beyond the two starters (add as patterns stabilize).
- Monitor/webhook auto-enrichment.
- Connect-field → score/lens automation (left to Code Mode for now).
- Enabling gated providers (needs Exa account setup).
