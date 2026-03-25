import { z } from 'zod';
import { OPERATIONS, OPERATION_SCHEMAS } from './operations.js';
import { workflowRegistry } from '../workflows/types.js';

export interface CatalogEntry {
  name: string;
  domain: string;
  summary: string;
  tags: string[];
  schema: z.ZodTypeAny;
}

export interface SearchOptions {
  detail?: 'brief' | 'detailed' | 'full';
  domain?: string;
  limit?: number;
}

export interface SearchResult {
  results: Array<Record<string, unknown>>;
  total: number;
  showing: number;
  hint?: string;
}

let catalog: CatalogEntry[] | null = null;

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s._\-/]+/).filter(Boolean);
}

function deriveTagsFromSummary(summary: string): string[] {
  const stopWords = new Set(['a', 'an', 'the', 'in', 'on', 'by', 'or', 'and', 'to', 'for', 'all', 'its', 'until', 'if']);
  return tokenize(summary).filter(w => !stopWords.has(w) && w.length > 2);
}

function buildCatalog(): CatalogEntry[] {
  if (catalog) return catalog;

  const entries: CatalogEntry[] = [];

  // Add all operations
  for (const [name, meta] of Object.entries(OPERATIONS)) {
    const domain = name.split('.')[0];
    const nameParts = tokenize(name);
    const summaryTags = deriveTagsFromSummary(meta.summary);
    entries.push({
      name,
      domain,
      summary: meta.summary,
      tags: [...new Set([...nameParts, ...summaryTags])],
      schema: OPERATION_SCHEMAS[name] ?? z.object({}),
    });
  }

  // Add workflow entries as pseudo-operations
  for (const [type] of workflowRegistry) {
    const name = `workflow.${type}`;
    const domain = 'workflow';
    entries.push({
      name,
      domain,
      summary: `Background workflow: ${type} (launch via tasks.create with type="${type}")`,
      tags: [...tokenize(type), 'workflow', 'task', 'background'],
      schema: z.object({ type: z.literal(type) }).catchall(z.unknown()),
    });
  }

  catalog = entries;
  return entries;
}

function zodShapeToParams(schema: z.ZodTypeAny): Array<{ name: string; type: string; required: boolean }> {
  const params: Array<{ name: string; type: string; required: boolean }> = [];

  // Unwrap catchall/passthrough wrappers
  let inner = schema;
  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    for (const [key, val] of Object.entries(shape)) {
      let typeName = 'unknown';
      let required = true;

      let unwrapped = val;
      if (unwrapped instanceof z.ZodOptional) {
        required = false;
        unwrapped = unwrapped.unwrap();
      }
      if (unwrapped instanceof z.ZodDefault) {
        required = false;
        unwrapped = unwrapped.removeDefault();
      }

      if (unwrapped instanceof z.ZodString) typeName = 'string';
      else if (unwrapped instanceof z.ZodNumber) typeName = 'number';
      else if (unwrapped instanceof z.ZodBoolean) typeName = 'boolean';
      else if (unwrapped instanceof z.ZodArray) typeName = 'array';
      else if (unwrapped instanceof z.ZodObject) typeName = 'object';
      else if (unwrapped instanceof z.ZodEnum) typeName = `enum(${(unwrapped as any)._def.values.join('|')})`;
      else if (unwrapped instanceof z.ZodLiteral) typeName = `literal(${JSON.stringify((unwrapped as any)._def.value)})`;

      params.push({ name: key, type: typeName, required });
    }
  }

  return params;
}

function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Simple recursive conversion — covers the shapes used in this project
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      let unwrapped = val;
      let isOptional = false;
      if (unwrapped instanceof z.ZodOptional) { isOptional = true; unwrapped = unwrapped.unwrap(); }
      if (unwrapped instanceof z.ZodDefault) { isOptional = true; unwrapped = unwrapped.removeDefault(); }
      properties[key] = zodToJsonSchema(unwrapped);
      if (!isOptional) required.push(key);
    }
    return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
  }
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: zodToJsonSchema((schema as any)._def.type) };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: (schema as any)._def.values };
  }
  if (schema instanceof z.ZodLiteral) {
    return { const: (schema as any)._def.value };
  }
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema.removeDefault());
  return { type: 'unknown' };
}

function formatEntry(entry: CatalogEntry, detail: 'brief' | 'detailed' | 'full'): Record<string, unknown> {
  if (detail === 'brief') {
    return { name: entry.name, summary: entry.summary };
  }
  if (detail === 'detailed') {
    return {
      name: entry.name,
      summary: entry.summary,
      params: zodShapeToParams(entry.schema),
    };
  }
  // full
  return {
    name: entry.name,
    summary: entry.summary,
    schema: zodToJsonSchema(entry.schema),
  };
}

export function searchCatalog(query: string, options: SearchOptions = {}): SearchResult {
  const { detail = 'brief', domain, limit = 10 } = options;
  const entries = buildCatalog();

  // Filter by domain first if specified
  let candidates = domain
    ? entries.filter(e => e.domain === domain)
    : entries;

  const queryTokens = tokenize(query);

  // If query is empty but domain is set, return all in domain
  if (queryTokens.length === 0) {
    const limited = candidates.slice(0, limit);
    return {
      results: limited.map(e => formatEntry(e, detail)),
      total: candidates.length,
      showing: limited.length,
      ...(limited.length < candidates.length
        ? { hint: `Showing ${limited.length} of ${candidates.length}. Increase limit or refine query.` }
        : {}),
    };
  }

  // Score each entry
  const scored = candidates.map(entry => {
    let score = 0;
    const nameLower = entry.name.toLowerCase();
    const summaryLower = entry.summary.toLowerCase();

    for (const token of queryTokens) {
      // Exact domain match → boost all ops in that domain
      if (token === entry.domain) score += 5;
      // Name match
      if (nameLower.includes(token)) score += 3;
      // Summary match
      if (summaryLower.includes(token)) score += 2;
      // Tag match
      if (entry.tags.some(t => t.includes(token))) score += 1;
    }

    return { entry, score };
  });

  const matched = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const limited = matched.slice(0, limit);

  return {
    results: limited.map(s => formatEntry(s.entry, detail)),
    total: matched.length,
    showing: limited.length,
    ...(limited.length < matched.length
      ? { hint: `Showing ${limited.length} of ${matched.length} matches. Use detail='detailed' for parameter info, or detail='full' for complete schemas.` }
      : {}),
  };
}

/** Reset the catalog cache (for testing). */
export function resetCatalog(): void {
  catalog = null;
}
