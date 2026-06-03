// Srcbook-style `.src.md` codec.
//
// A thesis notebook is a plain Srcbook `.src.md` document: a header comment
// declaring the language, a single `# Title` cell, markdown cells, and code
// cells introduced by `###### <filename>` headings followed by a fenced block.
// The `package.json` cell is just a code cell whose filename is `package.json`.
//
// Result output (e.g. from notebook.runCell) is represented as a markdown cell
// rather than a bespoke cell type, so the document stays faithful to the
// Srcbook grammar and round-trips to glassBook/Srcbook for human editing.
//
// NOTE: External glassBook/Srcbook import compatibility is NOT verified in this
// repo (no upstream reference files present). The hard guarantee here is the
// encode∘decode round-trip identity covered by srcmd.test.ts.

export interface NotebookMeta {
  /** Srcbook header language, e.g. "typescript" | "javascript". */
  language: string;
}

export type Cell =
  | { type: 'title'; text: string }
  | { type: 'markdown'; text: string }
  | { type: 'code'; filename: string; source: string };

/** Thesis manifest carried in a hidden markdown comment, NOT the srcbook header. */
export interface ThesisManifest {
  slug: string;
  statement: string;
  created: string;
  schemaVersion: number;
}

const HEADER_RE = /^<!--\s*srcbook:(\{[\s\S]*?\})\s*-->/;
const MANIFEST_RE = /<!--\s*thesis:(\{[\s\S]*?\})\s*-->/;

/** Map a filename to its fenced-block language tag. */
function fenceLang(filename: string): string {
  if (filename === 'package.json' || filename.endsWith('.json')) return 'json';
  if (filename.endsWith('.ts') || filename.endsWith('.tsx')) return 'typescript';
  if (filename.endsWith('.js') || filename.endsWith('.jsx') || filename.endsWith('.mjs')) return 'javascript';
  return '';
}

export function encodeManifest(manifest: ThesisManifest): string {
  return `<!-- thesis:${JSON.stringify(manifest)} -->`;
}

export function parseManifest(text: string): ThesisManifest | null {
  const m = text.match(MANIFEST_RE);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as ThesisManifest;
  } catch {
    return null;
  }
}

/** Serialize meta + cells into a `.src.md` document. */
export function encodeNotebook(meta: NotebookMeta, cells: Cell[]): string {
  const parts: string[] = [`<!-- srcbook:${JSON.stringify({ language: meta.language })} -->`];

  for (const cell of cells) {
    if (cell.type === 'title') {
      parts.push(`# ${cell.text}`);
    } else if (cell.type === 'markdown') {
      parts.push(cell.text);
    } else {
      const lang = fenceLang(cell.filename);
      parts.push(`###### ${cell.filename}\n\n\`\`\`${lang}\n${cell.source}\n\`\`\``);
    }
  }

  // Cells are separated by a blank line; trailing newline keeps editors happy.
  return parts.join('\n\n') + '\n';
}

/** Parse a `.src.md` document back into meta + cells. */
export function decodeNotebook(text: string): { meta: NotebookMeta; cells: Cell[] } {
  const headerMatch = text.match(HEADER_RE);
  let meta: NotebookMeta = { language: 'typescript' };
  let body = text;
  if (headerMatch) {
    try {
      const parsed = JSON.parse(headerMatch[1]) as Partial<NotebookMeta>;
      if (parsed.language) meta = { language: parsed.language };
    } catch {
      // Malformed header — fall back to default language.
    }
    body = text.slice(headerMatch[0].length);
  }

  const lines = body.split('\n');
  const cells: Cell[] = [];
  let markdownBuf: string[] = [];

  const flushMarkdown = () => {
    const joined = markdownBuf.join('\n').trim();
    if (joined.length > 0) cells.push({ type: 'markdown', text: joined });
    markdownBuf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Title cell: a single `# ` heading.
    if (/^# (?!#)/.test(line)) {
      flushMarkdown();
      cells.push({ type: 'title', text: line.slice(2).trim() });
      continue;
    }

    // Code/package cell: `###### <filename>` followed by a fenced block.
    const codeHeader = line.match(/^######\s+(.+?)\s*$/);
    if (codeHeader) {
      flushMarkdown();
      const filename = codeHeader[1];
      // Skip blank lines, then expect a ``` fence.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      const fenceOpen = lines[j]?.match(/^```/);
      if (fenceOpen) {
        const srcLines: string[] = [];
        j++;
        while (j < lines.length && !/^```\s*$/.test(lines[j])) {
          srcLines.push(lines[j]);
          j++;
        }
        cells.push({ type: 'code', filename, source: srcLines.join('\n') });
        i = j; // position on the closing fence; loop ++ moves past it
        continue;
      }
      // No fence — treat the header line as markdown after all.
      markdownBuf.push(line);
      continue;
    }

    markdownBuf.push(line);
  }
  flushMarkdown();

  return { meta, cells };
}
