# Yelp Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic Yelp Fusion enrichment capability — `yelp.*` operations plus a structured, queryable `yelp_businesses` store table — so an agent can match store items to Yelp businesses and navigate the local store by Yelp signal.

**Architecture:** A standalone Yelp HTTP client (`src/lib/yelp.ts`) backs five curated, atomic `yelp.*` operation handlers (`src/handlers/yelp.ts`) that return raw Yelp data. A new `yelp_businesses` table in the SQLite shadow store, with an `upsertYelpBusiness` DB function and a `store.attachYelp` write op, persists structured columns linked to a store item. All ops are registered in the `OPERATIONS` registry and become discoverable automatically via the catalog.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, better-sqlite3, vitest, `@modelcontextprotocol/sdk`.

## Global Constraints

- ESM imports use the `.js` extension on relative paths (e.g. `import { yelpGet } from '../lib/yelp.js'`).
- Operation handlers implement `OperationHandler = (args, exa, ctx?) => Promise<ToolResult>` from `src/handlers/types.js`; return via `successResult(data)` / `errorResult(operation, error)`.
- Operations are registered in `src/tools/operations.ts` in **both** `OPERATIONS` (handler + summary) and `OPERATION_SCHEMAS` (Zod schema). Validation runs at dispatch via `safeParse`.
- Yelp Fusion base URL: `https://api.yelp.com`; auth header `Authorization: Bearer ${YELP_API_KEY}`.
- Catalog discoverability is automatic from `OPERATIONS` — no `catalog.ts` edits; write clear summaries.
- Tests are vitest `*.test.ts`; `npm test` runs all. DB tests reset the singleton with `closeDb()` then `getDb(':memory:')`.
- Mock only the HTTP boundary (`fetch` / `yelpGet`). Never mock the DB — use in-memory SQLite.
- Follow existing project style (e.g. `args.x as string`); do not impose stricter global lint rules on this codebase.

---

### Task 1: Yelp HTTP client

**Files:**
- Create: `src/lib/yelp.ts`
- Test: `src/lib/__tests__/yelp.test.ts`

**Interfaces:**
- Consumes: `process.env.YELP_API_KEY`, global `fetch`.
- Produces:
  - `yelpGet(path: string, query?: Record<string, unknown>): Promise<unknown>` — authenticated GET; throws on missing key or non-2xx.
  - `class YelpError extends Error` with `status: number`, `endpoint: string`, `body: unknown`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/yelp.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { yelpGet, YelpError } from '../yelp.js';

