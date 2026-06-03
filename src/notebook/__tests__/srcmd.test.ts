import { describe, it, expect } from 'vitest';
import {
  encodeNotebook,
  decodeNotebook,
  encodeManifest,
  parseManifest,
  type Cell,
  type NotebookMeta,
  type ThesisManifest,
} from '../srcmd.js';

const meta: NotebookMeta = { language: 'typescript' };

const manifest: ThesisManifest = {
  slug: 'remote-first-retention',
  statement: 'Remote-first companies retain employees better',
  created: '2026-06-03T00:00:00.000Z',
  schemaVersion: 1,
};

// Representative scaffold: title, manifest-bearing markdown, package.json,
// section markdown, an evidence code cell. Structural elements separate every
// markdown cell so round-trip is identity-preserving.
const cells: Cell[] = [
  { type: 'title', text: 'Thesis: Remote-first companies retain employees better' },
  { type: 'markdown', text: `${encodeManifest(manifest)}\n\nWorking thesis under investigation.` },
  { type: 'code', filename: 'package.json', source: '{\n  "dependencies": {}\n}' },
  { type: 'markdown', text: '## Evidence For' },
  { type: 'code', filename: 'evidence-for.ts', source: "const items = await callOperation('items.list', { websetId });\nreturn items;" },
  { type: 'markdown', text: '## Verdict' },
];

describe('srcmd codec', () => {
  it('round-trips encode∘decode to identity for the scaffold', () => {
    const encoded = encodeNotebook(meta, cells);
    const decoded = decodeNotebook(encoded);
    expect(decoded.meta).toEqual(meta);
    expect(decoded.cells).toEqual(cells);
  });

  it('emits a well-formed srcbook header', () => {
    const encoded = encodeNotebook(meta, cells);
    expect(encoded.startsWith('<!-- srcbook:{"language":"typescript"} -->')).toBe(true);
  });

  it('preserves the thesis manifest through a round-trip', () => {
    const encoded = encodeNotebook(meta, cells);
    const decoded = decodeNotebook(encoded);
    const md = decoded.cells.find(c => c.type === 'markdown') as { type: 'markdown'; text: string };
    expect(parseManifest(md.text)).toEqual(manifest);
  });

  it('keeps the manifest out of the srcbook header', () => {
    const encoded = encodeNotebook(meta, cells);
    const headerLine = encoded.split('\n')[0];
    expect(headerLine).not.toContain('thesis:');
  });

  it('defaults language to typescript when the header is missing', () => {
    const decoded = decodeNotebook('# Just a title\n\nSome prose.\n');
    expect(decoded.meta.language).toBe('typescript');
    expect(decoded.cells[0]).toEqual({ type: 'title', text: 'Just a title' });
  });

  it('parses code cells with fenced sources', () => {
    const decoded = decodeNotebook(
      '<!-- srcbook:{"language":"typescript"} -->\n\n###### run.ts\n\n```typescript\nreturn 1;\n```\n',
    );
    expect(decoded.cells).toEqual([
      { type: 'code', filename: 'run.ts', source: 'return 1;' },
    ]);
  });
});
