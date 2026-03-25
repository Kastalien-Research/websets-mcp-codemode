import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, upsertItem, annotateItem, getItemWithAnnotations, getUninvestigatedItems, insertEvent, insertSnapshot, getLatestSnapshot } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let testDbPath: string;

beforeEach(() => {
  testDbPath = path.join(os.tmpdir(), `websets-test-${Date.now()}.db`);
  // Force new db instance with test path
  closeDb();
  process.env.WEBSETS_DB_PATH = testDbPath;
  getDb(testDbPath);
});

afterEach(() => {
  closeDb();
  try { fs.unlinkSync(testDbPath); } catch {}
  delete process.env.WEBSETS_DB_PATH;
});

describe('upsertItem', () => {
  it('inserts a new item', () => {
    upsertItem({
      id: 'item_1',
      websetId: 'ws_1',
      name: 'Acme Corp',
      url: 'https://acme.com',
      entityType: 'company',
      enrichments: { 'Open roles': '15' },
    });

    const result = getItemWithAnnotations('item_1');
    expect(result).not.toBeNull();
    expect(result!.item.name).toBe('Acme Corp');
    expect(result!.item.webset_id).toBe('ws_1');
    expect(JSON.parse(result!.item.enrichments!)).toEqual({ 'Open roles': '15' });
  });

  it('updates existing item on conflict', () => {
    upsertItem({ id: 'item_1', websetId: 'ws_1', name: 'Acme' });
    upsertItem({ id: 'item_1', websetId: 'ws_1', name: 'Acme Corp', url: 'https://acme.com' });

    const result = getItemWithAnnotations('item_1');
    expect(result!.item.name).toBe('Acme Corp');
    expect(result!.item.url).toBe('https://acme.com');
  });
});

describe('annotations', () => {
  it('adds and retrieves annotations', () => {
    upsertItem({ id: 'item_1', websetId: 'ws_1', name: 'Test' });

    annotateItem('item_1', 'judgment', 'Relevant — hiring surge confirmed');
    annotateItem('item_1', 'tag', 'series-b-candidate');

    const result = getItemWithAnnotations('item_1');
    expect(result!.annotations).toHaveLength(2);
    expect(result!.annotations[0].type).toBe('judgment');
    expect(result!.annotations[0].value).toBe('Relevant — hiring surge confirmed');
    expect(result!.annotations[1].type).toBe('tag');
  });

  it('tracks annotation source', () => {
    upsertItem({ id: 'item_1', websetId: 'ws_1' });
    annotateItem('item_1', 'note', 'user note', 'user');

    const result = getItemWithAnnotations('item_1');
    expect(result!.annotations[0].source).toBe('user');
  });
});

describe('getUninvestigatedItems', () => {
  it('returns items without judgment annotations', () => {
    upsertItem({ id: 'item_1', websetId: 'ws_1', name: 'A' });
    upsertItem({ id: 'item_2', websetId: 'ws_1', name: 'B' });
    annotateItem('item_1', 'judgment', 'investigated');

    const uninvestigated = getUninvestigatedItems();
    expect(uninvestigated).toHaveLength(1);
    expect(uninvestigated[0].id).toBe('item_2');
  });

  it('filters by websetId', () => {
    upsertItem({ id: 'item_1', websetId: 'ws_1' });
    upsertItem({ id: 'item_2', websetId: 'ws_2' });

    const result = getUninvestigatedItems('ws_1');
    expect(result).toHaveLength(1);
    expect(result[0].webset_id).toBe('ws_1');
  });

  it('returns empty when all items have judgments', () => {
    upsertItem({ id: 'item_1', websetId: 'ws_1' });
    annotateItem('item_1', 'judgment', 'done');

    expect(getUninvestigatedItems()).toHaveLength(0);
  });
});

describe('events', () => {
  it('logs webhook events', () => {
    insertEvent({ id: 'evt_1', type: 'webset.item.created', payload: { data: {} } });

    const d = getDb();
    const row = d.prepare('SELECT * FROM events WHERE id = ?').get('evt_1') as any;
    expect(row.type).toBe('webset.item.created');
  });

  it('ignores duplicate event IDs', () => {
    insertEvent({ id: 'evt_1', type: 'test', payload: {} });
    insertEvent({ id: 'evt_1', type: 'test2', payload: {} }); // should not throw

    const d = getDb();
    const row = d.prepare('SELECT type FROM events WHERE id = ?').get('evt_1') as any;
    expect(row.type).toBe('test'); // original preserved
  });
});

describe('snapshots', () => {
  it('stores and retrieves snapshots', () => {
    const snap = { evaluatedAt: '2026-01-01', signal: { fired: true } };
    insertSnapshot('my-cron', snap);

    const retrieved = getLatestSnapshot('my-cron');
    expect(retrieved).toEqual(snap);
  });

  it('returns latest snapshot', () => {
    insertSnapshot('my-cron', { version: 1 });
    insertSnapshot('my-cron', { version: 2 });

    const latest = getLatestSnapshot('my-cron') as any;
    expect(latest.version).toBe(2);
  });

  it('returns null for unknown config', () => {
    expect(getLatestSnapshot('nonexistent')).toBeNull();
  });

  it('isolates by config name', () => {
    insertSnapshot('cron-a', { name: 'a' });
    insertSnapshot('cron-b', { name: 'b' });

    expect((getLatestSnapshot('cron-a') as any).name).toBe('a');
    expect((getLatestSnapshot('cron-b') as any).name).toBe('b');
  });
});
