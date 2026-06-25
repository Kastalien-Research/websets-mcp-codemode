# Yelp Enrichment — Live Verification Runbook

**Audience:** a Claude Code instance with the MCP server connected (tools `status`,
`search`, `execute`). Runs **for real** against the live Exa Websets + Yelp Fusion
APIs. No curl — everything goes through `execute` + `callOperation()`, the Code
Mode pattern this server is built on.

**Goal:** exercise every piece of the Yelp enrichment feature end to end:
the five `yelp.*` ops, the `store.attachYelp` write, and the navigability JOIN —
then the full pipeline (Webset → enrich → shortlist) on the daycare use case.

**Prereqs:** server running with `EXA_API_KEY` and `YELP_API_KEY` set in its
environment (via `.env` → docker-compose). Confirm with Phase 0.

---

## Conventions & gotchas (read first — these were learned from a real run)

1. **`callOperation(name, args)` returns parsed data directly** on success — NOT
   the `{content:[{text}]}` ToolResult wrapper. Use `result.businesses`, not
   `result.content[0].text`. On an operation error it **throws**; wrap in
   try/catch when you expect a failure (e.g. tier-limited `yelp.reviews`).
2. **Constrain Yelp search with `categories`, not just `term`.** `term: 'daycare'`
   with `sort_by: 'rating'` surfaced a cleaning service and a dog trainer. Adding
   `categories: 'childcare'` returns actual daycares. Free-text term is loose.
3. **`yelp.reviews` returns 404 on the current Fusion tier** (no reviews access).
   That is the documented tier limit, not a bug — the op surfaces a clean,
   well-formed error. Treat a 404 here as PASS-with-tier-note.
4. **`yelp.match` returns business identity** (id, name, address) but not rating /
   review_count. Call `yelp.details` with the matched id for the full record.
5. **No store-delete op exists.** Rows written by `store.syncItem` /
   `store.attachYelp` persist. Use a dedicated `websetId` namespace (e.g.
   `verify-yelp-<timestamp>`) so verification data is identifiable and isolated
   from real runs.

---

## Phase 0 — Orient & discoverability

Call the `status` tool. Expect `capabilities.operationCount` to be **102** and
`tools` = `[search, execute, status]`.

Call the `search` tool with `query: "yelp business rating reviews"`. Expect all
six entries: `yelp.search`, `yelp.phoneSearch`, `yelp.match`, `yelp.details`,
`yelp.reviews`, `store.attachYelp`.

> Known cosmetic gap: `yelp.search` shows `params: []` in `search` results because
> its Zod schema uses `.refine()`, which the catalog introspector can't read
> through. The op still works; the params just aren't auto-listed. (Tracked as a
> follow-up.)

**PASS:** operationCount 102; all six ops listed.

---

## Phase 1 — Yelp operations, direct

```js
// All five yelp.* ops + the schema refinement guard.
const out = {};

// search (category-constrained for precision)
const search = await callOperation('yelp.search', {
  term: 'daycare', location: 'Austin, TX', categories: 'childcare',
  limit: 5, sort_by: 'rating',
});
const biz = search.businesses || [];
out.searchNames = biz.map(b => b.name);
const top = biz[0];

// details (full record incl. rating)
const details = await callOperation('yelp.details', { businessId: top.id });
out.detailsName = details.name;
out.detailsRating = details.rating;

// reviews (EXPECTED 404 on current tier — caught, not fatal)
try {
  const r = await callOperation('yelp.reviews', { businessId: top.id, limit: 3 });
  out.reviews = Array.isArray(r.reviews) ? `${r.reviews.length} reviews` : 'no array';
} catch (e) {
  out.reviews = `tier-limited (expected): ${String(e).split('\n')[0]}`;
}

// phoneSearch round-trip
if (top.phone) {
  const ps = await callOperation('yelp.phoneSearch', { phone: top.phone });
  out.phoneRoundTrip = (ps.businesses || []).map(b => b.name);
}

// match → identity, then details for full record
const m = await callOperation('yelp.match', {
  name: top.name.replace(/-.*$/, '').trim(),
  address1: top.location?.address1 || top.location?.display_address?.[0] || '',
  city: top.location?.city || 'Austin', state: top.location?.state || 'TX',
  country: top.location?.country || 'US',
});
out.matchId = (m.businesses || [])[0]?.id || 'no match';

// negative: refinement rejects search with neither location nor coords
try { await callOperation('yelp.search', { term: 'daycare' }); out.refine = 'NOT rejected (FAIL)'; }
catch (e) { out.refine = String(e).includes('requires either') ? 'rejected (PASS)' : `rejected: ${e}`; }

return out;
```

**PASS:** `searchNames` are real childcare businesses; `detailsRating` is a number;
`reviews` is the tier-limited note; `phoneRoundTrip` finds the same business;
`matchId` is a Yelp id; `refine` = `rejected (PASS)`.

---

## Phase 2 — Store path: sync → attach → navigable JOIN

