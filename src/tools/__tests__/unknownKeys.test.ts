import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { keysAt, nearestKey, rejectUnknownKeys } from '../unknownKeys.js';
import { dispatchOperation } from '../operations.js';
import type { ToolResult } from '../../handlers/types.js';

const issuesOf = (schema: z.ZodTypeAny, value: unknown) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues;
};

describe('rejectUnknownKeys', () => {
  it('rejects an unknown top-level key instead of stripping it', () => {
    const schema = rejectUnknownKeys(z.object({ query: z.string() }));
    const issues = issuesOf(schema, { query: 'q', snapshotAsOf: '2026-06-01' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['snapshotAsOf'], path: [] });
  });

  it('rejects unknown keys in nested objects behind optional, array, record and union', () => {
    const schema = rejectUnknownKeys(z.object({
      contents: z.object({ text: z.boolean() }).optional(),
      criteria: z.array(z.object({ description: z.string() })),
      byName: z.record(z.string(), z.object({ n: z.number() })),
      either: z.union([z.object({ a: z.string() }), z.string()]),
    }));
    const issues = issuesOf(schema, {
      contents: { text: true, snapshotAsOf: 'x' },
      criteria: [{ description: 'd', weight: 1 }],
      byName: { k: { n: 1, extra: true } },
      either: 'fine',
    });
    expect(issues.map(i => i.path.join('.')).sort()).toEqual(['byName.k', 'contents', 'criteria.0']);
  });

  it('keeps objects declared passthrough or catchall', () => {
    const schema = rejectUnknownKeys(z.object({
      input: z.object({ data: z.array(z.unknown()) }).passthrough(),
      meta: z.object({}).catchall(z.string()),
    }));
    expect(schema.safeParse({ input: { data: [], exclusion: [] }, meta: { a: 'b' } }).success).toBe(true);
  });

  it('preserves refinements, defaults and descriptions', () => {
    const schema = rejectUnknownKeys(z.object({
      urls: z.array(z.string()).optional(),
      ids: z.array(z.string()).optional(),
      limit: z.number().default(10).describe('page size'),
    }).refine(v => v.urls !== undefined || v.ids !== undefined, { message: 'urls or ids required' }));
    expect(issuesOf(schema, {})[0].message).toBe('urls or ids required');
    expect(schema.parse({ ids: ['a'] })).toEqual({ ids: ['a'], limit: 10 });
    expect((schema as any)._def.schema.shape.limit.description).toBe('page size');
  });

  it('does not modify the schema it was given', () => {
    const original = z.object({ a: z.string() });
    rejectUnknownKeys(original);
    expect(original.safeParse({ a: 'x', b: 1 }).success).toBe(true);
  });
});

describe('keysAt / nearestKey', () => {
  const schema = z.object({
    query: z.string(),
    contents: z.object({ text: z.boolean(), highlights: z.boolean() }).optional(),
    criteria: z.array(z.object({ description: z.string() })),
  });

  it('finds the keys of the object at a path through optionals and arrays', () => {
    expect(keysAt(schema, [])).toEqual(['query', 'contents', 'criteria']);
    expect(keysAt(schema, ['contents'])).toEqual(['text', 'highlights']);
    expect(keysAt(schema, ['criteria', 0])).toEqual(['description']);
    expect(keysAt(schema, ['query'])).toBeNull();
  });

  it('suggests a close key and nothing for an unrelated one', () => {
    expect(nearestKey('numresults', ['query', 'numResults'])).toBe('numResults');
    expect(nearestKey('hilights', ['text', 'highlights'])).toBe('highlights');
    expect(nearestKey('snapshotAsOf', ['text', 'highlights', 'summary'])).toBeNull();
  });
});

describe('dispatchOperation with unknown keys', () => {
  const exa = {} as any;
  const textOf = (r: ToolResult) => r.content.map(c => ('text' in c ? c.text : '')).join('\n');

  it('rejects a misspelled key, suggests the intended one and lists valid keys', async () => {
    const result = await dispatchOperation('exa.search', { query: 'q', numresults: 3 }, exa);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("'numresults' (did you mean 'numResults'?)");
    expect(text).toContain('Valid keys: query, type, numResults');
  });

  it('rejects snapshotAsOf inside exa.search contents rather than dropping it', async () => {
    const result = await dispatchOperation('exa.search', { query: 'q', contents: { snapshotAsOf: '2026-06-01' } }, exa);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/- contents: Unrecognized key 'snapshotAsOf'.*Valid keys: text, highlights, summary\./);
  });

  it('rejects snapshotAsOf on exa.getContents for both the urls and the ids path', async () => {
    for (const target of [{ urls: ['https://example.com'] }, { ids: ['https://example.com'] }]) {
      const result = await dispatchOperation('exa.getContents', { ...target, snapshotAsOf: '2026-06-01' }, exa);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Unrecognized key 'snapshotAsOf'");
    }
  });
});
