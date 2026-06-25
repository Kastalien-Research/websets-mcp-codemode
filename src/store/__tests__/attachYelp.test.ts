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

  it('errors when the item does not exist (no orphan row written)', async () => {
    const res = await attachYelp({ itemId: 'ghost-item', yelp: sampleBusiness }, {} as never);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('ghost-item');
    const row = getDb()
      .prepare('SELECT * FROM yelp_businesses WHERE yelp_id = ?')
      .get('WavvLdfdP6g8aZTtbBQHTw');
    expect(row).toBeUndefined();
  });
});
