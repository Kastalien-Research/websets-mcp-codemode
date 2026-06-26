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
