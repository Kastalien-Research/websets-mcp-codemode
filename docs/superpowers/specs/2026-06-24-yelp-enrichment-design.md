# Yelp Business-Data Enrichment Layer

**Date:** 2026-06-24
**Branch:** `feat/yelp-enrichment`
**Status:** Approved design, pre-implementation

## Summary

Add a generic Yelp Fusion enrichment capability to the Code Mode MCP server. It
wraps Yelp's business endpoints as atomic `yelp.*` operations and adds a
structured, queryable `yelp_businesses` table to the local SQLite shadow store.
An agent, writing JS in the `execute` sandbox, can match store items to Yelp
businesses and commit the structured data, making the local store navigable by
Yelp signal (rating, review count, price, phone).

This is the first of two subsystems behind a larger workflow (build a Webset of
companies → enrich with Yelp → shortlist → outreach). Outreach (Twilio/email) is
a separate, later spec.

## Goals

- Expose Yelp Fusion business endpoints as Code Mode operations.
- Store Yelp data in structured columns so `store.query` can filter and sort by
  rating, review count, and price.
- Keep matching agent-driven: operations return candidates; the agent decides
  and explicitly writes. No silent auto-matching.
- Stay generic — no daycare-specific or Webset-specific logic in the Yelp layer.

## Non-Goals (explicitly out of scope)

- Twilio voice / SMS / email outreach — separate spec.
- An OpenAPI-bundle → operations generator. The handlers are written by hand but
  factored so a generator could be added later without rework.
- Partner / reseller / syndication / checkout / waitlist Yelp endpoints. Only the
  Fusion business-discovery surface is exposed.
- Any daycare-specific feature. The example use case (finding a daycare) is just a
  driver; the capability is general business enrichment.

## Background & Constraints

- **Architecture:** Capabilities are operations (`namespace.action` → handler +
  Zod schema) registered in `src/tools/operations.ts` (`OPERATIONS`,
  `OPERATION_SCHEMAS`). The agent invokes them via `callOperation(name, args)` in
  the `vm` sandbox (`src/tools/sandbox.ts`).
- **Discoverability is automatic.** `src/tools/catalog.ts` indexes every
  `OPERATIONS` entry: `domain` is the prefix before the first `.`, tags are
  derived from the operation name and its summary. Registering `yelp.*` ops with
  clear summaries makes them discoverable through the `search` tool with no extra
  catalog code.
- **Auth:** The Fusion endpoints (`servers: https://api.yelp.com`) use
  `bearerAuth` (`Authorization: Bearer <key>`). A single `YELP_API_KEY` env var is
  required. (Already added to `.env`.)
- **Client convention:** Clients read keys from `process.env` and are exported as
  singletons (see `src/lib/exa.ts`).
- **Store convention:** `src/store/db.ts` owns the schema (idempotent
  `CREATE TABLE IF NOT EXISTS` in the init path) and exports typed
  `upsert*`/`get*` functions; `src/store/operations.ts` wraps them as
  `store.*` operation handlers.

### Tier limitation to verify at build time

On the basic Yelp Fusion tier, `GET /v3/businesses/{id}/reviews` returns up to
**3 review excerpts**, not full review text. The `yelp.reviews` operation will
document this and return whatever the tier provides — it must not promise full
reviews. Verify actual behavior against the live key during implementation.

## Architecture

### Component 1 — Yelp HTTP client (`src/lib/yelp.ts`)

A small standalone client, mirroring `src/lib/exa.ts`.

- Reads `YELP_API_KEY` from `process.env`.
- Base URL `https://api.yelp.com`; sets `Authorization: Bearer <key>` and
  `Accept: application/json`.
- A typed `yelpGet(path, query)` helper that builds the query string, performs
  the request, and on non-2xx throws an error including HTTP status, the endpoint
  path, and the Yelp error body. If `YELP_API_KEY` is unset, fail fast with a
  clear, actionable message.
- No handler logic here — kept reusable so a future OpenAPI generator can build
  on the same client.

**Interface:** `what` — authenticated GET access to Yelp Fusion. `how` — import
and call `yelpGet`. `depends on` — `process.env.YELP_API_KEY`, `fetch`.

### Component 2 — Yelp operations (`src/handlers/yelp.ts`)

Curated, atomic, agent-driven. Each operation is an `OperationHandler` plus a Zod
schema exported in a `Schemas` object (matching the existing handler modules).
All return raw Yelp data — they do not write to the store.

| Operation | Yelp endpoint | Inputs (Zod) |
|---|---|---|
| `yelp.search` | `GET /v3/businesses/search` | `term?`, `location?` or `latitude?`+`longitude?`, `radius?`, `categories?`, `price?`, `open_now?`, `sort_by?`, `limit?` |
| `yelp.phoneSearch` | `GET /v3/businesses/search/phone` | `phone` (E.164) |
| `yelp.match` | `GET /v3/businesses/matches` | `name`, `address1`, `city`, `state`, `country`, `latitude?`, `longitude?` |
| `yelp.details` | `GET /v3/businesses/{id_or_alias}` | `businessId` |
| `yelp.reviews` | `GET /v3/businesses/{id_or_alias}/reviews` | `businessId`, `limit?`, `sort_by?` |

