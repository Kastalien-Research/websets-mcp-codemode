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
    mockGet.mockRejectedValueOnce(new Error('boom'));
    const res = await yelp.search({ term: 'x', location: 'y' }, {} as never);
    expect(res.isError).toBe(true);
  });

  it('schema rejects search with neither location nor coordinates', () => {
    expect(yelp.Schemas.search.safeParse({ term: 'daycare' }).success).toBe(false);
    expect(yelp.Schemas.search.safeParse({ term: 'daycare', location: 'Austin' }).success).toBe(true);
    expect(yelp.Schemas.search.safeParse({ latitude: 30.2, longitude: -97.7 }).success).toBe(true);
  });
});