describe('yelpGet', () => {
  const realKey = process.env.YELP_API_KEY;
  beforeEach(() => {
    process.env.YELP_API_KEY = 'test-key';
  });
  afterEach(() => {
    process.env.YELP_API_KEY = realKey;
    vi.unstubAllGlobals();
  });

  it('throws a clear error when YELP_API_KEY is missing', async () => {
    delete process.env.YELP_API_KEY;
    await expect(yelpGet('/v3/businesses/search')).rejects.toThrow(/YELP_API_KEY/);
  });

  it('builds the URL with query params and sets the bearer header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ businesses: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await yelpGet('/v3/businesses/search', { term: 'daycare', location: 'Austin, TX', limit: 5 });

    expect(result).toEqual({ businesses: [] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://api.yelp.com/v3/businesses/search');
    expect(url).toContain('term=daycare');
    expect(url).toContain('location=Austin%2C+TX');
    expect(url).toContain('limit=5');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(init.headers.Accept).toBe('application/json');
  });

  it('omits undefined/null query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    await yelpGet('/v3/businesses/search', { term: 'x', location: undefined });
    const [url] = fetchMock.mock.calls[0];
    expect(url).not.toContain('location=');
  });

  it('throws YelpError with status, endpoint, and body on non-2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'UNAUTHORIZED' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(yelpGet('/v3/businesses/search')).rejects.toMatchObject({
      name: 'YelpError',
      status: 401,
      endpoint: '/v3/businesses/search',
      body: { error: { code: 'UNAUTHORIZED' } },
    });
    expect(YelpError).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/yelp.test.ts`
Expected: FAIL — cannot resolve `../yelp.js` / `yelpGet is not defined`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/yelp.ts`:

```ts
// Yelp Fusion API client — authenticated GET access to business endpoints.
// Standalone (no handler logic) so a future OpenAPI generator can reuse it.

const YELP_BASE_URL = 'https://api.yelp.com';

export class YelpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'YelpError';
  }
}

function apiKey(): string {
  const key = process.env.YELP_API_KEY;
  if (!key) {
    throw new Error(
      'YELP_API_KEY is not set. Add it to your environment (.env) to use yelp.* operations.',
    );
  }
  return key;
}

export async function yelpGet(
  path: string,
  query: Record<string, unknown> = {},
): Promise<unknown> {
  const url = new URL(path, YELP_BASE_URL);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      Accept: 'application/json',
    },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new YelpError(
      `Yelp request failed (${res.status}) for ${path}`,
      res.status,
      path,
      body,
    );
  }
  return body;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/yelp.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/yelp.ts src/lib/__tests__/yelp.test.ts
git commit -m "feat(yelp): add Yelp Fusion HTTP client"
```

---

### Task 2: Yelp operation handlers

**Files:**
- Create: `src/handlers/yelp.ts`
- Test: `src/handlers/__tests__/yelp.test.ts`

**Interfaces:**
- Consumes: `yelpGet` (Task 1); `OperationHandler`, `successResult`, `errorResult` from `./types.js`.
- Produces (all `OperationHandler`): `search`, `phoneSearch`, `match`, `details`, `reviews`; and `Schemas` = `{ search, phoneSearch, match, details, reviews }` (Zod objects).

- [ ] **Step 1: Write the failing test**

Create `src/handlers/__tests__/yelp.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/yelp.js', () => ({
  yelpGet: vi.fn(),
}));

import { yelpGet } from '../../lib/yelp.js';
import * as yelp from '../yelp.js';

const mockGet = yelpGet as unknown as ReturnType<typeof vi.fn>;

describe('yelp handlers', () => {
  beforeEach(() => mockGet.mockReset());

  it('search calls /v3/businesses/search and wraps the result', async () => {
    mockGet.mockResolvedValue({ businesses: [{ id: 'b1' }] });
    const res = await yelp.search({ term: 'daycare', location: 'Austin, TX' }, {} as never);
    expect(mockGet).toHaveBeenCalledWith('/v3/businesses/search', { term: 'daycare', location: 'Austin, TX' });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toEqual({ businesses: [{ id: 'b1' }] });
  });

  it('phoneSearch calls /v3/businesses/search/phone', async () => {
    mockGet.mockResolvedValue({ businesses: [] });
    await yelp.phoneSearch({ phone: '+15125551234' }, {} as never);
    expect(mockGet).toHaveBeenCalledWith('/v3/businesses/search/phone', { phone: '+15125551234' });
  });

  it('match calls /v3/businesses/matches with the address fields', async () => {
    mockGet.mockResolvedValue({ businesses: [] });
    await yelp.match(
      { name: 'Bright Kids', address1: '1 Main St', city: 'Austin', state: 'TX', country: 'US' },
      {} as never,
    );
    expect(mockGet).toHaveBeenCalledWith('/v3/businesses/matches', {
      name: 'Bright Kids', address1: '1 Main St', city: 'Austin', state: 'TX', country: 'US',
    });
  });

  it('details interpolates the business id into the path', async () => {
    mockGet.mockResolvedValue({ id: 'abc' });
    await yelp.details({ businessId: 'abc-def' }, {} as never);
    expect(mockGet).toHaveBeenCalledWith('/v3/businesses/abc-def');
  });

  it('reviews interpolates the id and passes query params', async () => {
    mockGet.mockResolvedValue({ reviews: [] });
    await yelp.reviews({ businessId: 'abc-def', limit: 3 }, {} as never);
    expect(mockGet).toHaveBeenCalledWith('/v3/businesses/abc-def/reviews', { limit: 3 });
  });

  it('returns an error result when yelpGet throws', async () => {
    mockGet.mockRejectedValue(new Error('boom'));
    const res = await yelp.search({ term: 'x', location: 'y' }, {} as never);
    expect(res.isError).toBe(true);
  });

  it('schema rejects search with neither location nor coordinates', () => {
    expect(yelp.Schemas.search.safeParse({ term: 'daycare' }).success).toBe(false);
    expect(yelp.Schemas.search.safeParse({ term: 'daycare', location: 'Austin' }).success).toBe(true);
    expect(yelp.Schemas.search.safeParse({ latitude: 30.2, longitude: -97.7 }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/handlers/__tests__/yelp.test.ts`
Expected: FAIL — cannot resolve `../yelp.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/handlers/yelp.ts`:

```ts
// Yelp Fusion operations — curated, atomic wrappers over the business
// discovery endpoints. Handlers return raw Yelp data; the agent decides which
// match to persist via store.attachYelp.

import { z } from 'zod';
import type { OperationHandler } from './types.js';
import { successResult, errorResult } from './types.js';
import { yelpGet } from '../lib/yelp.js';

export const Schemas = {
  search: z
    .object({
      term: z.string().optional(),
      location: z.string().optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      radius: z.number().int().min(1).max(40000).optional(),
      categories: z.string().optional(),
      price: z.string().optional(),
      open_now: z.boolean().optional(),
      sort_by: z.enum(['best_match', 'rating', 'review_count', 'distance']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .refine(
      (v) => Boolean(v.location) || (v.latitude !== undefined && v.longitude !== undefined),
      { message: 'yelp.search requires either `location` or both `latitude` and `longitude`.' },
    ),
  phoneSearch: z.object({ phone: z.string() }),
  match: z.object({
    name: z.string(),
    address1: z.string(),
    city: z.string(),
    state: z.string(),
    country: z.string(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
  }),
  details: z.object({ businessId: z.string() }),
  reviews: z.object({
    businessId: z.string(),
    limit: z.number().int().min(1).max(50).optional(),
    sort_by: z.enum(['yelp_sort', 'newest']).optional(),
  }),
};

export const search: OperationHandler = async (args) => {
  try {
    return successResult(await yelpGet('/v3/businesses/search', args));
  } catch (error) {
    return errorResult('yelp.search', error);
  }
};

export const phoneSearch: OperationHandler = async (args) => {
  try {
    return successResult(await yelpGet('/v3/businesses/search/phone', { phone: args.phone }));
  } catch (error) {
    return errorResult('yelp.phoneSearch', error);
  }
};

export const match: OperationHandler = async (args) => {
  try {
    return successResult(await yelpGet('/v3/businesses/matches', args));
  } catch (error) {
    return errorResult('yelp.match', error);
  }
};

export const details: OperationHandler = async (args) => {
  try {
    const id = encodeURIComponent(args.businessId as string);
    return successResult(await yelpGet(`/v3/businesses/${id}`));
  } catch (error) {
    return errorResult('yelp.details', error);
  }
};

export const reviews: OperationHandler = async (args) => {
  try {
    const id = encodeURIComponent(args.businessId as string);
    const { businessId: _omit, ...query } = args;
    return successResult(await yelpGet(`/v3/businesses/${id}/reviews`, query));
  } catch (error) {
    return errorResult('yelp.reviews', error);
  }
};
```

Note: `details`/`reviews` use `encodeURIComponent`, so the test's plain `abc-def` id (no special chars) matches `/v3/businesses/abc-def` exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/handlers/__tests__/yelp.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/handlers/yelp.ts src/handlers/__tests__/yelp.test.ts
git commit -m "feat(yelp): add curated yelp.* operation handlers"
```

---

### Task 3: Store table + upsertYelpBusiness

**Files:**
- Modify: `src/store/db.ts` (add table to `initSchema` ~line 137; add `upsertYelpBusiness` + `YelpBusinessRecord`)
- Test: `src/store/__tests__/yelpBusinesses.test.ts`

**Interfaces:**
- Consumes: `getDb`, `closeDb`, `upsertItem` from `./db.js`.
- Produces:
  - `interface YelpBusinessRecord { yelpId: string; itemId?: string; name?: string; rating?: number; reviewCount?: number; price?: string; phone?: string; displayAddress?: string; latitude?: number; longitude?: number; url?: string; categories?: unknown; raw?: unknown; }`
  - `upsertYelpBusiness(rec: YelpBusinessRecord): void`

- [ ] **Step 1: Write the failing test**

Create `src/store/__tests__/yelpBusinesses.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, upsertItem, upsertYelpBusiness } from '../db.js';

