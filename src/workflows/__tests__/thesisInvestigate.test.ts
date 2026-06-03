import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { TaskStore } from '../../lib/taskStore.js';
import { closeDb } from '../../store/db.js';
import { computeVerdict } from '../thesisInvestigate.js';

import '../thesisInvestigate.js';
import { workflowRegistry } from '../types.js';

describe('computeVerdict heuristic', () => {
  const opts = { minEvidence: 3, targetN: 25 };

  it('supported when ratio high and enough supporting domains', () => {
    const v = computeVerdict(8, 1, 9, opts);
    expect(v.verdict).toBe('supported');
    expect(v.confidence).toBeGreaterThan(0);
  });

  it('refuted when ratio low and enough countering domains', () => {
    const v = computeVerdict(1, 8, 9, opts);
    expect(v.verdict).toBe('refuted');
  });

  it('mixed when both sides clear the threshold without a dominant ratio', () => {
    const v = computeVerdict(5, 5, 10, opts);
    expect(v.verdict).toBe('mixed');
  });

  it('inconclusive when neither side has enough evidence', () => {
    const v = computeVerdict(2, 1, 3, opts);
    expect(v.verdict).toBe('inconclusive');
  });

  it('confidence is bounded to [0,1]', () => {
    const v = computeVerdict(100, 0, 100, { minEvidence: 3, targetN: 5 });
    expect(v.confidence).toBeLessThanOrEqual(1);
    expect(v.confidence).toBeGreaterThanOrEqual(0);
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

  it('gathers evidence, writes a verdict, and indexes the notebook', async () => {
    const mockExa = createMockExa(mockItems('for', 8), mockItems('against', 1));
    const task = store.create('thesis.investigate', {
      thesis: 'Remote-first companies retain employees better',
      entity: { type: 'article' },
    });

    const result = (await workflow(task.id, task.args, mockExa, store)) as any;

    expect(result.verdict).toBe('supported');
    expect(result.supportingDomains).toBe(8);
    expect(result.counteringDomains).toBe(1);
    expect(result.notebookSlug).toBeTruthy();

    // Notebook file written and contains a Run section
    const file = path.join(tmpDir, 'notebooks', `${result.notebookSlug}.src.md`);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('### Run');

    // Index updated with latest verdict (via a SELECT, like store.query)
    const { getNotebookIndex } = await import('../../store/db.js');
    const row = getNotebookIndex(result.notebookSlug);
    expect(row?.latest_verdict).toBe('supported');
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
