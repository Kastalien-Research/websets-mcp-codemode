// SQLite-backed local shadow of Webset data.
// Exa's API is read-only for items — this adds an annotation layer.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

let db: Database.Database | null = null;

const DEFAULT_DB_PATH = path.resolve('data', 'websets.db');

export function getDb(dbPath?: string): Database.Database {
  if (db) return db;

  const resolvedPath = dbPath ?? process.env.WEBSETS_DB_PATH ?? DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

/** For testing — close and reset the singleton */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      webset_id TEXT NOT NULL,
      name TEXT,
      url TEXT,
      entity_type TEXT,
      enrichments JSON,
      evaluations JSON,
      raw JSON,
      received_at TEXT NOT NULL,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL REFERENCES items(id),
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT DEFAULT 'claude'
    );

    CREATE INDEX IF NOT EXISTS idx_annotations_item ON annotations(item_id);
    CREATE INDEX IF NOT EXISTS idx_annotations_type ON annotations(type);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      webset_id TEXT,
      payload JSON,
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_name TEXT NOT NULL,
      snapshot JSON NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_config ON snapshots(config_name);
  `);
}

// --- Item operations ---

export interface ItemRow {
  id: string;
  webset_id: string;
  name: string | null;
  url: string | null;
  entity_type: string | null;
  enrichments: string | null; // JSON string
  evaluations: string | null; // JSON string
  raw: string | null;
  received_at: string;
  created_at: string | null;
}

export function upsertItem(item: {
  id: string;
  websetId: string;
  name?: string;
  url?: string;
  entityType?: string;
  enrichments?: Record<string, unknown>;
  evaluations?: unknown[];
  raw?: unknown;
  createdAt?: string;
}): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO items (id, webset_id, name, url, entity_type, enrichments, evaluations, raw, received_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(excluded.name, items.name),
      url = COALESCE(excluded.url, items.url),
      entity_type = COALESCE(excluded.entity_type, items.entity_type),
      enrichments = COALESCE(excluded.enrichments, items.enrichments),
      evaluations = COALESCE(excluded.evaluations, items.evaluations),
      raw = COALESCE(excluded.raw, items.raw),
      received_at = excluded.received_at
  `).run(
    item.id,
    item.websetId,
    item.name ?? null,
    item.url ?? null,
    item.entityType ?? null,
    item.enrichments ? JSON.stringify(item.enrichments) : null,
    item.evaluations ? JSON.stringify(item.evaluations) : null,
    item.raw ? JSON.stringify(item.raw) : null,
    item.createdAt ?? null,
  );
}

export function getItemWithAnnotations(itemId: string): {
  item: ItemRow;
  annotations: Array<{ id: number; type: string; value: string; created_at: string; source: string }>;
} | null {
  const d = getDb();
  const item = d.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as ItemRow | undefined;
  if (!item) return null;

  const annotations = d.prepare(
    'SELECT id, type, value, created_at, source FROM annotations WHERE item_id = ? ORDER BY created_at'
  ).all(itemId) as Array<{ id: number; type: string; value: string; created_at: string; source: string }>;

  return { item, annotations };
}

export function annotateItem(
  itemId: string,
  type: string,
  value: string,
  source: string = 'claude',
): number {
  const d = getDb();
  const result = d.prepare(
    'INSERT INTO annotations (item_id, type, value, source) VALUES (?, ?, ?, ?)'
  ).run(itemId, type, value, source);
  return Number(result.lastInsertRowid);
}

export function getUninvestigatedItems(websetId?: string): ItemRow[] {
  const d = getDb();
  if (websetId) {
    return d.prepare(`
      SELECT i.* FROM items i
      WHERE i.webset_id = ?
        AND NOT EXISTS (SELECT 1 FROM annotations a WHERE a.item_id = i.id AND a.type = 'judgment')
      ORDER BY i.received_at DESC
    `).all(websetId) as ItemRow[];
  }
  return d.prepare(`
    SELECT i.* FROM items i
    WHERE NOT EXISTS (SELECT 1 FROM annotations a WHERE a.item_id = i.id AND a.type = 'judgment')
    ORDER BY i.received_at DESC
  `).all() as ItemRow[];
}

// --- Event operations ---

export function insertEvent(event: {
  id: string;
  type: string;
  websetId?: string;
  payload: unknown;
}): void {
  const d = getDb();
  d.prepare(
    'INSERT OR IGNORE INTO events (id, type, webset_id, payload, received_at) VALUES (?, ?, ?, ?, datetime(\'now\'))'
  ).run(event.id, event.type, event.websetId ?? null, JSON.stringify(event.payload));
}

// --- Snapshot operations ---

export function insertSnapshot(configName: string, snapshot: unknown): void {
  const d = getDb();
  d.prepare(
    'INSERT INTO snapshots (config_name, snapshot) VALUES (?, ?)'
  ).run(configName, JSON.stringify(snapshot));
}

export function getLatestSnapshot(configName: string): unknown | null {
  const d = getDb();
  const row = d.prepare(
    'SELECT snapshot FROM snapshots WHERE config_name = ? ORDER BY id DESC LIMIT 1'
  ).get(configName) as { snapshot: string } | undefined;
  return row ? JSON.parse(row.snapshot) : null;
}
