// Notebook persistence: the `.src.md` file is the source of truth; the SQLite
// `notebooks` table (store/db.ts) is a thin, rebuildable index.
//
// Runs are appended as markdown cells carrying a machine-readable
// `<!-- run:{...} -->` comment (mirroring the thesis manifest), so they survive
// the srcbook round-trip as plain markdown while staying parseable.

import fs from 'node:fs';
import path from 'node:path';
import {
  encodeNotebook,
  decodeNotebook,
  encodeManifest,
  parseManifest,
  type Cell,
  type NotebookMeta,
  type ThesisManifest,
} from './srcmd.js';
import {
  upsertNotebook,
  getNotebookIndex,
  listNotebooks,
  type NotebookRow,
} from '../store/db.js';

export interface NotebookRun {
  timestamp: string;
  verdict: string;
  confidence: number;
  evidenceFor: string[];
  evidenceAgainst: string[];
  blindSpots?: string[];
  websetIds?: string[];
}

export interface DecodedNotebook {
  slug: string;
  meta: NotebookMeta;
  cells: Cell[];
  manifest: ThesisManifest | null;
  runs: NotebookRun[];
}

const SCHEMA_VERSION = 1;
const RUN_RE = /<!--\s*run:(\{[\s\S]*?\})\s*-->/g;

function notebooksDir(): string {
  return process.env.NOTEBOOKS_DIR ?? path.resolve('data', 'notebooks');
}

function notebookPath(slug: string): string {
  return path.join(notebooksDir(), `${slug}.src.md`);
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || `notebook-${Date.now()}`;
}

export function notebookExists(slug: string): boolean {
  return fs.existsSync(notebookPath(slug));
}

function writeFile(slug: string, meta: NotebookMeta, cells: Cell[]): string {
  const dir = notebooksDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = notebookPath(slug);
  fs.writeFileSync(filePath, encodeNotebook(meta, cells), 'utf8');
  return filePath;
}

/** Extract the title cell text, falling back to the slug. */
function titleOf(cells: Cell[], slug: string): string {
  const title = cells.find(c => c.type === 'title') as { type: 'title'; text: string } | undefined;
  return title?.text ?? slug;
}

function parseRuns(cells: Cell[]): NotebookRun[] {
  const runs: NotebookRun[] = [];
  for (const cell of cells) {
    if (cell.type !== 'markdown') continue;
    for (const match of cell.text.matchAll(RUN_RE)) {
      try {
        runs.push(JSON.parse(match[1]) as NotebookRun);
      } catch {
        // Skip malformed run comments.
      }
    }
  }
  return runs;
}

/** Create and persist a new thesis notebook scaffold. */
export function createNotebook(opts: { thesis: string; slug?: string }): DecodedNotebook {
  const slug = opts.slug ? slugify(opts.slug) : slugify(opts.thesis);
  if (notebookExists(slug)) {
    return readNotebook(slug);
  }

  const manifest: ThesisManifest = {
    slug,
    statement: opts.thesis,
    created: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
  };

  const meta: NotebookMeta = { language: 'typescript' };
  const cells: Cell[] = [
    { type: 'title', text: `Thesis: ${opts.thesis}` },
    { type: 'markdown', text: `${encodeManifest(manifest)}\n\n> ${opts.thesis}\n\nWorking thesis under investigation. Code cells are Code Mode — re-run them to refresh evidence.` },
    { type: 'code', filename: 'package.json', source: '{\n  "dependencies": {}\n}' },
    { type: 'markdown', text: '## Evidence For\n\n_No evidence gathered yet._' },
    { type: 'markdown', text: '## Evidence Against\n\n_No evidence gathered yet._' },
    { type: 'markdown', text: '## Verdict\n\n_No runs yet._' },
  ];

  const filePath = writeFile(slug, meta, cells);
  upsertNotebook({ slug, title: titleOf(cells, slug), path: filePath, statement: opts.thesis });

  return { slug, meta, cells, manifest, runs: [] };
}

/** Read and decode a notebook from disk. */
export function readNotebook(slug: string): DecodedNotebook {
  const filePath = notebookPath(slug);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Notebook not found: ${slug}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const { meta, cells } = decodeNotebook(text);
  const manifestCell = cells.find(c => c.type === 'markdown') as { type: 'markdown'; text: string } | undefined;
  const manifest = manifestCell ? parseManifest(manifestCell.text) : null;
  return { slug, meta, cells, manifest, runs: parseRuns(cells) };
}

/** Raw `.src.md` text — for notebook.render and glassBook import. */
export function renderNotebook(slug: string): string {
  const filePath = notebookPath(slug);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Notebook not found: ${slug}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

/** Append a cell and rewrite the file. */
export function appendCell(slug: string, cell: Cell): DecodedNotebook {
  const nb = readNotebook(slug);
  const cells = [...nb.cells, cell];
  const filePath = writeFile(slug, nb.meta, cells);
  upsertNotebook({ slug, title: titleOf(cells, slug), path: filePath });
  return { ...nb, cells, runs: parseRuns(cells) };
}

/**
 * Append a `### Run <ts>` section and update the index's latest verdict.
 * This is the typed write-back that makes the verdict queryable.
 */
export function appendRun(slug: string, run: NotebookRun): DecodedNotebook {
  const nb = readNotebook(slug);

  const forList = run.evidenceFor.length ? run.evidenceFor.map(e => `- ${e}`).join('\n') : '_none_';
  const againstList = run.evidenceAgainst.length ? run.evidenceAgainst.map(e => `- ${e}`).join('\n') : '_none_';
  const blind = run.blindSpots?.length ? `\n\n**Blind spots:**\n${run.blindSpots.map(b => `- ${b}`).join('\n')}` : '';
  const websets = run.websetIds?.length ? `\n\n_Websets: ${run.websetIds.join(', ')}_` : '';

  // Runs carry their own <!-- run:{...} --> comment (the manifest helper is for
  // the thesis statement, not runs), so they parse back out via parseRuns.
  const cellText =
    `### Run ${run.timestamp}\n\n` +
    `<!-- run:${JSON.stringify(run)} -->\n\n` +
    `**Verdict:** ${run.verdict} (confidence ${run.confidence.toFixed(2)})\n\n` +
    `**Evidence for:**\n${forList}\n\n` +
    `**Evidence against:**\n${againstList}` +
    blind +
    websets;

  const cells = [...nb.cells, { type: 'markdown' as const, text: cellText }];
  const filePath = writeFile(slug, nb.meta, cells);
  upsertNotebook({
    slug,
    title: titleOf(cells, slug),
    path: filePath,
    latestVerdict: run.verdict,
    latestConfidence: run.confidence,
  });

  return { ...nb, cells, runs: parseRuns(cells) };
}

export function listNotebookIndex(verdict?: string): NotebookRow[] {
  return listNotebooks(verdict);
}

export function getNotebookRow(slug: string): NotebookRow | null {
  return getNotebookIndex(slug);
}
