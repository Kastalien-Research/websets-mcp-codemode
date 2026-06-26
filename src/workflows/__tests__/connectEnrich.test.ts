import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runConnectEnrich } from '../connectEnrich.js';
import { getDb, closeDb } from '../../store/db.js';
import type { TaskStore } from '../../lib/taskStore.js';

function fakeStore(): TaskStore {
  // FIX: added `get` because isCancelled() calls store.get() in the batch loop.
  // Brief omitted it; without it the loop throws "store.get is not a function".
  return { updateProgress: vi.fn(), get: vi.fn().mockReturnValue(undefined) } as unknown as TaskStore;
}

// Exa stub: websets.get returns entity type; agent runs go through agentRuns,
// which we drive by stubbing global fetch (agentFetch uses fetch under the hood).
function fakeExa() {
  // FIX: added `listAll` async generator alongside `list`.
  // collectItems() in helpers.ts uses exa.websets.items.listAll (not .list).
  // Brief only provided `list`; without `listAll` both tests throw
  // "listAll(...) is not a function or its return value is not async iterable".
  const items = [
    { id: 'item1', properties: { url: 'https://anthropic.com', company: { name: 'Anthropic' } } },
    { id: 'item2', properties: { url: 'https://openai.com', company: { name: 'OpenAI' } } },
  ];
  return {
    baseURL: 'https://api.exa.ai',
    headers: { forEach: (cb: (v: string, k: string) => void) => cb('test-key', 'x-api-key') },
    websets: {
      get: vi.fn().mockResolvedValue({ id: 'ws1', searches: [{ entity: { type: 'company' } }] }),
      items: {
        list: vi.fn().mockResolvedValue({ data: items, hasMore: false }),
        listAll: vi.fn().mockImplementation(async function* () { yield* items; }),
      },
    },
  } as any;
}

describe('connect.enrich workflow', () => {
  let fetchSpy: any;
  beforeEach(() => {
    closeDb();
    getDb(':memory:');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => { fetchSpy.mockRestore(); closeDb(); });

  it('dryRun returns an estimate without calling the agent', async () => {
    const res = await runConnectEnrich('task1', {
      websetId: 'ws1', providers: ['similarweb'], outputSchema: { type: 'object' },
      maxItems: 10, dryRun: true,
    }, fakeExa(), fakeStore()) as any;
    expect(res.dryRun).toBe(true);
    expect(res.estimatedCost).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('enriches items and persists Connect rows', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      id: 'agent_run_1', object: 'agent_run', status: 'completed',
      output: {
        structured: [
          { _itemId: 'item1', monthlyVisits: 100 },
          { _itemId: 'item2', monthlyVisits: 200 },
        ],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const res = await runConnectEnrich('task2', {
      websetId: 'ws1', providers: ['similarweb'], outputSchema: { type: 'object' },
      maxItems: 10,
    }, fakeExa(), fakeStore()) as any;

    expect(res.enriched).toBe(2);
    const rows = getDb().prepare('SELECT * FROM connect_enrichments').all() as any[];
    expect(rows.length).toBe(2);
    expect(JSON.parse(rows.find((r) => r.item_id === 'item2').structured).monthlyVisits).toBe(200);
  });
});