```js
const ts = Date.now();                       // pass a literal in if your sandbox blocks Date.now
const websetId = `verify-yelp-${ts}`;
const search = await callOperation('yelp.search', {
  term: 'daycare', location: 'Austin, TX', categories: 'childcare', limit: 5, sort_by: 'rating',
});
const biz = search.businesses || [];

const attached = [];
for (let i = 0; i < Math.min(3, biz.length); i++) {
  const b = biz[i];
  const itemId = `${websetId}-item-${i}`;
  await callOperation('store.syncItem', { id: itemId, websetId, name: b.name, url: b.url, entityType: 'company' });
  await callOperation('store.attachYelp', { itemId, yelp: b });
  attached.push(itemId);
}

// The navigability payoff: SQL filter + sort over enriched data
const q = await callOperation('store.query', {
  sql: `SELECT i.name AS item_name, y.rating, y.review_count, y.phone, y.display_address
        FROM items i JOIN yelp_businesses y ON y.item_id = i.id
        WHERE i.webset_id = ? AND y.rating >= 4 AND y.review_count >= 5
        ORDER BY y.rating DESC, y.review_count DESC`,
  params: [websetId],
});

// idempotency: re-attaching the same business must not duplicate
await callOperation('store.attachYelp', { itemId: attached[0], yelp: biz[0] });
const dupCheck = await callOperation('store.query', {
  sql: `SELECT COUNT(*) AS n FROM yelp_businesses WHERE item_id = ?`, params: [attached[0]],
});

return { websetId, attachedCount: attached.length, shortlist: q.rows, shortlistCount: q.count, dupCount: dupCheck.rows[0].n };
```

**PASS:** `attachedCount` = 3; `shortlist` rows carry rating/review_count/phone from
Yelp joined to the synced items, rating-sorted; `dupCount` = 1 (idempotent upsert).

---

## Phase 3 — Full pipeline on a real Webset (the actual use case)

This is the end-to-end the feature exists for. It creates a **small** real Webset
to limit credits/time.

```js
// 1. Build a Webset of daycares in a target area
const ws = await callOperation('websets.create', {
  searchQuery: 'licensed daycare / childcare centers in Austin, TX',
  entity: { type: 'company' },
  count: 8,
});
await callOperation('websets.waitUntilIdle', { websetId: ws.id, timeoutMs: 90000 });
const items = await callOperation('items.getAll', { websetId: ws.id });

// 2. Mirror each into the local store, then enrich from Yelp
const enriched = [];
for (const it of items) {
  await callOperation('store.syncItem', {
    id: it.id, websetId: ws.id,
    name: it.properties?.company?.name || it.properties?.name || it.title,
    url: it.properties?.url || it.url, entityType: 'company',
  });
  const name = it.properties?.company?.name || it.properties?.name || it.title;
  // Prefer a precise match; fall back to category-constrained search.
  let chosen = null;
  try {
    const m = await callOperation('yelp.match', {
      name, address1: '', city: 'Austin', state: 'TX', country: 'US',
    });
    chosen = (m.businesses || [])[0] || null;
  } catch (_) {}
  if (!chosen) {
    const s = await callOperation('yelp.search', {
      term: name, location: 'Austin, TX', categories: 'childcare', limit: 1,
    });
    chosen = (s.businesses || [])[0] || null;
  }
  if (chosen) {
    // match returns identity only — hydrate the full record for rating/reviews
    const full = await callOperation('yelp.details', { businessId: chosen.id });
    await callOperation('store.attachYelp', { itemId: it.id, yelp: full });
    enriched.push({ item: name, yelp: full.name, rating: full.rating });
  }
}

// 3. Shortlist on enriched signal
const shortlist = await callOperation('store.query', {
  sql: `SELECT i.name, y.rating, y.review_count, y.phone, y.display_address, y.url
        FROM items i JOIN yelp_businesses y ON y.item_id = i.id
        WHERE i.webset_id = ? AND y.rating >= 4.5
        ORDER BY y.rating DESC, y.review_count DESC`,
  params: [ws.id],
});

return { websetId: ws.id, itemCount: items.length, enrichedCount: enriched.length, shortlist: shortlist.rows };
```

**PASS:** Webset reaches idle and yields items; a meaningful fraction enrich from
Yelp (matching is fuzzy — not every Webset business is on Yelp or matches cleanly,
which is expected and is why matching is agent-driven); the shortlist is a
rating-sorted, phone-bearing list of high-quality daycares.

> Matching is honest about fuzziness by design: ops return candidates, the agent
> decides, and only `store.attachYelp` commits. A low match rate is a data-reality
> signal, not a defect — record it.

---

## Phase 4 — Outreach handoff (out of scope here)

The Phase 3 shortlist (name + phone + address) is exactly the input the future
Twilio/email outreach subsystem will consume. No outreach ops exist yet — that is
a separate spec. Stop at the shortlist.

---

## Pass/fail checklist

- [ ] Phase 0: operationCount 102; all six ops discoverable
- [ ] Phase 1: search/details/phoneSearch/match succeed; reviews 404 (tier note); refinement rejects
- [ ] Phase 2: attach writes; JOIN returns rating-sorted shortlist; re-attach is idempotent (dupCount 1)
- [ ] Phase 3: Webset → idle → items; Yelp enrichment attaches; shortlist query returns high-rated daycares
- [ ] No uncaught exceptions except the deliberately caught reviews 404

## Known limitations to report, not fail on

- `yelp.reviews` → 404 (Fusion tier has no reviews access)
- `yelp.match` omits rating/review_count (hydrate via `yelp.details`)
- No store-delete op (verification rows persist; isolated by `websetId` namespace)
- `yelp.search` params not auto-listed in `search` tool (Zod `.refine()` opacity)