Schema notes:
- `yelp.search` requires either `location` or both `latitude` and `longitude`;
  enforce with a Zod refinement and a clear error message.
- `limit` is bounded to Yelp's allowed range (1–50 for search).

**Interface:** `what` — typed wrappers over Fusion business endpoints returning
candidates/details. `how` — `callOperation('yelp.search', {...})` in the sandbox.
`depends on` — Component 1.

### Component 3 — Store table + write op

**Schema** (added to the init path in `src/store/db.ts`):

```sql
CREATE TABLE IF NOT EXISTS yelp_businesses (
  yelp_id          TEXT PRIMARY KEY,
  item_id          TEXT,            -- nullable link to items.id
  name             TEXT,
  rating           REAL,
  review_count     INTEGER,
  price            TEXT,            -- Yelp '$'..'$$$$'
  phone            TEXT,
  display_address  TEXT,            -- joined location.display_address
  latitude         REAL,
  longitude        REAL,
  url              TEXT,
  categories       TEXT,            -- JSON array
  raw              TEXT,            -- full Yelp payload as JSON
  fetched_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_yelp_item ON yelp_businesses(item_id);
CREATE INDEX IF NOT EXISTS idx_yelp_rating ON yelp_businesses(rating);
```

Keying decision: PK is `yelp_id` with a nullable, indexed `item_id`. This keeps
the Yelp data identity-correct (one row per real business) and Webset-agnostic —
Yelp rows can exist independently and be linked to a store item when matched.
Item↔Yelp is one-to-one in practice.

**DB functions** (`src/store/db.ts`): `upsertYelpBusiness(record)` —
`INSERT ... ON CONFLICT(yelp_id) DO UPDATE`, refreshing `fetched_at` and
`item_id`. Idempotent.

**Write operation** (`src/store/operations.ts`): `store.attachYelp` —
inputs `{ itemId, yelp }` where `yelp` is a Yelp business object (as returned by
`yelp.match` / `yelp.details` / a `yelp.search` result). It maps the Yelp fields
into the table columns, stores the full object in `raw`, links `item_id`, and
upserts. Returns `{ yelpId, itemId, attached: true }`.

This makes navigability real:

```sql
SELECT i.name, y.rating, y.review_count, y.price, y.phone
FROM items i
JOIN yelp_businesses y ON y.item_id = i.id
WHERE y.rating > 4.5 AND y.review_count > 50
ORDER BY y.rating DESC;
```

(run via the existing read-only `store.query`).

### Component 4 — Registry wiring & config

- Register the five `yelp.*` operations and `store.attachYelp` in `OPERATIONS`
  and `OPERATION_SCHEMAS` in `src/tools/operations.ts`, with concise summaries
  (so catalog tags include "yelp", "rating", "reviews", "phone", "business").
- Add `YELP_API_KEY` to `.env.example` and the `docker-compose` environment.
- No changes needed in `catalog.ts` — indexing is automatic.

## Data Flow (the workflow this unlocks)

No code beyond the above is needed for the end-to-end flow; the agent composes it
in the sandbox:

1. `websets.create` + `searches.create` → a Webset of businesses in an area.
2. `store.syncItem` each item into the shadow store.
3. For each uninvestigated item: `yelp.match` (name + address) or
   `yelp.search`/`yelp.phoneSearch`; the agent inspects candidates and picks one.
4. `store.attachYelp(itemId, chosen)` to commit structured data.
5. `store.query` to shortlist by rating / review_count / price.

Outreach over the shortlist is the next spec.

## Error Handling

- Missing `YELP_API_KEY`: client throws a clear setup error on first use.
- Non-2xx from Yelp: operations surface status + endpoint + Yelp error body via
  the existing `errorResult` pattern; no silent failures.
- `yelp.search` with neither `location` nor coordinates: rejected at schema
  validation with an actionable message.
- `store.attachYelp` with a malformed Yelp object: validated; missing optional
  fields are stored as null, not fabricated.

## Testing

- **Unit (`vitest`, mock the HTTP boundary only):**
  - `yelp.ts` client: correct URL/query construction, Bearer header, error
    construction on non-2xx, fail-fast on missing key.
  - Zod schemas: `yelp.search` location-xor-coordinates refinement; `limit`
    bounds; required fields.
  - `upsertYelpBusiness` / `store.attachYelp`: upsert idempotency (second write
    updates, not duplicates) and the item↔yelp JOIN query, using an in-memory
    SQLite db.
- **Integration (guarded):** one test that calls `yelp.search` against the live
  API, skipped automatically when `YELP_API_KEY` is unset — consistent with the
  existing unit/integration/e2e split.
- Verify tests fail before the code exists (TDD), then implement to green.

## Open Verification Items (resolve during implementation)

1. Confirm `/v3/businesses/{id}/reviews` actual return shape and tier limit
   against the live key; document in the `yelp.reviews` summary.
2. Confirm Fusion `search` `limit` max (expected 50) and `price` parameter format
   (expected `1,2,3,4`).
