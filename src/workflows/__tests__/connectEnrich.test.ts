import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runConnectEnrich } from '../connectEnrich.js';
import { getDb, closeDb } from '../../store/db.js';
import type { TaskStore } from '../../lib/taskStore.js';

function fakeStore(): TaskStore {
  // `get` is required because isCancelled() calls store.get() in the batch loop.
  return { updateProgress: vi.fn(), get: vi.fn().mockReturnValue(undefined) } as unknown as TaskStore;
}

function fakeExa() {
  // `listAll` async generator is required because collectItems() uses exa.websets.items.listAll.
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

const COST_ZERO = { total: 0, agentCompute: 0, search: 0, emails: 0, phoneNumbers: 0 };

describe('connect.enrich workflow', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  it('enriches items end-to-end with async agent lifecycle', async () => {
    // First fetch (POST create) returns a non-terminal running status.
    const runningRun = {
      id: 'agent_run_1', object: 'agent_run', status: 'running',
      output: { structured: null, grounding: [] },
      costDollars: COST_ZERO,
    };
    // Subsequent fetches (GET polls) return the terminal completed run with wrapped results.
    const completedRun = {
      id: 'agent_run_1', object: 'agent_run', status: 'completed',
      output: {
        structured: {
          results: [
            { _itemId: 'item1', monthlyVisits: 100 },
            { _itemId: 'item2', monthlyVisits: 200 },
          ],
        },
        grounding: [],
      },
      costDollars: { total: 0.06, agentCompute: 0, search: 0, emails: 0, phoneNumbers: 0 },
    };

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(runningRun), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(completedRun), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await runConnectEnrich('task2', {
      websetId: 'ws1', providers: ['similarweb'], outputSchema: { type: 'object' },
      maxItems: 10, pollIntervalMs: 1,
    }, fakeExa(), fakeStore()) as any;

    expect(res.enriched).toBe(2);
    const rows = getDb().prepare('SELECT * FROM connect_enrichments').all() as any[];
    expect(rows.length).toBe(2);
    const item2Row = rows.find((r: any) => r.item_id === 'item2');
    expect(JSON.parse(item2Row.structured).monthlyVisits).toBe(200);
  });

  it('clamps batchSize to >= 1 so a 0 batchSize cannot loop forever', async () => {
    // Without the Math.max(1, ...) clamp, batchSize:0 makes the for-loop
    // increment by 0 — `i` never advances and the task re-creates batches
    // forever. With the clamp it runs as single-item batches and completes.
    const completedRun = {
      id: 'agent_run_1', object: 'agent_run', status: 'completed',
      output: {
        structured: { results: [{ _itemId: 'item1', monthlyVisits: 100 }, { _itemId: 'item2', monthlyVisits: 200 }] },
        grounding: [],
      },
      costDollars: { total: 0.06, agentCompute: 0, search: 0, emails: 0, phoneNumbers: 0 },
    };
    // Fresh Response per call — clamped batchSize:0 -> 1 means two single-item
    // batches, i.e. two agent fetches; a shared Response body can only be read once.
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify(completedRun), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const res = await runConnectEnrich('task4', {
      websetId: 'ws1', providers: ['similarweb'], outputSchema: { type: 'object' },
      maxItems: 10, batchSize: 0, pollIntervalMs: 1,
    }, fakeExa(), fakeStore()) as any;

    expect(res.enriched).toBe(2);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM connect_enrichments').get()).toEqual({ n: 2 });
  });

  it('throws before any fetch when a provider is not usable', async () => {
    await expect(
      runConnectEnrich('task3', {
        websetId: 'ws1',
        providers: ['harmonic'], // gated provider — not in active catalog
        outputSchema: { type: 'object' },
      }, fakeExa(), fakeStore()),
    ).rejects.toThrow(/connect\.enrich: provider\(s\) not usable/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
