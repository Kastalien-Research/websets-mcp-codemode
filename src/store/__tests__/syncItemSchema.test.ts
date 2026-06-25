import { describe, it, expect } from 'vitest';
import { Schemas } from '../operations.js';

describe('store.syncItem schema — enrichments shape', () => {
  const base = { id: 'witem_1', websetId: 'ws_1', name: 'Acme' };

  it('accepts record-shaped enrichments (raw Exa items)', () => {
    const r = Schemas.syncItem.safeParse({ ...base, enrichments: { revenue: '1M' } });
    expect(r.success).toBe(true);
  });

  it('accepts array-shaped enrichments (items.getAll projection)', () => {
    const r = Schemas.syncItem.safeParse({
      ...base,
      enrichments: [{ description: 'Revenue', format: 'text', result: '1M' }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts omitted enrichments', () => {
    expect(Schemas.syncItem.safeParse(base).success).toBe(true);
  });
});
