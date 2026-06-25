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
