import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { TaskStore } from '../../lib/taskStore.js';
import { closeDb } from '../../store/db.js';
import { computeRetrievalStats } from '../thesisInvestigate.js';

import '../thesisInvestigate.js';
import { workflowRegistry } from '../types.js';

describe('computeRetrievalStats heuristic', () => {
  const opts = { minEvidence: 3, targetN: 25 };

  it('thesis-heavy when ratio high and enough thesis-query domains', () => {
    const v = computeRetrievalStats(8, 1, 9, opts);
    expect(v.retrievalBalance).toBe('thesis-heavy');
    expect(v.retrievalScore).toBeGreaterThan(0);
  });

  it('antithesis-heavy when ratio low and enough antithesis-query domains', () => {
    const v = computeRetrievalStats(1, 8, 9, opts);
    expect(v.retrievalBalance).toBe('antithesis-heavy');
  });

  it('mixed when both sides clear the threshold without a dominant ratio', () => {
    const v = computeRetrievalStats(5, 5, 10, opts);
    expect(v.retrievalBalance).toBe('mixed');
  });

  it('sparse when neither query retrieved enough domains', () => {
    const v = computeRetrievalStats(2, 1, 3, opts);
    expect(v.retrievalBalance).toBe('sparse');
  });

  it('retrieval score is bounded to [0,1]', () => {
    const v = computeRetrievalStats(100, 0, 100, { minEvidence: 3, targetN: 5 });
    expect(v.retrievalScore).toBeLessThanOrEqual(1);
    expect(v.retrievalScore).toBeGreaterThanOrEqual(0);
  });
});

// --- Workflow integration (mocked exa + temp store/notebook dir) ---

function mockItems(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}_${i}`,
    properties: { article: { title: `${prefix} ${i}` }, url: `https://${prefix}${i}.example.com/post` },
  }));
}

function createMockExa(thesisItems: any[], antithesisItems: any[]) {
  let listAllCount = 0;
  let createCount = 0;
  return {
    websets: {
      create: vi.fn().mockImplementation(async () => ({ id: `ws_${++createCount}`, status: 'idle', searches: [] })),
      get: vi.fn().mockImplementation(async (id: string) => ({ id, status: 'idle', searches: [] })),
      cancel: vi.fn(),
      items: {
        listAll: vi.fn().mockImplementation(function () {
          listAllCount++;
          const items = listAllCount === 1 ? thesisItems : antithesisItems;
          return (async function* () { for (const it of items) yield it; })();
        }),
      },
    },
  } as any;
}

describe('thesis.investigate workflow', () => {
  let store: TaskStore;
  let tmpDir: string;
  const workflow = workflowRegistry.get('thesis.investigate')!;

  beforeEach(() => {
    store = new TaskStore();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thesis-test-'));
    closeDb();
    process.env.WEBSETS_DB_PATH = path.join(tmpDir, 'test.db');
    process.env.NOTEBOOKS_DIR = path.join(tmpDir, 'notebooks');
  });

  afterEach(() => {
    closeDb();
    delete process.env.WEBSETS_DB_PATH;
    delete process.env.NOTEBOOKS_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    store.dispose();
  });

  it('is registered', () => {
    expect(workflow).toBeDefined();
  });

  it('gathers evidence, writes retrieval statistics, and indexes the notebook', async () => {
    const mockExa = createMockExa(mockItems('for', 8), mockItems('against', 1));
    const task = store.create('thesis.investigate', {
      thesis: 'Remote-first companies retain employees better',
      entity: { type: 'article' },
    });

    const result = (await workflow(task.id, task.args, mockExa, store)) as any;

    expect(result.retrievalBalance).toBe('thesis-heavy');
    expect(result.thesisQueryDomains).toBe(8);
    expect(result.antithesisQueryDomains).toBe(1);
    expect(result.notebookSlug).toBeTruthy();
    expect(result).not.toHaveProperty('verdict');
    expect(result).not.toHaveProperty('confidence');
    expect(result.retrievalScore).toBeCloseTo((9 / 25) * Math.abs(8 / 9 - 0.5) * 2);

    // Notebook file written and contains a Run section
    const file = path.join(tmpDir, 'notebooks', `${result.notebookSlug}.src.md`);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('### Run');

    // Index updated with latest retrieval balance (via a SELECT, like store.query)
    const { getNotebookIndex } = await import('../../store/db.js');
    const row = getNotebookIndex(result.notebookSlug);
    expect(row?.latest_retrieval_balance).toBe('thesis-heavy');
    expect(row?.latest_run_kind).toBe('retrieval');
    expect(row?.latest_verdict).toBeNull();
    expect(row?.latest_confidence).toBeNull();
  });

  it('appends a second run when reusing a notebook slug', async () => {
    const exa1 = createMockExa(mockItems('for', 8), mockItems('against', 1));
    const t1 = store.create('thesis.investigate', { thesis: 'Reusable thesis', notebookSlug: 'reuse-me' });
    const r1 = (await workflow(t1.id, t1.args, exa1, store)) as any;
    expect(r1.notebookSlug).toBe('reuse-me');

    const exa2 = createMockExa(mockItems('x', 1), mockItems('y', 8));
    const t2 = store.create('thesis.investigate', { thesis: 'Reusable thesis', notebookSlug: 'reuse-me' });
    await workflow(t2.id, t2.args, exa2, store);

    const { readNotebook } = await import('../../notebook/store.js');
    const nb = readNotebook('reuse-me');
    expect(nb.runs.length).toBe(2);
  });
});
