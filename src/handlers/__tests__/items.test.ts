import { describe, it, expect, vi } from 'vitest';
import { list } from '../items.js';
import type { Exa } from 'exa-js';

function mockExa(listResponse: unknown): Exa {
  return {
    websets: {
      items: {
        list: vi.fn().mockResolvedValue(listResponse),
      },
    },
  } as unknown as Exa;
}

const rawItem = {
  id: 'witem_1',
  properties: { type: 'company', url: 'https://example.com', company: { name: 'Example Co' } },
};

describe('items.list pagination passthrough', () => {
  it('surfaces nextCursor and hasMore from the SDK response', async () => {
    const exa = mockExa({ data: [rawItem], hasMore: true, nextCursor: 'cursor_abc' });
    const result = await list({ websetId: 'ws_1', limit: 1 }, exa);
    expect(result.isError, result.content[0].text).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.hasMore).toBe(true);
    expect(data.nextCursor).toBe('cursor_abc');
  });

  it('reports hasMore false and null nextCursor on the last page', async () => {
    const exa = mockExa({ data: [rawItem], hasMore: false, nextCursor: null });
    const result = await list({ websetId: 'ws_1' }, exa);
    expect(result.isError, result.content[0].text).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.hasMore).toBe(false);
    expect(data.nextCursor).toBeNull();
  });
});
