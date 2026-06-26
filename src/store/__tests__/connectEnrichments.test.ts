import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, upsertItem, upsertConnectEnrichment, connectSchemaHash } from '../db.js';
import { attachConnect } from '../operations.js';

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
