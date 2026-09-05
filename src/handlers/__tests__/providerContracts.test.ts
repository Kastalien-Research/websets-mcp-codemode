import { describe, expect, it, vi } from 'vitest';
import { dispatchOperation } from '../../tools/operations.js';

const custom = { type: 'custom', description: 'Machine learning job postings' };
const item = (id: string, satisfied: string[]) => ({
  id, websetId: 'ws', createdAt: '2026-01-01', updatedAt: '2026-01-02',
  properties: { type: 'company', company: { name: id }, url: `https://${id}.test` },
  evaluations: satisfied.map(s => ({ criterion: 'criterion', satisfied: s })),
  enrichments: [{ enrichmentId: 'enr', status: 'pending', result: null }],
});
const body = (result: any) => {
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text);
};

describe('provider request/response contracts through dispatch', () => {
  it.each(['websets.create', 'websets.preview', 'searches.create', 'imports.create'])(
    '%s preserves custom descriptions and rejects missing descriptions before dispatch', async operation => {
      const send = vi.fn().mockResolvedValue({ id: 'ws' });
      const exa = { websets: { create: send, preview: send, searches: { create: send }, imports: { create: send } } } as any;
      const args = { entity: custom, searchQuery: 'jobs', query: 'jobs', websetId: 'ws', count: 2, size: 30, format: 'csv' };
      body(await dispatchOperation(operation, args, exa));
      const call = send.mock.calls[0];
      const payload = operation === 'searches.create' ? call[1] : call[0];
      expect(payload.search?.entity ?? payload.entity).toEqual(custom);
      send.mockClear();
      expect((await dispatchOperation(operation, { ...args, entity: { type: 'custom' } }, exa)).isError).toBe(true);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('preserves CSV column selection and returns the upload receipt', async () => {
    const receipt = { id: 'imp', status: 'pending', uploadUrl: 'https://upload.test/signed', uploadValidUntil: '2026-09-06T00:00:00Z' };
    const create = vi.fn().mockResolvedValue(receipt);
    const exa = { websets: { imports: { create } } } as any;
    const args = { format: 'csv', entity: { type: 'company' }, count: 2, size: 50, csv: { identifier: 0 } };
    expect(body(await dispatchOperation('imports.create', args, exa))).toMatchObject(receipt);
    expect(create).toHaveBeenCalledWith(args);
    create.mockClear();
    expect((await dispatchOperation('imports.create', { ...args, csv: 'url' }, exa)).isError).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('preserves requested search count, recall estimates, identity and freshness', async () => {
    const search = { id: 's', websetId: 'ws', count: 50, createdAt: '2026-01-01', updatedAt: '2026-01-02', recall: { expected: { total: 75, confidence: 'low', bounds: { min: 50, max: 100 } }, reasoning: 'Estimate' } };
    const exa = { websets: { searches: { get: vi.fn().mockResolvedValue(search) } } } as any;
    expect(body(await dispatchOperation('searches.get', { websetId: 'ws', searchId: 's' }, exa))).toMatchObject(search);
  });

  it('returns explicitly expanded raw items, including negative evidence, and dashboard URL', async () => {
    const rejected = { ...item('rejected', ['no']), properties: { content: 'Full evidence' } };
    const get = vi.fn().mockResolvedValue({ id: 'ws', dashboardUrl: 'https://websets.exa.ai/ws', items: [rejected] });
    const data = body(await dispatchOperation('websets.get', { id: 'ws', expand: ['items'] }, { websets: { get } } as any));
    expect(get).toHaveBeenCalledWith('ws', ['items']);
    expect(data.dashboardUrl).toBe('https://websets.exa.ai/ws');
    expect(data.items).toEqual([rejected]);
  });

  it.each([
    [undefined, ['mixed', 'yes', 'empty']],
    ['any', ['mixed', 'yes', 'empty']],
    ['all', ['yes', 'empty']],
    ['none', ['mixed', 'yes', 'unclear', 'no', 'empty']],
  ])('applies evaluation policy %s without changing page boundaries', async (evaluationPolicy, ids) => {
    const items = [item('mixed', ['yes', 'no']), item('yes', ['yes']), item('unclear', ['unclear']), item('no', ['no']), item('empty', [])];
    const list = vi.fn().mockResolvedValue({ data: items, hasMore: true, nextCursor: 'cursor2' });
    const data = body(await dispatchOperation('items.list', { websetId: 'ws', evaluationPolicy }, { websets: { items: { list } } } as any));
    expect(data.data.map((i: any) => i.id)).toEqual(ids);
    expect(data).toMatchObject({ total: 5, included: ids!.length, excluded: 5 - ids!.length, hasMore: true, nextCursor: 'cursor2' });
    expect(data.data[0]).toMatchObject({ websetId: 'ws', createdAt: '2026-01-01', updatedAt: '2026-01-02', enrichments: [{ status: 'pending' }] });
    if (evaluationPolicy === 'none') expect(data.data[2].evaluations[0].satisfied).toBe('unclear');
  });

  it('allows continuing from a fully filtered page and keeps raw single-item inspection', async () => {
    const rejected = item('rejected', ['no']);
    const list = vi.fn().mockResolvedValueOnce({ data: [rejected], hasMore: true, nextCursor: 'next' }).mockResolvedValueOnce({ data: [item('yes', ['yes'])], hasMore: false, nextCursor: null });
    const exa = { websets: { items: { list, get: vi.fn().mockResolvedValue(rejected), listAll: async function* () { yield rejected; yield item('yes', ['yes']); } } } } as any;
    const first = body(await dispatchOperation('items.list', { websetId: 'ws' }, exa));
    expect(first).toMatchObject({ data: [], total: 1, excluded: 1, hasMore: true, nextCursor: 'next' });
    const next = body(await dispatchOperation('items.list', { websetId: 'ws', cursor: first.nextCursor }, exa));
    expect(next.data).toHaveLength(1);
    expect(body(await dispatchOperation('items.get', { websetId: 'ws', itemId: 'rejected' }, exa))).toEqual(rejected);
    expect(body(await dispatchOperation('items.getAll', { websetId: 'ws', evaluationPolicy: 'none' }, exa)).data).toHaveLength(2);
    expect(body(await dispatchOperation('items.getAll', { websetId: 'ws', evaluationPolicy: 'all' }, exa)).data).toHaveLength(1);
  });
});
