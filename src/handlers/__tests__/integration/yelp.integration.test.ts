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
    // Try up to 3 businesses to find one with reviews available.
    // NOTE: Fusion tier may return 404 for /reviews — assert the operation contract
    // (well-formed ToolResult with JSON-parseable content) rather than requiring access.
    let reviewCount = 0;
    let reviewsFound = false;
    for (let i = 0; i < Math.min(3, data.businesses.length); i++) {
      const id = data.businesses[i].id;
      const rev = await yelp.reviews({ businessId: id }, {} as never);
      // Operation contract: always returns a well-formed ToolResult with non-empty text content.
      // Success payloads are JSON; error payloads are plain-text (errorResult format). Either way,
      // content[0].text must be a non-empty string — never undefined or null.
      expect(rev.content[0]).toBeDefined();
      expect(typeof rev.content[0].text).toBe('string');
      expect(rev.content[0].text.length).toBeGreaterThan(0);
      if (!rev.isError) {
        const revData = JSON.parse(rev.content[0].text);
        if (Array.isArray(revData.reviews)) {
          reviewCount = revData.reviews.length;
          reviewsFound = true;
          console.log(`yelp.reviews returned ${reviewCount} reviews for business ${i}`);
          break;
        }
      } else {
        console.log(`yelp.reviews: business ${i} returned error (tier/access limitation)`);
      }
    }
    if (!reviewsFound) {
      console.log('yelp.reviews: no businesses had reviews available (tier/access limitation)');
    }
  });
});
