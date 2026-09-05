import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { closeDb, getDb, getNotebookIndex } from '../../store/db.js';
import { appendCell, appendRun, createNotebook, readNotebook, renderNotebook } from '../store.js';
import { dispatchOperation } from '../../tools/operations.js';

let dir: string;
beforeEach(() => {
  closeDb(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'websets-runs-'));
  process.env.WEBSETS_DB_PATH = path.join(dir, 'test.db');
  process.env.NOTEBOOKS_DIR = path.join(dir, 'notebooks');
});
afterEach(() => {
  closeDb(); delete process.env.WEBSETS_DB_PATH; delete process.env.NOTEBOOKS_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const retrieval = () => ({
  kind: 'retrieval' as const, timestamp: '2026-09-05T00:00:00Z',
  retrievalBalance: 'thesis-heavy' as const, retrievalScore: 0.4,
  thesisQueryDomains: 8, antithesisQueryDomains: 1, thesisQueryShare: 8 / 9,
  thesisQueryResults: ['Example — https://example.test'], antithesisQueryResults: [],
});

describe('tagged notebook runs', () => {
  it('preserves legacy history, writes retrieval statistics, and clears stale latest legacy values', () => {
    createNotebook({ thesis: 'A claim', slug: 'mixed' });
    const legacy = { timestamp: '2026-01-01', verdict: 'supported', confidence: 0.8, evidenceFor: ['source'], evidenceAgainst: [] };
    appendRun('mixed', legacy);
    const oldText = renderNotebook('mixed');
    expect(getNotebookIndex('mixed')).toMatchObject({ latest_run_kind: 'legacy', latest_verdict: 'supported', latest_confidence: 0.8 });
    const current = appendRun('mixed', retrieval());
    expect(current.runs).toEqual([legacy, retrieval()]);
    // Adjacent markdown cells merge when decoded; compare the persisted history.
    expect(renderNotebook('mixed').startsWith(oldText)).toBe(true);
    expect(getNotebookIndex('mixed')).toMatchObject({
      latest_run_kind: 'retrieval', latest_retrieval_balance: 'thesis-heavy', latest_retrieval_score: 0.4,
      latest_verdict: null, latest_confidence: null,
    });
    appendCell('mixed', { type: 'markdown', text: 'Additional note' });
    expect(getNotebookIndex('mixed')?.latest_retrieval_score).toBe(0.4);
    expect(readNotebook('mixed').runs).toEqual([legacy, retrieval()]);
    const text = (current.cells.at(-1) as { text: string }).text;
    expect(text).toContain('Thesis-query results');
    expect(text).toContain('does not establish factual support');
    expect(text).not.toContain('**Verdict:**');
    appendRun('mixed', { ...legacy, timestamp: '2026-09-06' });
    expect(getNotebookIndex('mixed')).toMatchObject({ latest_run_kind: 'legacy', latest_retrieval_balance: null, latest_retrieval_score: null });
  });

  it('exposes retrieval runs through the operation contract and rejects mixed meanings before writing', async () => {
    createNotebook({ thesis: 'A claim', slug: 'api' });
    const response = await dispatchOperation('notebook.appendRun', { slug: 'api', run: retrieval() }, {} as any);
    expect(response.isError).toBeUndefined();
    const output = JSON.parse(response.content[0].text);
    expect(output).toMatchObject({ kind: 'retrieval', retrievalBalance: 'thesis-heavy', retrievalScore: 0.4 });
    expect(output).not.toHaveProperty('verdict'); expect(output).not.toHaveProperty('confidence');
    const invalid = await dispatchOperation('notebook.appendRun', { slug: 'api', run: { ...retrieval(), verdict: 'supported', confidence: 0.9 } }, {} as any);
    expect(invalid.isError).toBe(true);
    expect(readNotebook('api').runs).toHaveLength(1);
  });

  it('upgrades an existing notebook index without rewriting its historical values', () => {
    const old = new Database(process.env.WEBSETS_DB_PATH!);
    old.exec(`CREATE TABLE notebooks (
      slug TEXT PRIMARY KEY, title TEXT, path TEXT NOT NULL, statement TEXT,
      latest_verdict TEXT, latest_confidence REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    ); INSERT INTO notebooks (slug, path, latest_verdict, latest_confidence)
      VALUES ('legacy', '/historical/notebook.src.md', 'mixed', 0.25);`);
    old.close();
    getDb();
    expect(getNotebookIndex('legacy')).toMatchObject({ latest_run_kind: 'legacy', latest_verdict: 'mixed', latest_confidence: 0.25, latest_retrieval_balance: null, latest_retrieval_score: null });
    closeDb(); getDb();
    expect(getNotebookIndex('legacy')?.latest_confidence).toBe(0.25);
  });
});
