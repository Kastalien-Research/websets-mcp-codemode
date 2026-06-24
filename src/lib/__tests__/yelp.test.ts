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
