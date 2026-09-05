import { z } from 'zod';
import { inputJsonSchema, schemaParameters } from '../lib/jsonSchema.js';
import { workflowArgumentSchema } from '../workflows/schemas.js';
import { OPERATIONS, OPERATION_SCHEMAS } from './operations.js';
import { workflowRegistry, workflowMetadata } from '../workflows/types.js';

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
    const meta = workflowMetadata.get(type);
    const summary = meta
      ? meta.description
      : `Background workflow: ${type} (launch via tasks.create with type="${type}")`;
    const tags = meta
      ? [...tokenize(type), 'workflow', ...meta.tags]
      : [...tokenize(type), 'workflow', 'task', 'background'];
    entries.push({
      name,
      domain,
      summary,
      tags: [...new Set(tags)],
      schema: workflowArgumentSchema(type),
    });
  }

  catalog = entries;
  return entries;
}

function formatEntry(entry: CatalogEntry, detail: 'brief' | 'detailed' | 'full'): Record<string, unknown> {
  if (detail === 'brief') {
    return { name: entry.name, summary: entry.summary };
  }
  const prose = entry.domain === 'workflow'
    ? new Map(workflowMetadata.get(entry.name.slice('workflow.'.length))?.parameters.map(p => [p.name, p.description]) ?? [])
    : new Map<string, string>();
  if (detail === 'detailed') {
    return {
      name: entry.name,
      summary: entry.summary,
      params: schemaParameters(entry.schema).map(p => ({ ...p, description: prose.get(p.name) ?? p.description })),
    };
  }
  // Full input schema, with prose from workflow documentation where available.
  const schema = inputJsonSchema(entry.schema);
  for (const [name, description] of prose) {
    if (schema.properties?.[name]) schema.properties[name].description = description;
  }
  return {
    name: entry.name,
    summary: entry.summary,
    schema,
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
      ? { hint: `Showing ${limited.length} of ${matched.length} matches. Use detail='full' for complete JSON schemas, or detail='brief' to skip param info.` }
      : {}),
  };
}

/** Reset the catalog cache (for testing). */
export function resetCatalog(): void {
  catalog = null;
}
