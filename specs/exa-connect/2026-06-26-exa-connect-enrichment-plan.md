# Exa Connect Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent call Exa Connect (premium data partners) through the existing Agent-runs endpoint and persist the fused output into the local Webset store as queryable enrichment.

**Architecture:** Connect is a `dataSources` parameter on `POST /agent/runs` — the endpoint `agentRuns.create` already calls. We extend that schema, add a verified provider catalog op, persist arbitrary output to a generic `connect_enrichments` table (typed envelope + JSON, with typed SQL views), and add a `connect.enrich` background workflow that batch-enriches a worklist via the Agent's `input.data`.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, better-sqlite3, vitest, exa-js. Spec: `specs/exa-connect/2026-06-25-exa-connect-enrichment-design.md`.

## Global Constraints

- Branch: `feat/exa-connect-enrichment` (already created; spec committed).
- Test runner: `npx vitest run <path>` (project `npm test` = `vitest run`).
- Imports: `.js` extension on relative imports (NodeNext), absolute-style within `src/`.
- Every commit message ends with the project trailers:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01NsFQJhN7zwjCpBtV16ucPF`.
- DB tests use `closeDb(); getDb(':memory:')` in `beforeEach`, `closeDb()` in `afterEach`.
- Handlers return `ToolResult` via `successResult(...)` / `errorResult(name, err, hints?)` from `src/handlers/types.js`.
- No hard item cap by default; optional `CONNECT_MAX_ITEMS` env var caps + warns.
- Only doc-verified provider IDs may be marked `status: 'active'`.

## File Structure

- Modify `src/handlers/agentRuns.ts` — add `dataSources`/`systemPrompt`/`previousRunId`/`xhigh` to schema + body.
- Create `src/handlers/connect.ts` — `PROVIDER_CATALOG` + `providers` handler.
- Modify `src/store/db.ts` — `connect_enrichments` table + views + `upsertConnectEnrichment` + `connectSchemaHash`.
- Modify `src/store/operations.ts` — `attachConnect` operation + schema.
- Modify `src/tools/operations.ts` — register `connect.providers` + `store.attachConnect`.
- Create `src/workflows/connectEnrich.ts` — `connect.enrich` workflow.
- Modify `src/workflows/index.ts` — register `connectEnrich`.
- Tests: extend `src/handlers/__tests__/agentRuns.test.ts`; create `src/handlers/__tests__/connect.test.ts`, `src/store/__tests__/connectEnrichments.test.ts`, `src/workflows/__tests__/connectEnrich.test.ts`.

---

### Task 1: Extend `agentRuns.create` for Connect

**Files:**
- Modify: `src/handlers/agentRuns.ts` (Schemas.create + create body builder)
- Test: `src/handlers/__tests__/agentRuns.test.ts`

**Interfaces:**
- Produces: `agentRuns.create` now accepts `dataSources?: {provider: string}[]` (max 5), `systemPrompt?: string`, `previousRunId?: string`, and `effort` enum includes `'xhigh'`. All forwarded into the `POST /agent/runs` body.

- [ ] **Step 1: Write the failing test** — append to `src/handlers/__tests__/agentRuns.test.ts`:

```ts
describe('agentRuns.create — Connect dataSources', () => {
  it('forwards dataSources, systemPrompt, previousRunId, and xhigh effort in the body', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'agent_run_x', object: 'agent_run', status: 'running' }));

    await agentRuns.create(
      {
        query: 'Profile Anthropic',
        dataSources: [{ provider: 'similarweb' }, { provider: 'fiber_ai' }],
        systemPrompt: 'Be terse',
        previousRunId: 'agent_run_prev',
        effort: 'xhigh',
      },
      fakeExa(),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.dataSources).toEqual([{ provider: 'similarweb' }, { provider: 'fiber_ai' }]);
    expect(body.systemPrompt).toBe('Be terse');
    expect(body.previousRunId).toBe('agent_run_prev');
    expect(body.effort).toBe('xhigh');
  });

  it('rejects more than 5 dataSources via schema', () => {
    const parsed = agentRuns.Schemas.create.safeParse({
      query: 'x',
      dataSources: [1, 2, 3, 4, 5, 6].map((n) => ({ provider: `p${n}` })),
    });
    expect(parsed.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/handlers/__tests__/agentRuns.test.ts -t "Connect dataSources"`
Expected: FAIL (`body.dataSources` is `undefined`; schema strips it).

- [ ] **Step 3: Implement** — in `src/handlers/agentRuns.ts`, update the `create` schema:

```ts
  create: z.object({
    query: z.string(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    input: z.object({
      data: z.array(z.record(z.string(), z.unknown())).optional(),
      exclusion: z.array(z.record(z.string(), z.unknown())).optional(),
    }).passthrough().optional(),
    dataSources: z.array(z.object({ provider: z.string() }).passthrough()).max(5).optional(),
    systemPrompt: z.string().optional(),
    previousRunId: z.string().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'auto']).optional(),
    stream: z.boolean().optional(),
  }),
```

Then in the `create` handler, extend the body builder (after the existing `if (args.effort)` line):

```ts
    const body: Record<string, unknown> = { query: args.query };
    if (args.outputSchema) body.outputSchema = args.outputSchema;
    if (args.input) body.input = args.input;
    if (args.dataSources) body.dataSources = args.dataSources;
    if (args.systemPrompt) body.systemPrompt = args.systemPrompt;
    if (args.previousRunId) body.previousRunId = args.previousRunId;
    if (args.effort) body.effort = args.effort;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/handlers/__tests__/agentRuns.test.ts`
Expected: PASS (all agentRuns tests).

- [ ] **Step 5: Commit**

```bash
git add src/handlers/agentRuns.ts src/handlers/__tests__/agentRuns.test.ts
git commit -m "feat(connect): forward dataSources + xhigh on agentRuns.create"
```

---

### Task 2: `connect_enrichments` table, views, and db helpers

**Files:**
- Modify: `src/store/db.ts` (initSchema + new exports)
- Test: `src/store/__tests__/connectEnrichments.test.ts`

**Interfaces:**
- Produces:
  - `connectSchemaHash(providers: string[], schema: unknown): string`
  - `upsertConnectEnrichment(rec: { itemId: string; providers: string[]; query?: string; schemaHash: string; structured?: unknown; grounding?: unknown; costDollars?: number; effort?: string; runId?: string }): void`
  - Table `connect_enrichments` and views `similarweb_v`, `firmographics_v`.

- [ ] **Step 1: Write the failing test** — create `src/store/__tests__/connectEnrichments.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, upsertItem, upsertConnectEnrichment, connectSchemaHash } from '../db.js';

describe('connect_enrichments store', () => {
  beforeEach(() => {
    closeDb();
    getDb(':memory:');
    upsertItem({ id: 'item1', websetId: 'ws1', name: 'Anthropic' });
  });
  afterEach(() => closeDb());

  it('connectSchemaHash is stable regardless of provider order', () => {
    const a = connectSchemaHash(['fiber_ai', 'similarweb'], { type: 'object' });
    const b = connectSchemaHash(['similarweb', 'fiber_ai'], { type: 'object' });
    expect(a).toBe(b);
  });

  it('upserts a row and stores structured JSON', () => {
    const hash = connectSchemaHash(['similarweb'], { x: 1 });
    upsertConnectEnrichment({
      itemId: 'item1', providers: ['similarweb'], schemaHash: hash,
      structured: { monthlyVisits: 1500000, globalRank: 1200 }, costDollars: 0.03, runId: 'r1',
    });
    const row = getDb().prepare('SELECT * FROM connect_enrichments WHERE item_id = ?').get('item1') as any;
    expect(JSON.parse(row.providers)).toEqual(['similarweb']);
    expect(JSON.parse(row.structured).monthlyVisits).toBe(1500000);
    expect(row.cost_dollars).toBe(0.03);
  });

  it('is idempotent on (item_id, schema_hash) — re-run updates in place', () => {
    const hash = connectSchemaHash(['similarweb'], { x: 1 });
    const base = { itemId: 'item1', providers: ['similarweb'], schemaHash: hash };
    upsertConnectEnrichment({ ...base, structured: { monthlyVisits: 1 } });
    upsertConnectEnrichment({ ...base, structured: { monthlyVisits: 2 } });
    const rows = getDb().prepare('SELECT * FROM connect_enrichments WHERE item_id = ?').all('item1') as any[];
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].structured).monthlyVisits).toBe(2);
  });

  it('similarweb_v view projects JSON paths into columns', () => {
    upsertConnectEnrichment({
      itemId: 'item1', providers: ['similarweb'], schemaHash: connectSchemaHash(['similarweb'], {}),
      structured: { monthlyVisits: 999, globalRank: 50, bounceRate: 0.4 },
    });
    const v = getDb().prepare('SELECT * FROM similarweb_v WHERE item_id = ?').get('item1') as any;
    expect(v.monthly_visits).toBe(999);
    expect(v.global_rank).toBe(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/__tests__/connectEnrichments.test.ts`
Expected: FAIL (`upsertConnectEnrichment` / `connectSchemaHash` not exported).

- [ ] **Step 3: Implement** — in `src/store/db.ts`:

Add `import { createHash } from 'node:crypto';` at the top (after the existing `fs` import).

Append to the `initSchema` SQL (inside the `db.exec(\`...\`)` block, before the closing backtick):

```sql
    CREATE TABLE IF NOT EXISTS connect_enrichments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id      TEXT NOT NULL REFERENCES items(id),
      providers    JSON NOT NULL,
      query        TEXT,
      schema_hash  TEXT NOT NULL,
      structured   JSON,
      grounding    JSON,
      cost_dollars REAL,
      effort       TEXT,
      run_id       TEXT,
      fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(item_id, schema_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_connect_item ON connect_enrichments(item_id);
    CREATE INDEX IF NOT EXISTS idx_connect_run ON connect_enrichments(run_id);

    CREATE VIEW IF NOT EXISTS similarweb_v AS
      SELECT item_id, run_id,
        json_extract(structured,'$.monthlyVisits') AS monthly_visits,
        json_extract(structured,'$.globalRank')    AS global_rank,
        json_extract(structured,'$.bounceRate')    AS bounce_rate,
        cost_dollars, fetched_at
      FROM connect_enrichments WHERE providers LIKE '%similarweb%';

    CREATE VIEW IF NOT EXISTS firmographics_v AS
      SELECT item_id, run_id,
        json_extract(structured,'$.employee_count')    AS employee_count,
        json_extract(structured,'$.funding_stage')     AS funding_stage,
        json_extract(structured,'$.estimated_revenue') AS estimated_revenue,
        cost_dollars, fetched_at
      FROM connect_enrichments WHERE providers LIKE '%fiber_ai%';
```

Append these exports at the end of `src/store/db.ts`:

```ts
// --- Connect enrichment operations ---

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function connectSchemaHash(providers: string[], schema: unknown): string {
  const payload = stableStringify({ providers: [...providers].sort(), schema });
  return createHash('sha256').update(payload).digest('hex');
}

export interface ConnectEnrichmentRecord {
  itemId: string;
  providers: string[];
  query?: string;
  schemaHash: string;
  structured?: unknown;
  grounding?: unknown;
  costDollars?: number;
  effort?: string;
  runId?: string;
}

export function upsertConnectEnrichment(rec: ConnectEnrichmentRecord): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO connect_enrichments
      (item_id, providers, query, schema_hash, structured, grounding, cost_dollars, effort, run_id, fetched_at)
    VALUES
      (@itemId, @providers, @query, @schemaHash, @structured, @grounding, @costDollars, @effort, @runId, datetime('now'))
    ON CONFLICT(item_id, schema_hash) DO UPDATE SET
      providers = excluded.providers,
      query = excluded.query,
      structured = excluded.structured,
      grounding = excluded.grounding,
      cost_dollars = excluded.cost_dollars,
      effort = excluded.effort,
      run_id = excluded.run_id,
      fetched_at = datetime('now')
  `).run({
    itemId: rec.itemId,
    providers: JSON.stringify(rec.providers),
    query: rec.query ?? null,
    schemaHash: rec.schemaHash,
    structured: rec.structured != null ? JSON.stringify(rec.structured) : null,
    grounding: rec.grounding != null ? JSON.stringify(rec.grounding) : null,
    costDollars: rec.costDollars ?? null,
    effort: rec.effort ?? null,
    runId: rec.runId ?? null,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/__tests__/connectEnrichments.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts src/store/__tests__/connectEnrichments.test.ts
git commit -m "feat(connect): add connect_enrichments table, views, and store helpers"
```

---

### Task 3: `store.attachConnect` operation

**Files:**
- Modify: `src/store/operations.ts` (Schemas + handler + imports)
- Modify: `src/tools/operations.ts` (register operation + schema)
- Test: `src/store/__tests__/connectEnrichments.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `upsertConnectEnrichment`, `connectSchemaHash`, `itemExists` from `db.js`.
- Produces: operation `store.attachConnect`, args `{ itemId, providers, structured, query?, grounding?, cost?, runId?, effort?, outputSchema? }`. Rejects unknown `itemId`. Returns `{ itemId, schemaHash, attached: true }`.

- [ ] **Step 1: Write the failing test** — append to `src/store/__tests__/connectEnrichments.test.ts`:

```ts
import { attachConnect } from '../operations.js';

describe('store.attachConnect', () => {
  beforeEach(() => {
    closeDb();
    getDb(':memory:');
    upsertItem({ id: 'item1', websetId: 'ws1', name: 'Anthropic' });
  });
  afterEach(() => closeDb());

  it('persists structured output linked to the item', async () => {
    const res = await attachConnect({
      itemId: 'item1', providers: ['similarweb'], structured: { monthlyVisits: 1500000 },
      outputSchema: { type: 'object' }, cost: 0.03, runId: 'r1',
    }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toMatchObject({ attached: true, itemId: 'item1' });
    const row = getDb().prepare('SELECT * FROM connect_enrichments WHERE item_id = ?').get('item1') as any;
    expect(JSON.parse(row.structured).monthlyVisits).toBe(1500000);
  });

  it('rejects an unknown itemId (no orphan row)', async () => {
    const res = await attachConnect({
      itemId: 'ghost', providers: ['similarweb'], structured: { x: 1 },
    }, {} as never);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('ghost');
    const row = getDb().prepare('SELECT * FROM connect_enrichments').get();
    expect(row).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/__tests__/connectEnrichments.test.ts -t attachConnect`
Expected: FAIL (`attachConnect` not exported).

- [ ] **Step 3: Implement** — in `src/store/operations.ts`:

Add to the imports from `./db.js`:

```ts
  upsertConnectEnrichment as dbUpsertConnectEnrichment,
  connectSchemaHash,
```

Add to `Schemas`:

```ts
  attachConnect: z.object({
    itemId: z.string(),
    providers: z.array(z.string()).min(1),
    structured: z.record(z.string(), z.unknown()),
    query: z.string().optional(),
    grounding: z.unknown().optional(),
    cost: z.number().optional(),
    runId: z.string().optional(),
    effort: z.string().optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  }),
```

Add the handler (near `attachYelp`):

```ts
export const attachConnect: OperationHandler = async (args) => {
  try {
    const itemId = args.itemId as string;
    const providers = args.providers as string[];
    const structured = args.structured as Record<string, unknown>;
    if (!itemExists(itemId)) {
      throw new Error(
        `attachConnect: item '${itemId}' is not in the local store. Call store.syncItem first so the Connect data has an item to join to.`,
      );
    }
    const schemaBasis = (args.outputSchema as unknown) ?? Object.keys(structured).sort();
    const schemaHash = connectSchemaHash(providers, schemaBasis);
    dbUpsertConnectEnrichment({
      itemId,
      providers,
      query: args.query as string | undefined,
      schemaHash,
      structured,
      grounding: args.grounding,
      costDollars: args.cost as number | undefined,
      effort: args.effort as string | undefined,
      runId: args.runId as string | undefined,
    });
    return successResult({ itemId, schemaHash, attached: true });
  } catch (error) {
    return errorResult('store.attachConnect', error);
  }
};
```

- [ ] **Step 4: Register the operation** — in `src/tools/operations.ts`:

Add to `OPERATIONS` (after the `store.attachYelp` line):

```ts
  'store.attachConnect': { handler: store.attachConnect, summary: 'Attach an Exa Connect enrichment result to a local item (structured, queryable)' },
```

Add to `OPERATION_SCHEMAS` (after the `store.attachYelp` line):

```ts
  'store.attachConnect': store.Schemas.attachConnect,
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/store/__tests__/connectEnrichments.test.ts src/handlers/__tests__/registry.test.ts`
Expected: PASS (registry test confirms op count/wiring stays consistent).

- [ ] **Step 6: Commit**

```bash
git add src/store/operations.ts src/tools/operations.ts src/store/__tests__/connectEnrichments.test.ts
git commit -m "feat(connect): add store.attachConnect operation"
```

---

### Task 4: `connect.providers` catalog

**Files:**
- Create: `src/handlers/connect.ts`
- Modify: `src/tools/operations.ts` (import + register)
- Test: `src/handlers/__tests__/connect.test.ts`

**Interfaces:**
- Produces: operation `connect.providers`, args `{ status?: 'active'|'gated', entityType?: string }`. Returns `{ providers: ProviderEntry[], count }`. `ProviderEntry = { id, label, category, status, selfServe, pricePerCall, inputKeys, bestEntityTypes, notes }`.

- [ ] **Step 1: Write the failing test** — create `src/handlers/__tests__/connect.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { providers, PROVIDER_CATALOG } from '../connect.js';

describe('connect.providers', () => {
  it('returns the full catalog by default', async () => {
    const res = await providers({}, {} as never);
    const out = JSON.parse(res.content[0].text);
    expect(out.count).toBe(PROVIDER_CATALOG.length);
  });

  it('every active provider has a non-null id; gated providers without a public id are null', async () => {
    for (const p of PROVIDER_CATALOG) {
      if (p.status === 'active') expect(typeof p.id).toBe('string');
    }
    const crunchbase = PROVIDER_CATALOG.find((p) => p.label === 'Crunchbase');
    expect(crunchbase?.id).toBeNull();
    expect(crunchbase?.status).toBe('gated');
  });

  it('filters by status', async () => {
    const res = await providers({ status: 'active' }, {} as never);
    const out = JSON.parse(res.content[0].text);
    expect(out.providers.every((p: any) => p.status === 'active')).toBe(true);
  });

  it('filters by entityType', async () => {
    const res = await providers({ entityType: 'research_paper' }, {} as never);
    const out = JSON.parse(res.content[0].text);
    expect(out.providers.every((p: any) => p.bestEntityTypes.includes('research_paper'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/handlers/__tests__/connect.test.ts`
Expected: FAIL (`../connect.js` does not exist).

- [ ] **Step 3: Implement** — create `src/handlers/connect.ts`:

```ts
// Exa Connect provider catalog — curated, static data so the agent can pick
// providers and shape outputSchema without hallucinating IDs. Only doc-verified
// IDs are marked `active`; "contact-us" providers have id: null, status: 'gated'.
//
// All self-serve IDs below were verified against the Exa Connect partner docs
// on 2026-06-26 (https://exa.ai/docs/reference/agent-api/connect/<partner>.md).
// Note: Affiliate.com's provider ID is `affiliate` (NOT `affiliate_com`).

import { z } from 'zod';
import type { OperationHandler } from './types.js';
import { successResult, errorResult } from './types.js';

export interface ProviderEntry {
  id: string | null;
  label: string;
  category: string;
  status: 'active' | 'gated';
  selfServe: boolean;
  pricePerCall: number | null;
  inputKeys: string[];
  bestEntityTypes: string[];
  notes: string;
}

export const PROVIDER_CATALOG: ProviderEntry[] = [
  { id: 'fiber_ai', label: 'Fiber.ai', category: 'firmographics', status: 'active', selfServe: true, pricePerCall: 0.02, inputKeys: ['domain', 'company_name', 'linkedin_url', 'email'], bestEntityTypes: ['company', 'person'], notes: 'B2B company + people database; headcount, funding stage, contacts.' },
  { id: 'similarweb', label: 'Similarweb', category: 'web-analytics', status: 'active', selfServe: true, pricePerCall: 0.03, inputKeys: ['domain'], bestEntityTypes: ['company'], notes: 'Traffic estimates, global rank, competitors for a domain.' },
  { id: 'baselayer', label: 'Baselayer', category: 'kyb', status: 'active', selfServe: true, pricePerCall: 0.022, inputKeys: ['company_name', 'state'], bestEntityTypes: ['company'], notes: 'US business verification: officers, registrations, risk signals.' },
  { id: 'financial_datasets', label: 'Financial Datasets', category: 'finance-news', status: 'active', selfServe: true, pricePerCall: 0.01, inputKeys: ['ticker'], bestEntityTypes: ['company', 'article'], notes: 'Ticker-based news for US public companies.' },
  { id: 'particle_news', label: 'Particle', category: 'media', status: 'active', selfServe: true, pricePerCall: 0.015, inputKeys: ['person_name', 'topic'], bestEntityTypes: ['person'], notes: 'Podcast transcript search with speaker attribution.' },
  { id: 'affiliate', label: 'Affiliate.com', category: 'commerce', status: 'active', selfServe: true, pricePerCall: 0.015, inputKeys: ['product'], bestEntityTypes: [], notes: 'Product catalog search. Weak fit for entity enrichment.' },
  { id: 'jinko', label: 'Jinko', category: 'travel', status: 'active', selfServe: true, pricePerCall: 0.005, inputKeys: ['airport', 'budget'], bestEntityTypes: [], notes: 'Travel destination discovery. Weak fit for entity enrichment.' },
  { id: 'harmonic', label: 'Harmonic', category: 'startup-intel', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['domain', 'company_name', 'founder'], bestEntityTypes: ['company', 'person'], notes: 'Startup signals: hiring, funding, leadership. ID published; requires activation.' },
  { id: null, label: 'Crunchbase', category: 'private-markets', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['domain', 'company_name'], bestEntityTypes: ['company'], notes: 'Funding, investors, M&A, leadership. Contact Exa to set up.' },
  { id: null, label: 'ZoomInfo', category: 'sales-intel', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['domain', 'company_name', 'email'], bestEntityTypes: ['company', 'person'], notes: 'Contact + firmographic data. Contact Exa to set up.' },
  { id: null, label: 'Intellizence', category: 'market-monitoring', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['company_name'], bestEntityTypes: ['company'], notes: 'Company event signals (M&A, funding, layoffs). Contact Exa.' },
  { id: null, label: 'Kernel', category: 'entity-graph', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['domain', 'company_name'], bestEntityTypes: ['company'], notes: 'Persistent entity IDs + corporate hierarchies. Contact Exa.' },
  { id: null, label: 'DefinitiveHealthcare', category: 'healthcare', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['org_name', 'person_name'], bestEntityTypes: ['company', 'person'], notes: 'Healthcare providers/facilities/physicians. Contact Exa.' },
  { id: null, label: 'Faraday', category: 'consumer-intel', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['person_name'], bestEntityTypes: ['person'], notes: 'Consumer identity + prediction data. Contact Exa.' },
  { id: null, label: 'OpenAlex', category: 'scholarly', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['doi', 'title', 'author'], bestEntityTypes: ['research_paper', 'person'], notes: 'Strongest research_paper/author enricher when ID is available. Contact Exa.' },
  { id: null, label: 'Alpha Vantage', category: 'finance', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['ticker'], bestEntityTypes: ['company'], notes: 'Stock/forex/crypto data. Contact Exa.' },
  { id: null, label: 'DataBento', category: 'market-data', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['ticker'], bestEntityTypes: [], notes: 'Institutional market data (instruments, not entities). Contact Exa.' },
  { id: null, label: 'Traject Data', category: 'serp-commerce', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['query'], bestEntityTypes: [], notes: 'SERP + ecommerce data. Weak entity fit. Contact Exa.' },
];

export const Schemas = {
  providers: z.object({
    status: z.enum(['active', 'gated']).optional(),
    entityType: z.string().optional(),
  }),
};

export const providers: OperationHandler = async (args) => {
  try {
    let list = PROVIDER_CATALOG;
    if (args.status) list = list.filter((p) => p.status === args.status);
    if (args.entityType) list = list.filter((p) => p.bestEntityTypes.includes(args.entityType as string));
    return successResult({ count: list.length, providers: list });
  } catch (error) {
    return errorResult('connect.providers', error);
  }
};
```

- [ ] **Step 4: Register the operation** — in `src/tools/operations.ts`:

Add the import (after the `import * as yelp ...` line):

```ts
import * as connect from '../handlers/connect.js';
```

Add to `OPERATIONS` (after the `store.attachConnect` line from Task 3):

```ts
  'connect.providers': { handler: connect.providers, summary: 'List Exa Connect data partners (IDs, prices, input keys, best entity types). Use before building a Connect run.' },
```

Add to `OPERATION_SCHEMAS`:

```ts
  'connect.providers': connect.Schemas.providers,
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/handlers/__tests__/connect.test.ts src/handlers/__tests__/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/connect.ts src/tools/operations.ts src/handlers/__tests__/connect.test.ts
git commit -m "feat(connect): add connect.providers catalog operation"
```

---

### Task 5: `connect.enrich` background workflow

**Files:**
- Create: `src/workflows/connectEnrich.ts`
- Modify: `src/workflows/index.ts` (register)
- Test: `src/workflows/__tests__/connectEnrich.test.ts`

**Interfaces:**
- Consumes: `registerWorkflow`, `WorkflowMeta` (`./types.js`); `createStepTracker`, `isCancelled`, `collectItems`, `withSummary` (`./helpers.js`); `agentRuns.create`; `upsertItem`, `upsertConnectEnrichment`, `connectSchemaHash` (`../store/db.js`); `PROVIDER_CATALOG` (`../handlers/connect.js`).
- Produces: workflow `connect.enrich`, invoked via `tasks.create({ type: 'connect.enrich', args })`. Args: `{ websetId, providers, outputSchema, query?, maxItems?, filter?, effort?, batchSize?, dryRun? }`. Returns `{ websetId, providers, estimatedCost, dryRun, enriched, failed, costDollars, runIds }`.

- [ ] **Step 1: Write the failing test** — create `src/workflows/__tests__/connectEnrich.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runConnectEnrich } from '../connectEnrich.js';
import { getDb, closeDb } from '../../store/db.js';
import type { TaskStore } from '../../lib/taskStore.js';

function fakeStore(): TaskStore {
  return { updateProgress: vi.fn() } as unknown as TaskStore;
}

// Exa stub: websets.get returns entity type; agent runs go through agentRuns,
// which we drive by stubbing global fetch (agentFetch uses fetch under the hood).
function fakeExa() {
  return {
    baseURL: 'https://api.exa.ai',
    headers: { forEach: (cb: (v: string, k: string) => void) => cb('test-key', 'x-api-key') },
    websets: {
      get: vi.fn().mockResolvedValue({ id: 'ws1', searches: [{ entity: { type: 'company' } }] }),
      items: {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'item1', properties: { url: 'https://anthropic.com', company: { name: 'Anthropic' } } },
            { id: 'item2', properties: { url: 'https://openai.com', company: { name: 'OpenAI' } } },
          ],
          hasMore: false,
        }),
      },
    },
  } as any;
}

describe('connect.enrich workflow', () => {
  let fetchSpy: any;
  beforeEach(() => {
    closeDb();
    getDb(':memory:');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => { fetchSpy.mockRestore(); closeDb(); });

  it('dryRun returns an estimate without calling the agent', async () => {
    const res = await runConnectEnrich('task1', {
      websetId: 'ws1', providers: ['similarweb'], outputSchema: { type: 'object' },
      maxItems: 10, dryRun: true,
    }, fakeExa(), fakeStore()) as any;
    expect(res.dryRun).toBe(true);
    expect(res.estimatedCost).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('enriches items and persists Connect rows', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      id: 'agent_run_1', object: 'agent_run', status: 'completed',
      output: {
        structured: [
          { _itemId: 'item1', monthlyVisits: 100 },
          { _itemId: 'item2', monthlyVisits: 200 },
        ],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const res = await runConnectEnrich('task2', {
      websetId: 'ws1', providers: ['similarweb'], outputSchema: { type: 'object' },
      maxItems: 10,
    }, fakeExa(), fakeStore()) as any;

    expect(res.enriched).toBe(2);
    const rows = getDb().prepare('SELECT * FROM connect_enrichments').all() as any[];
    expect(rows.length).toBe(2);
    expect(JSON.parse(rows.find((r) => r.item_id === 'item2').structured).monthlyVisits).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflows/__tests__/connectEnrich.test.ts`
Expected: FAIL (`../connectEnrich.js` does not exist).

- [ ] **Step 3: Implement** — create `src/workflows/connectEnrich.ts`:

```ts
import type { Exa } from 'exa-js';
import type { TaskStore } from '../lib/taskStore.js';
import { registerWorkflow, type WorkflowMeta } from './types.js';
import { createStepTracker, isCancelled, collectItems, withSummary } from './helpers.js';
import { create as agentCreate } from '../handlers/agentRuns.js';
import { upsertItem, upsertConnectEnrichment, connectSchemaHash } from '../store/db.js';
import { PROVIDER_CATALOG } from '../handlers/connect.js';

function priceFor(provider: string): number {
  const p = PROVIDER_CATALOG.find((e) => e.id === provider);
  return p?.pricePerCall ?? 0.02; // conservative default when price unknown
}

function deriveDomain(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function itemRow(item: Record<string, unknown>): Record<string, unknown> {
  const props = (item.properties ?? {}) as Record<string, unknown>;
  const company = (props.company ?? {}) as Record<string, unknown>;
  const person = (props.person ?? {}) as Record<string, unknown>;
  return {
    _itemId: item.id,
    name: company.name ?? person.name ?? props.description,
    url: props.url,
    domain: deriveDomain(props.url),
  };
}

export async function runConnectEnrich(
  taskId: string,
  args: Record<string, unknown>,
  exa: Exa,
  store: TaskStore,
): Promise<unknown> {
  const tracker = createStepTracker();
  const websetId = args.websetId as string;
  if (!websetId) throw new Error('websetId is required');
  const providers = args.providers as string[];
  if (!Array.isArray(providers) || providers.length === 0) throw new Error('providers (string[]) is required');
  const outputSchema = args.outputSchema as Record<string, unknown>;
  if (!outputSchema) throw new Error('outputSchema is required');

  const requestedMax = (args.maxItems as number) ?? 50;
  const envCap = process.env.CONNECT_MAX_ITEMS ? parseInt(process.env.CONNECT_MAX_ITEMS, 10) : undefined;
  const maxItems = envCap && envCap < requestedMax ? envCap : requestedMax;
  const effort = (args.effort as string) ?? 'low';
  const batchSize = (args.batchSize as number) ?? 25;
  const dryRun = (args.dryRun as boolean) ?? false;
  const baseQuery = (args.query as string)
    ?? `Enrich each input row using the attached data partners. Return one structured object per row, echoing its _itemId.`;

  store.updateProgress(taskId, { step: 'loading webset', completed: 1, total: 4 });
  const webset = await exa.websets.get(websetId) as any;
  const entityType = webset?.searches?.[0]?.entity?.type ?? 'unknown';

  store.updateProgress(taskId, { step: 'collecting items', completed: 2, total: 4 });
  const allItems = await collectItems(exa, websetId, maxItems);
  const rows = allItems.map(itemRow).filter((r) => r._itemId);

  const perRowPrice = providers.reduce((sum, p) => sum + priceFor(p), 0);
  const estimatedCost = Math.round(perRowPrice * rows.length * 1000) / 1000;

  if (envCap && requestedMax > envCap) {
    store.updateProgress(taskId, { step: 'capped', message: `CONNECT_MAX_ITEMS=${envCap} capped ${requestedMax} items` });
  }
  store.updateProgress(taskId, {
    step: 'cost-estimate', message: `~$${estimatedCost} for ${rows.length} items × ${providers.length} provider(s) (Agent compute additional)`,
  });

  if (dryRun) {
    return withSummary({ websetId, providers, entityType, itemCount: rows.length, estimatedCost, dryRun: true },
      `Dry run: ~$${estimatedCost} across ${rows.length} items`);
  }
  if (rows.length === 0) {
    return withSummary({ websetId, providers, enriched: 0, failed: 0, costDollars: 0, runIds: [] }, 'No items to enrich');
  }

  store.updateProgress(taskId, { step: 'enriching', completed: 3, total: 4 });
  const dataSources = providers.map((provider) => ({ provider }));
  const schemaHash = connectSchemaHash(providers, outputSchema);
  const runIds: string[] = [];
  let enriched = 0;
  let failed = 0;
  let costDollars = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    if (isCancelled(taskId, store)) break;
    const batch = rows.slice(i, i + batchSize);
    try {
      const result = await agentCreate(
        { query: baseQuery, dataSources, outputSchema, input: { data: batch }, effort },
        exa,
        { silent: true } as any,
      );
      if (result.isError) { failed += batch.length; continue; }
      const run = JSON.parse(result.content[0].text);
      if (run.id) runIds.push(run.id);
      if (typeof run.costDollars === 'number') costDollars += run.costDollars;

      const structuredOut = run?.output?.structured;
      const outRows: Array<Record<string, unknown>> = Array.isArray(structuredOut) ? structuredOut : [];
      for (let j = 0; j < batch.length; j++) {
        const itemId = batch[j]._itemId as string;
        // Correlate by _itemId passthrough; fall back to positional order.
        const out = outRows.find((o) => o._itemId === itemId) ?? outRows[j];
        if (!out) { failed += 1; continue; }
        const src = allItems[i + j];
        const props = (src?.properties ?? {}) as Record<string, unknown>;
        upsertItem({
          id: itemId, websetId,
          name: (batch[j].name as string) ?? undefined,
          url: (props.url as string) ?? undefined,
          entityType,
        });
        const { _itemId, ...structured } = out;
        upsertConnectEnrichment({
          itemId, providers, query: baseQuery, schemaHash, structured,
          grounding: run?.output?.grounding, costDollars: run.costDollars, effort, runId: run.id,
        });
        enriched += 1;
      }
    } catch {
      failed += batch.length;
    }
  }

  store.updateProgress(taskId, { step: 'done', completed: 4, total: 4 });
  return withSummary(
    { websetId, providers, entityType, enriched, failed, estimatedCost, costDollars, runIds, dryRun: false },
    `Enriched ${enriched}/${rows.length} items via ${providers.join(', ')} (actual $${Math.round(costDollars * 1000) / 1000})`,
  );
}

const meta: WorkflowMeta = {
  title: 'Connect Enrich',
  description: 'Batch-enrich a webset\'s items with Exa Connect data partners (Similarweb, Fiber.ai, Baselayer, …). Runs one Agent call per batch via input.data, fuses partner + web data into your outputSchema, and persists results to the local store (connect_enrichments). Reports cost; honors CONNECT_MAX_ITEMS.',
  category: 'enrichment',
  parameters: [
    { name: 'websetId', type: 'string', required: true, description: 'Webset whose items to enrich' },
    { name: 'providers', type: 'array', required: true, description: 'Connect provider IDs (see connect.providers)' },
    { name: 'outputSchema', type: 'object', required: true, description: 'JSON Schema for the enrichment shape' },
    { name: 'query', type: 'string', required: false, description: 'Natural-language framing; sensible default if omitted' },
    { name: 'maxItems', type: 'number', required: false, description: 'Max items to enrich', default: 50 },
    { name: 'batchSize', type: 'number', required: false, description: 'Items per Agent run (input.data)', default: 25 },
    { name: 'effort', type: 'string', required: false, description: 'low|medium|high|xhigh|auto', default: 'low' },
    { name: 'dryRun', type: 'boolean', required: false, description: 'Return a cost estimate without spending', default: false },
  ],
  steps: [
    'Load webset metadata to determine entity type',
    'Collect items and build input.data rows (with _itemId passthrough)',
    'Estimate cost; if dryRun, stop and return the estimate',
    'Run the Agent per batch with dataSources + outputSchema; persist results via connect_enrichments',
  ],
  output: 'Webset ID, providers, entity type, enriched/failed counts, estimated vs actual cost, and run IDs.',
  example: `await callOperation('tasks.create', {\n  type: 'connect.enrich',\n  args: {\n    websetId: 'webset_abc',\n    providers: ['similarweb', 'fiber_ai'],\n    outputSchema: { type: 'object', properties: { monthlyVisits: { type: 'number' }, employee_count: { type: 'number' } } },\n    maxItems: 25,\n  }\n});`,
  relatedWorkflows: ['verify.enrichments'],
  tags: ['connect', 'enrichment', 'partners', 'similarweb', 'fiber', 'firmographics', 'cost'],
};

registerWorkflow('connect.enrich', runConnectEnrich, meta);
```

- [ ] **Step 4: Register the workflow** — in `src/workflows/index.ts`, add after the last import:

```ts
import './connectEnrich.js';
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/workflows/__tests__/connectEnrich.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/workflows/connectEnrich.ts src/workflows/index.ts src/workflows/__tests__/connectEnrich.test.ts
git commit -m "feat(connect): add connect.enrich batch workflow"
```

---

### Task 6: Build, full test sweep, and docs

**Files:**
- Modify: `CLAUDE.md` (Architecture Snapshot — note Connect)
- Verify: whole project compiles and tests pass

**Interfaces:** none (integration + docs).

- [ ] **Step 1: Type-check + build**

Run: `npm run build`
Expected: `tsc` exits 0 (no type errors).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS (all suites, including new Connect tests and `registry.test.ts`).

- [ ] **Step 3: Provider-ID gate (already verified 2026-06-26)** — the self-serve IDs were confirmed against the Connect partner docs: `financial_datasets` ✓, `particle_news` ✓, and `affiliate` (corrected from `affiliate_com`) ✓. No action needed unless Exa changes them; if re-checking, fetch `https://exa.ai/docs/reference/agent-api/connect/<partner>.md` and compare the `dataSources` example.

- [ ] **Step 4: Update CLAUDE.md** — under "Architecture Snapshot", add:

```markdown
- `src/handlers/connect.ts` exposes `connect.providers` (Exa Connect partner catalog). Connect itself is the `dataSources` param on `agentRuns.create`; `src/workflows/connectEnrich.ts` batch-enriches a webset and persists results via `store.attachConnect` (`connect_enrichments` table + `similarweb_v`/`firmographics_v` views).
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(connect): note Connect surface in architecture snapshot"
```

---

## Self-Review

**Spec coverage:**
- §3.1 agentRuns.create extension → Task 1 ✓
- §3.2 connect.providers catalog → Task 4 ✓
- §3.3 connect_enrichments table + views + attachConnect → Tasks 2, 3 ✓
- §3.4 connect.enrich workflow (input.data batching, dryRun, CONNECT_MAX_ITEMS, attach) → Task 5 ✓
- §4 typed-table resolution (generic table + views) → Task 2 ✓
- §5 cost posture (warn + proceed, env cap) → Task 5 (cost-estimate progress, envCap) ✓
- §6 provider catalog contents + verify-before-writing gate → Task 4 data + Task 6 Step 3 ✓
- §7 error handling (429/partial → try/catch per batch returns failed count; unknown itemId → Task 3; correlation via _itemId + positional fallback; idempotency via UNIQUE) ✓
- §8 testing → tests in every task ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. (Note: 429 backoff is implemented as per-batch try/catch that records `failed` rather than an explicit retry loop — the spec's "retry/backoff" is simplified to fail-soft for this increment; acceptable since runs are idempotent and re-runnable. Flag for reviewer.)

**Type consistency:** `connectSchemaHash(providers, schema)`, `upsertConnectEnrichment({...schemaHash})`, `attachConnect` args, and `runConnectEnrich(taskId, args, exa, store)` signatures match across Tasks 2–5. `PROVIDER_CATALOG` shape matches `connect.test.ts` assertions.
