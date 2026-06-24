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

    CREATE TABLE IF NOT EXISTS company_records (
      domain TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      sector TEXT,
      employee_count_signal TEXT,
      icp_fit INTEGER DEFAULT 1,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lens_hits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_domain TEXT NOT NULL REFERENCES company_records(domain),
      lens_id TEXT NOT NULL,
      webset_id TEXT,
      item_id TEXT,
      strength TEXT DEFAULT 'medium',
      evidence_url TEXT,
      evidence_summary TEXT,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_domain, lens_id)
    );

    CREATE TABLE IF NOT EXISTS scores (
      company_domain TEXT PRIMARY KEY REFERENCES company_records(domain),
      score INTEGER NOT NULL DEFAULT 0,
      components JSON,
      verdict TEXT DEFAULT 'monitor',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_domain TEXT NOT NULL REFERENCES company_records(domain),
      verdict TEXT NOT NULL,
      confidence REAL,
      payload JSON,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_lens_hits_domain ON lens_hits(company_domain);
    CREATE INDEX IF NOT EXISTS idx_verdicts_domain ON verdicts(company_domain);

    CREATE TABLE IF NOT EXISTS webhook_secrets (
      webhook_id TEXT PRIMARY KEY,
      secret TEXT NOT NULL,
      url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notebooks (
      slug TEXT PRIMARY KEY,
      title TEXT,
      path TEXT NOT NULL,
      statement TEXT,
      latest_verdict TEXT,
      latest_confidence REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function saveWebhookSecret(
  webhookId: string,
  secret: string,
  url?: string,
): void {
  const stmt = getDb().prepare(
    `INSERT INTO webhook_secrets (webhook_id, secret, url)
     VALUES (?, ?, ?)
     ON CONFLICT(webhook_id) DO UPDATE SET secret = excluded.secret, url = excluded.url`,
  );
  stmt.run(webhookId, secret, url ?? null);
}

export interface WebhookSecretRow {
  webhookId: string;
  secret: string;
  url: string | null;
}

export function listWebhookSecrets(): WebhookSecretRow[] {
  const rows = getDb()
    .prepare('SELECT webhook_id, secret, url FROM webhook_secrets')
    .all() as Array<{ webhook_id: string; secret: string; url: string | null }>;
  return rows.map((r) => ({ webhookId: r.webhook_id, secret: r.secret, url: r.url }));
}

export function deleteWebhookSecret(webhookId: string): void {
  getDb().prepare('DELETE FROM webhook_secrets WHERE webhook_id = ?').run(webhookId);
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

export function upsertAnnotation(
  itemId: string,
  type: string,
  value: string,
  source: string = 'claude',
): number {
  const d = getDb();
  d.prepare(
    'DELETE FROM annotations WHERE item_id = ? AND type = ? AND source = ?'
  ).run(itemId, type, source);
  const result = d.prepare(
    'INSERT INTO annotations (item_id, type, value, source) VALUES (?, ?, ?, ?)'
  ).run(itemId, type, value, source);
  return Number(result.lastInsertRowid);
}

/** Lightweight worklist row — omits the heavy `raw` and `evaluations` columns. */
export interface UninvestigatedLeanRow {
  id: string;
  webset_id: string;
  name: string | null;
  url: string | null;
  entity_type: string | null;
  enrichments: string | null; // JSON string (flat enrichmentId -> value map)
  received_at: string;
}

const UNINVESTIGATED_WHERE =
  "NOT EXISTS (SELECT 1 FROM annotations a WHERE a.item_id = i.id AND a.type = 'judgment')";

/** Total count of uninvestigated items (no LIMIT) — for honest pagination envelopes. */
export function countUninvestigatedItems(websetId?: string): number {
  const d = getDb();
  if (websetId) {
    const row = d.prepare(
      `SELECT COUNT(*) AS n FROM items i WHERE i.webset_id = ? AND ${UNINVESTIGATED_WHERE}`,
    ).get(websetId) as { n: number };
    return row.n;
  }
  const row = d.prepare(
    `SELECT COUNT(*) AS n FROM items i WHERE ${UNINVESTIGATED_WHERE}`,
  ).get() as { n: number };
  return row.n;
}

/** Lean worklist: light columns only, LIMIT applied in SQL. The default discovery path. */
export function getUninvestigatedLean(websetId?: string, limit = 50): UninvestigatedLeanRow[] {
  const d = getDb();
  const cols = 'i.id, i.webset_id, i.name, i.url, i.entity_type, i.enrichments, i.received_at';
  if (websetId) {
    return d.prepare(`
      SELECT ${cols} FROM items i
      WHERE i.webset_id = ? AND ${UNINVESTIGATED_WHERE}
      ORDER BY i.received_at DESC
      LIMIT ?
    `).all(websetId, limit) as UninvestigatedLeanRow[];
  }
  return d.prepare(`
    SELECT ${cols} FROM items i
    WHERE ${UNINVESTIGATED_WHERE}
    ORDER BY i.received_at DESC
    LIMIT ?
  `).all(limit) as UninvestigatedLeanRow[];
}

/** Full rows (incl. `raw`/`evaluations`) for the opt-in `verbose` path. LIMIT applied in SQL. */
export function getUninvestigatedItems(websetId?: string, limit = 50): ItemRow[] {
  const d = getDb();
  if (websetId) {
    return d.prepare(`
      SELECT i.* FROM items i
      WHERE i.webset_id = ? AND ${UNINVESTIGATED_WHERE}
      ORDER BY i.received_at DESC
      LIMIT ?
    `).all(websetId, limit) as ItemRow[];
  }
  return d.prepare(`
    SELECT i.* FROM items i
    WHERE ${UNINVESTIGATED_WHERE}
    ORDER BY i.received_at DESC
    LIMIT ?
  `).all(limit) as ItemRow[];
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

// --- Domain normalization ---

export function normalizeDomain(url: string): string {
  let domain = url.toLowerCase().trim();
  // Strip protocol
  domain = domain.replace(/^https?:\/\//, '');
  // Strip path, query, hash
  domain = domain.split('/')[0].split('?')[0].split('#')[0];
  // Strip www.
  domain = domain.replace(/^www\./, '');
  // Strip port
  domain = domain.split(':')[0];
  return domain;
}

// --- Company record operations ---

export interface CompanyRow {
  domain: string;
  canonical_name: string;
  sector: string | null;
  employee_count_signal: string | null;
  icp_fit: number;
  first_seen: string;
  last_seen: string;
}

export interface LensHitRow {
  id: number;
  company_domain: string;
  lens_id: string;
  webset_id: string | null;
  item_id: string | null;
  strength: string;
  evidence_url: string | null;
  evidence_summary: string | null;
  first_seen: string;
  last_seen: string;
}

export interface ScoreRow {
  company_domain: string;
  score: number;
  components: string | null; // JSON
  verdict: string;
  updated_at: string;
}

export interface VerdictRow {
  id: number;
  company_domain: string;
  verdict: string;
  confidence: number | null;
  payload: string | null; // JSON
  created_at: string;
}

export function upsertCompany(
  domain: string,
  name: string,
  sector?: string,
  employeeSignal?: string,
): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO company_records (domain, canonical_name, sector, employee_count_signal)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET
      canonical_name = COALESCE(excluded.canonical_name, company_records.canonical_name),
      sector = COALESCE(excluded.sector, company_records.sector),
      employee_count_signal = COALESCE(excluded.employee_count_signal, company_records.employee_count_signal),
      last_seen = datetime('now')
  `).run(domain, name, sector ?? null, employeeSignal ?? null);
}

export function recordLensHit(
  domain: string,
  lensId: string,
  opts?: {
    websetId?: string;
    itemId?: string;
    strength?: string;
    evidenceUrl?: string;
    evidenceSummary?: string;
  },
): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO lens_hits (company_domain, lens_id, webset_id, item_id, strength, evidence_url, evidence_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_domain, lens_id) DO UPDATE SET
      webset_id = COALESCE(excluded.webset_id, lens_hits.webset_id),
      item_id = COALESCE(excluded.item_id, lens_hits.item_id),
      strength = COALESCE(excluded.strength, lens_hits.strength),
      evidence_url = COALESCE(excluded.evidence_url, lens_hits.evidence_url),
      evidence_summary = COALESCE(excluded.evidence_summary, lens_hits.evidence_summary),
      last_seen = datetime('now')
  `).run(
    domain,
    lensId,
    opts?.websetId ?? null,
    opts?.itemId ?? null,
    opts?.strength ?? 'medium',
    opts?.evidenceUrl ?? null,
    opts?.evidenceSummary ?? null,
  );
}

export function updateScore(
  domain: string,
  score: number,
  components: Record<string, number>,
  verdict: string,
): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO scores (company_domain, score, components, verdict, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(company_domain) DO UPDATE SET
      score = excluded.score,
      components = excluded.components,
      verdict = excluded.verdict,
      updated_at = datetime('now')
  `).run(domain, score, JSON.stringify(components), verdict);
}

export function saveVerdict(
  domain: string,
  verdict: string,
  confidence?: number,
  payload?: unknown,
): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO verdicts (company_domain, verdict, confidence, payload)
    VALUES (?, ?, ?, ?)
  `).run(domain, verdict, confidence ?? null, payload ? JSON.stringify(payload) : null);
}

export function getCompany(domain: string): {
  company: CompanyRow;
  lensHits: LensHitRow[];
  score: ScoreRow | null;
  latestVerdict: VerdictRow | null;
} | null {
  const d = getDb();
  const company = d.prepare('SELECT * FROM company_records WHERE domain = ?').get(domain) as CompanyRow | undefined;
  if (!company) return null;

  const lensHits = d.prepare(
    'SELECT * FROM lens_hits WHERE company_domain = ? ORDER BY first_seen'
  ).all(domain) as LensHitRow[];

  const score = d.prepare(
    'SELECT * FROM scores WHERE company_domain = ?'
  ).get(domain) as ScoreRow | undefined;

  const latestVerdict = d.prepare(
    'SELECT * FROM verdicts WHERE company_domain = ? ORDER BY id DESC LIMIT 1'
  ).get(domain) as VerdictRow | undefined;

  return {
    company,
    lensHits,
    score: score ?? null,
    latestVerdict: latestVerdict ?? null,
  };
}

export function listCandidates(minScore?: number, verdict?: string): Array<{
  company: CompanyRow;
  score: number;
  verdict: string;
  lensHits: string[];
}> {
  const d = getDb();
  let sql = `
    SELECT cr.*, s.score, s.verdict as score_verdict
    FROM company_records cr
    JOIN scores s ON s.company_domain = cr.domain
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (minScore !== undefined) {
    sql += ' AND s.score >= ?';
    params.push(minScore);
  }
  if (verdict) {
    sql += ' AND s.verdict = ?';
    params.push(verdict);
  }
  sql += ' ORDER BY s.score DESC';

  const rows = d.prepare(sql).all(...params) as Array<CompanyRow & { score: number; score_verdict: string }>;

  return rows.map(row => {
    const hits = d.prepare(
      'SELECT lens_id FROM lens_hits WHERE company_domain = ?'
    ).all(row.domain) as Array<{ lens_id: string }>;

    return {
      company: {
        domain: row.domain,
        canonical_name: row.canonical_name,
        sector: row.sector,
        employee_count_signal: row.employee_count_signal,
        icp_fit: row.icp_fit,
        first_seen: row.first_seen,
        last_seen: row.last_seen,
      },
      score: row.score,
      verdict: row.score_verdict,
      lensHits: hits.map(h => h.lens_id),
    };
  });
}

// --- Notebook index operations ---
//
// The `.src.md` file on disk is the source of truth; this table is a thin,
// rebuildable index so notebook.list and channel/store.query consumers can read
// the latest verdict without parsing every file.

export interface NotebookRow {
  slug: string;
  title: string | null;
  path: string;
  statement: string | null;
  latest_verdict: string | null;
  latest_confidence: number | null;
  created_at: string;
  updated_at: string;
}

export function upsertNotebook(nb: {
  slug: string;
  title?: string;
  path: string;
  statement?: string;
  latestVerdict?: string;
  latestConfidence?: number;
}): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO notebooks (slug, title, path, statement, latest_verdict, latest_confidence, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      title = COALESCE(excluded.title, notebooks.title),
      path = excluded.path,
      statement = COALESCE(excluded.statement, notebooks.statement),
      latest_verdict = COALESCE(excluded.latest_verdict, notebooks.latest_verdict),
      latest_confidence = COALESCE(excluded.latest_confidence, notebooks.latest_confidence),
      updated_at = datetime('now')
  `).run(
    nb.slug,
    nb.title ?? null,
    nb.path,
    nb.statement ?? null,
    nb.latestVerdict ?? null,
    nb.latestConfidence ?? null,
  );
}

export function getNotebookIndex(slug: string): NotebookRow | null {
  const row = getDb().prepare('SELECT * FROM notebooks WHERE slug = ?').get(slug) as NotebookRow | undefined;
  return row ?? null;
}

export function listNotebooks(verdict?: string): NotebookRow[] {
  const d = getDb();
  if (verdict) {
    return d.prepare(
      'SELECT * FROM notebooks WHERE latest_verdict = ? ORDER BY updated_at DESC',
    ).all(verdict) as NotebookRow[];
  }
  return d.prepare('SELECT * FROM notebooks ORDER BY updated_at DESC').all() as NotebookRow[];
}
