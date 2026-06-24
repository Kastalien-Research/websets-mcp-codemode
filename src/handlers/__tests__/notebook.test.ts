import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { dispatchOperation } from '../../tools/operations.js';
import { decodeNotebook } from '../../notebook/srcmd.js';
import { closeDb } from '../../store/db.js';

const exa = {} as any; // notebook ops don't touch the Exa client directly

async function call(op: string, args: Record<string, unknown>) {
  const res = await dispatchOperation(op, args, exa);
  const text = res.content[0]?.text ?? '';
  return { res, data: res.isError ? text : JSON.parse(text) };
}

describe('notebook.* operations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-handler-'));
    closeDb();
    process.env.WEBSETS_DB_PATH = path.join(tmpDir, 'test.db');
    process.env.NOTEBOOKS_DIR = path.join(tmpDir, 'notebooks');
  });

  afterEach(() => {
    closeDb();
    delete process.env.WEBSETS_DB_PATH;
    delete process.env.NOTEBOOKS_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates, indexes, and renders a notebook as valid .src.md', async () => {
    const { data } = await call('notebook.create', { thesis: 'Tabs beat spaces' });
    expect(data.created).toBe(true);
    const slug = data.slug as string;

    const { data: rendered } = await call('notebook.render', { slug });
    const decoded = decodeNotebook(rendered.srcmd as string);
    expect(decoded.cells.some(c => c.type === 'title')).toBe(true);

    const { data: listed } = await call('notebook.list', {});
    expect(listed.count).toBeGreaterThanOrEqual(1);
  });

  it('appends and runs a code cell through the sandbox', async () => {
    const { data: created } = await call('notebook.create', { thesis: 'Compute works', slug: 'compute' });
    const slug = created.slug as string;

    await call('notebook.appendCell', {
      slug,
      cell: { type: 'code', filename: 'calc.ts', source: 'return 2 + 3;' },
    });

    const { data: got } = await call('notebook.get', { slug });
    const codeCell = (got.cells as any[]).find(c => c.type === 'code' && c.filename === 'calc.ts');
    expect(codeCell).toBeDefined();

    const { data: ran } = await call('notebook.runCell', { slug, cellId: 'calc.ts' });
    expect(ran.result).toBe(5);
  });

  it('appends a run and updates the latest verdict in the index', async () => {
    const { data: created } = await call('notebook.create', { thesis: 'Verdict test', slug: 'verdict' });
    const slug = created.slug as string;

    await call('notebook.appendRun', {
      slug,
      run: { verdict: 'supported', confidence: 0.8, evidenceFor: ['a.com'], evidenceAgainst: [] },
    });

    const { data: got } = await call('notebook.get', { slug });
    expect(got.runs.length).toBe(1);
    expect(got.runs[0].verdict).toBe('supported');

    const { data: store } = await call('store.query', {
      sql: 'SELECT slug, latest_verdict, latest_confidence FROM notebooks WHERE slug = ?',
      params: [slug],
    });
    expect(store.rows[0].latest_verdict).toBe('supported');
    expect(store.rows[0].latest_confidence).toBe(0.8);
  });
});