describe('yelp_businesses store', () => {
  beforeEach(() => {
    closeDb();
    getDb(':memory:');
  });
  afterEach(() => closeDb());

  it('inserts a yelp business with mapped columns', () => {
    upsertYelpBusiness({
      yelpId: 'y1', name: 'Bright Kids', rating: 4.7, reviewCount: 52,
      price: '$$', phone: '+15125551234', displayAddress: '1 Main St, Austin, TX',
      latitude: 30.2, longitude: -97.7, url: 'https://yelp.com/biz/y1',
      categories: [{ alias: 'childcare', title: 'Child Care' }], raw: { id: 'y1' },
    });
    const rows = getDb().prepare('SELECT * FROM yelp_businesses WHERE yelp_id = ?').all('y1');
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).rating).toBe(4.7);
    expect((rows[0] as any).review_count).toBe(52);
    expect(JSON.parse((rows[0] as any).categories)[0].alias).toBe('childcare');
  });

  it('upsert on the same yelp_id updates rather than duplicating', () => {
    upsertYelpBusiness({ yelpId: 'y1', name: 'Old', rating: 3.0 });
    upsertYelpBusiness({ yelpId: 'y1', name: 'New', rating: 4.5 });
    const rows = getDb().prepare('SELECT * FROM yelp_businesses').all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).name).toBe('New');
    expect((rows[0] as any).rating).toBe(4.5);
  });

  it('links to a store item and supports the navigability JOIN', () => {
    upsertItem({ id: 'item1', websetId: 'ws1', name: 'Bright Kids Daycare' });
    upsertYelpBusiness({ yelpId: 'y1', itemId: 'item1', name: 'Bright Kids', rating: 4.7, reviewCount: 52 });
    const rows = getDb().prepare(`
      SELECT i.name AS item_name, y.rating, y.review_count
      FROM items i JOIN yelp_businesses y ON y.item_id = i.id
      WHERE y.rating > 4.5 AND y.review_count > 50
      ORDER BY y.rating DESC
    `).all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).item_name).toBe('Bright Kids Daycare');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/__tests__/yelpBusinesses.test.ts`
Expected: FAIL — `upsertYelpBusiness` is not exported.

- [ ] **Step 3a: Add the table to `initSchema`**

In `src/store/db.ts`, inside the `db.exec(\`...\`)` template in `initSchema` (after the `notebooks` table, before the closing `` ` ``), add:

```sql
    CREATE TABLE IF NOT EXISTS yelp_businesses (
      yelp_id TEXT PRIMARY KEY,
      item_id TEXT,
      name TEXT,
      rating REAL,
      review_count INTEGER,
      price TEXT,
      phone TEXT,
      display_address TEXT,
      latitude REAL,
      longitude REAL,
      url TEXT,
      categories JSON,
      raw JSON,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_yelp_item ON yelp_businesses(item_id);
    CREATE INDEX IF NOT EXISTS idx_yelp_rating ON yelp_businesses(rating);
```

`item_id` intentionally has no FK constraint — Yelp rows may exist before/without a synced item (Webset-agnostic).

- [ ] **Step 3b: Add the record type + upsert function**

Append to `src/store/db.ts`:

```ts
export interface YelpBusinessRecord {
  yelpId: string;
  itemId?: string;
  name?: string;
  rating?: number;
  reviewCount?: number;
  price?: string;
  phone?: string;
  displayAddress?: string;
  latitude?: number;
  longitude?: number;
  url?: string;
  categories?: unknown;
  raw?: unknown;
}

export function upsertYelpBusiness(rec: YelpBusinessRecord): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO yelp_businesses
      (yelp_id, item_id, name, rating, review_count, price, phone,
       display_address, latitude, longitude, url, categories, raw, fetched_at)
    VALUES
      (@yelpId, @itemId, @name, @rating, @reviewCount, @price, @phone,
       @displayAddress, @latitude, @longitude, @url, @categories, @raw, datetime('now'))
    ON CONFLICT(yelp_id) DO UPDATE SET
      item_id = excluded.item_id,
      name = excluded.name,
      rating = excluded.rating,
      review_count = excluded.review_count,
      price = excluded.price,
      phone = excluded.phone,
      display_address = excluded.display_address,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      url = excluded.url,
      categories = excluded.categories,
      raw = excluded.raw,
      fetched_at = datetime('now')
  `).run({
    yelpId: rec.yelpId,
    itemId: rec.itemId ?? null,
    name: rec.name ?? null,
    rating: rec.rating ?? null,
    reviewCount: rec.reviewCount ?? null,
    price: rec.price ?? null,
    phone: rec.phone ?? null,
    displayAddress: rec.displayAddress ?? null,
    latitude: rec.latitude ?? null,
    longitude: rec.longitude ?? null,
    url: rec.url ?? null,
    categories: rec.categories != null ? JSON.stringify(rec.categories) : null,
    raw: rec.raw != null ? JSON.stringify(rec.raw) : null,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/__tests__/yelpBusinesses.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts src/store/__tests__/yelpBusinesses.test.ts
git commit -m "feat(store): add yelp_businesses table and upsertYelpBusiness"
```

---

### Task 4: store.attachYelp write operation

**Files:**
- Modify: `src/store/operations.ts` (add `attachYelp` to `Schemas`; import `upsertYelpBusiness as dbUpsertYelpBusiness`; export `attachYelp` handler)
- Test: `src/store/__tests__/attachYelp.test.ts`

**Interfaces:**
- Consumes: `upsertYelpBusiness` (Task 3); `successResult`, `errorResult`, `OperationHandler`.
- Produces: `attachYelp: OperationHandler`; `Schemas.attachYelp = z.object({ itemId: z.string(), yelp: z.record(z.unknown()) })`.

- [ ] **Step 1: Write the failing test**

Create `src/store/__tests__/attachYelp.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, upsertItem } from '../db.js';
import { attachYelp } from '../operations.js';

const sampleBusiness = {
  id: 'WavvLdfdP6g8aZTtbBQHTw',
  name: 'Bright Kids',
  rating: 4.7,
  review_count: 52,
  price: '$$',
  phone: '+15125551234',
  url: 'https://www.yelp.com/biz/bright-kids',
  coordinates: { latitude: 30.27, longitude: -97.74 },
  location: { display_address: ['1 Main St', 'Austin, TX 78701'] },
  categories: [{ alias: 'childcare', title: 'Child Care & Day Care' }],
};

describe('store.attachYelp', () => {
  beforeEach(() => {
    closeDb();
    getDb(':memory:');
    upsertItem({ id: 'item1', websetId: 'ws1', name: 'Bright Kids Daycare' });
  });
  afterEach(() => closeDb());

  it('maps a Yelp business object into the table linked to the item', async () => {
    const res = await attachYelp({ itemId: 'item1', yelp: sampleBusiness }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toMatchObject({ attached: true, itemId: 'item1' });

    const row = getDb().prepare('SELECT * FROM yelp_businesses WHERE item_id = ?').get('item1') as any;
    expect(row.yelp_id).toBe('WavvLdfdP6g8aZTtbBQHTw');
    expect(row.rating).toBe(4.7);
    expect(row.review_count).toBe(52);
    expect(row.display_address).toBe('1 Main St, Austin, TX 78701');
    expect(row.latitude).toBe(30.27);
  });

  it('errors when the yelp object has no id', async () => {
    const res = await attachYelp({ itemId: 'item1', yelp: { name: 'No Id' } }, {} as never);
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/__tests__/attachYelp.test.ts`
Expected: FAIL — `attachYelp` is not exported from `../operations.js`.

- [ ] **Step 3a: Import the DB function**

In `src/store/operations.ts`, add `upsertYelpBusiness as dbUpsertYelpBusiness` to the existing import block from `./db.js`.

- [ ] **Step 3b: Add the schema**

In the `Schemas` object in `src/store/operations.ts`, add:

```ts
  attachYelp: z.object({
    itemId: z.string(),
    yelp: z.record(z.unknown()),
  }),
```

- [ ] **Step 3c: Add the handler**

Append to `src/store/operations.ts`:

```ts
export const attachYelp: OperationHandler = async (args) => {
  try {
    const itemId = args.itemId as string;
    const y = args.yelp as Record<string, unknown>;
    const yelpId = y.id as string | undefined;
    if (!yelpId) {
      throw new Error('attachYelp: yelp object is missing required `id` field');
    }
    const loc = (y.location ?? {}) as Record<string, unknown>;
    const coords = (y.coordinates ?? {}) as Record<string, unknown>;
    const displayAddress = Array.isArray(loc.display_address)
      ? (loc.display_address as string[]).join(', ')
      : undefined;

    dbUpsertYelpBusiness({
      yelpId,
      itemId,
      name: y.name as string | undefined,
      rating: y.rating as number | undefined,
      reviewCount: y.review_count as number | undefined,
      price: y.price as string | undefined,
      phone: y.phone as string | undefined,
      displayAddress,
      latitude: coords.latitude as number | undefined,
      longitude: coords.longitude as number | undefined,
      url: y.url as string | undefined,
      categories: y.categories,
      raw: y,
    });
    return successResult({ yelpId, itemId, attached: true });
  } catch (error) {
    return errorResult('store.attachYelp', error);
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/__tests__/attachYelp.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/operations.ts src/store/__tests__/attachYelp.test.ts
git commit -m "feat(store): add store.attachYelp write operation"
```

---

### Task 5: Register operations + config

**Files:**
- Modify: `src/tools/operations.ts` (import yelp handlers; add 5 `yelp.*` + `store.attachYelp` to `OPERATIONS` and `OPERATION_SCHEMAS`)
- Modify: `src/handlers/__tests__/registry.test.ts` (assert yelp exports)
- Modify: `docker-compose.yml` (pass `YELP_API_KEY`)
- Test: existing `src/handlers/__tests__/registry.test.ts` + a dispatch assertion

**Interfaces:**
- Consumes: `yelp.*` handlers + `Schemas` (Task 2); `store.attachYelp` + `Schemas.attachYelp` (Task 4).
- Produces: registry entries `yelp.search`, `yelp.phoneSearch`, `yelp.match`, `yelp.details`, `yelp.reviews`, `store.attachYelp` resolvable through `OPERATIONS` / `OPERATION_SCHEMAS`.

- [ ] **Step 1: Write the failing test**

Add to `src/handlers/__tests__/registry.test.ts` (new `describe` block; adjust the relative import depth — this file is in `src/handlers/__tests__/`, so use `../../tools/operations.js`):

```ts
import { OPERATIONS, OPERATION_SCHEMAS } from '../../tools/operations.js';
import * as yelp from '../yelp.js';

describe('yelp operations are registered', () => {
  it('yelp module exports 5 handlers', () => {
    expect(typeof yelp.search).toBe('function');
    expect(typeof yelp.phoneSearch).toBe('function');
    expect(typeof yelp.match).toBe('function');
    expect(typeof yelp.details).toBe('function');
    expect(typeof yelp.reviews).toBe('function');
  });

  it('registry exposes yelp.* and store.attachYelp with schemas', () => {
    for (const name of ['yelp.search', 'yelp.phoneSearch', 'yelp.match', 'yelp.details', 'yelp.reviews', 'store.attachYelp']) {
      expect(OPERATIONS[name], `missing OPERATIONS[${name}]`).toBeDefined();
      expect(OPERATION_SCHEMAS[name], `missing OPERATION_SCHEMAS[${name}]`).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/handlers/__tests__/registry.test.ts`
Expected: FAIL — `OPERATIONS['yelp.search']` is undefined.

- [ ] **Step 3a: Import the yelp handler module**

In `src/tools/operations.ts`, with the other handler imports, add:

```ts
import * as yelp from '../handlers/yelp.js';
```

- [ ] **Step 3b: Register handlers in `OPERATIONS`**

In the `OPERATIONS` object, after the `store.*` entries, add:

```ts
  'yelp.search': { handler: yelp.search, summary: 'Search Yelp businesses by term and location (rating, reviews, price)' },
  'yelp.phoneSearch': { handler: yelp.phoneSearch, summary: 'Find Yelp businesses by phone number' },
  'yelp.match': { handler: yelp.match, summary: 'Match a business on Yelp by name and address' },
  'yelp.details': { handler: yelp.details, summary: 'Get full Yelp business details by id or alias' },
  'yelp.reviews': { handler: yelp.reviews, summary: 'Get Yelp review excerpts for a business' },
  'store.attachYelp': { handler: store.attachYelp, summary: 'Attach a Yelp business to a local item (structured, queryable)' },
```

- [ ] **Step 3c: Register schemas in `OPERATION_SCHEMAS`**

In the `OPERATION_SCHEMAS` object, after the `store.*` schema entries, add:

```ts
  'yelp.search': yelp.Schemas.search,
  'yelp.phoneSearch': yelp.Schemas.phoneSearch,
  'yelp.match': yelp.Schemas.match,
  'yelp.details': yelp.Schemas.details,
  'yelp.reviews': yelp.Schemas.reviews,
  'store.attachYelp': store.Schemas.attachYelp,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/handlers/__tests__/registry.test.ts`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 5: Add YELP_API_KEY to docker-compose**

In `docker-compose.yml`, under the existing `environment:` block (after `- EXA_API_KEY=${EXA_API_KEY}`), add:

```yaml
      - YELP_API_KEY=${YELP_API_KEY}
```

- [ ] **Step 6: Full build + test sweep**

Run: `npm run build && npm test`
Expected: type-check clean; all tests pass (including the new yelp/store/registry tests).

- [ ] **Step 7: Commit**

```bash
git add src/tools/operations.ts src/handlers/__tests__/registry.test.ts docker-compose.yml
git commit -m "feat(yelp): register yelp.* ops and store.attachYelp; pass YELP_API_KEY in docker"
```

---

### Task 6: Live integration test (guarded) + docs

**Files:**
- Create: `src/handlers/__tests__/integration/yelp.integration.test.ts`
- Modify: `CLAUDE.md` (Architecture Snapshot — note the Yelp layer)

**Interfaces:**
- Consumes: real Yelp API via `yelp.search` when `YELP_API_KEY` is present.

- [ ] **Step 1: Write the guarded integration test**

Create `src/handlers/__tests__/integration/yelp.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as yelp from '../../yelp.js';

const hasKey = Boolean(process.env.YELP_API_KEY);
const maybe = hasKey ? describe : describe.skip;

maybe('yelp.search (live)', () => {
  it('returns businesses for a real query and confirms /reviews tier behavior', async () => {
    const res = await yelp.search({ term: 'daycare', location: 'Austin, TX', limit: 3 }, {} as never);
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].text);
    expect(Array.isArray(data.businesses)).toBe(true);
    expect(data.businesses.length).toBeGreaterThan(0);
    expect(data.businesses[0]).toHaveProperty('id');

    // Resolve open verification item: confirm reviews endpoint shape/tier limit.
    const id = data.businesses[0].id;
    const rev = await yelp.reviews({ businessId: id }, {} as never);
    const revData = JSON.parse(rev.content[0].text);
    // Document, don't assert a hard cap — log what the tier returns.
    console.log('yelp.reviews returned', Array.isArray(revData.reviews) ? revData.reviews.length : 'n/a', 'reviews');
    expect(rev.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/handlers/__tests__/integration/yelp.integration.test.ts`
Expected: with `YELP_API_KEY` set in the shell/`.env` → PASS (1 test) and a logged review count; without the key → the suite is skipped (0 failures). Use the review-count log to finalize the `yelp.reviews` summary wording if needed.

- [ ] **Step 3: Update CLAUDE.md**

In `CLAUDE.md` under "Architecture Snapshot", add a bullet:

```markdown
- `src/lib/yelp.ts` Yelp Fusion HTTP client; `src/handlers/yelp.ts` exposes `yelp.*` business-discovery ops, persisted to the local store via `store.attachYelp` (`yelp_businesses` table).
```

- [ ] **Step 4: Commit**

```bash
git add src/handlers/__tests__/integration/yelp.integration.test.ts CLAUDE.md
git commit -m "test(yelp): add guarded live integration test; document Yelp layer"
```

---

## Self-Review

**Spec coverage:**
- Component 1 (client) → Task 1. ✓
- Component 2 (5 ops + schemas) → Task 2. ✓
- Component 3 (table + write op) → Tasks 3 (table/`upsertYelpBusiness`) + 4 (`store.attachYelp`). ✓
- Component 4 (registry wiring + config) → Task 5. ✓
- Discoverability (automatic via catalog) → covered by Task 5 summaries; no code needed. ✓
- Testing (unit + guarded integration) → Tasks 1-4 (unit) + Task 6 (integration). ✓
- Open verification items (reviews tier, search limits) → Task 6 live test logs review count; `search`/`reviews` schemas bound `limit` to 50. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; no "similar to Task N" references. ✓

**Type consistency:** `yelpGet(path, query?)` used identically in Tasks 1-2. `YelpBusinessRecord` field names (`yelpId`, `reviewCount`, `displayAddress`) match between Task 3 definition and Task 4 mapping. `Schemas.attachYelp` defined in Task 4, referenced in Task 5. `yelp.Schemas.*` defined in Task 2, referenced in Task 5. Handler arity `(args, exa)` matches `OperationHandler` across all tasks. ✓

**Non-goals respected:** No Twilio/outreach, no OpenAPI generator, no daycare-specific logic, no partner/reseller endpoints. ✓
