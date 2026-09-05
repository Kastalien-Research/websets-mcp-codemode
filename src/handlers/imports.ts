import type { Exa } from 'exa-js';
import { z } from 'zod';
import { OperationHandler, successResult, errorResult, requireParams } from './types.js';
import { projectImport } from '../lib/projections.js';
import { EntitySchema } from '../lib/entitySchema.js';

export const Schemas = {
  create: z.object({
    format: z.literal('csv'),
    entity: EntitySchema,
    count: z.number(),
    size: z.number(),
    title: z.string().optional(),
    csv: z.object({ identifier: z.number().optional().describe('CSV column containing the entity identifier; passed through to the provider.') }).optional(),
    metadata: z.record(z.string()).optional(),
  }),
  get: z.object({
    id: z.string(),
  }),
  list: z.object({
    limit: z.number().optional(),
    cursor: z.string().optional(),
  }),
  update: z.object({
    id: z.string(),
    metadata: z.record(z.string()).optional(),
    title: z.string().optional(),
  }),
  waitUntilCompleted: z.object({
    id: z.string(),
    timeout: z.number().optional(),
    pollInterval: z.number().optional(),
  }),
  getAll: z.object({
    maxItems: z.number().optional(),
  }),
  del: z.object({
    id: z.string(),
  }),
};


export const create: OperationHandler = async (args, exa) => {
  const guard = requireParams('imports.create', args, 'format', 'entity', 'count', 'size');
  if (guard) return guard;
  try {
    const params: Record<string, unknown> = {
      format: args.format,
      entity: args.entity,
      count: args.count,
      size: args.size,
    };
    if (args.title) params.title = args.title;
    if (args.csv) params.csv = args.csv;
    if (args.metadata) params.metadata = args.metadata;

    const response = await exa.websets.imports.create(params as any);
    return successResult(projectImport(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('imports.create', error);
  }
};

export const get: OperationHandler = async (args, exa) => {
  const guard = requireParams('imports.get', args, 'id');
  if (guard) return guard;
  try {
    const response = await exa.websets.imports.get(args.id as string);
    return successResult(projectImport(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('imports.get', error);
  }
};

export const list: OperationHandler = async (args, exa) => {
  try {
    const opts: Record<string, unknown> = {};
    if (args.limit) opts.limit = args.limit;
    if (args.cursor) opts.cursor = args.cursor;

    const response = await exa.websets.imports.list(opts as any);
    const raw = response as unknown as Record<string, unknown>;
    const data = raw.data as Record<string, unknown>[] | undefined;
    if (data) {
      return successResult({ ...raw, data: data.map(projectImport) });
    }
    return successResult(response);
  } catch (error) {
    return errorResult('imports.list', error);
  }
};

export const update: OperationHandler = async (args, exa) => {
  const guard = requireParams('imports.update', args, 'id');
  if (guard) return guard;
  try {
    const id = args.id as string;
    const params: Record<string, unknown> = {};
    if (args.metadata !== undefined) params.metadata = args.metadata;
    if (args.title) params.title = args.title;

    const response = await exa.websets.imports.update(id, params as any);
    return successResult(projectImport(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('imports.update', error);
  }
};

export const waitUntilCompleted: OperationHandler = async (args, exa) => {
  const guard = requireParams('imports.waitUntilCompleted', args, 'id');
  if (guard) return guard;
  try {
    const id = args.id as string;
    const timeout = (args.timeout as number | undefined) ?? 300_000;
    const pollInterval = (args.pollInterval as number | undefined) ?? 2_000;
    const response = await exa.websets.imports.waitUntilCompleted(id, { timeout, pollInterval });
    return successResult(projectImport(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('imports.waitUntilCompleted', error);
  }
};

export const getAll: OperationHandler = async (args, exa) => {
  try {
    const maxItems = (args.maxItems as number | undefined) ?? 100;
    const results: unknown[] = [];
    for await (const item of exa.websets.imports.listAll()) {
      results.push(item);
      if (results.length >= maxItems) break;
    }
    const projected = results.map(r => projectImport(r as Record<string, unknown>));
    return successResult({ data: projected, count: projected.length, truncated: results.length >= maxItems });
  } catch (error) {
    return errorResult('imports.getAll', error);
  }
};

export const del: OperationHandler = async (args, exa) => {
  const guard = requireParams('imports.delete', args, 'id');
  if (guard) return guard;
  try {
    const response = await exa.websets.imports.delete(args.id as string);
    return successResult(projectImport(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('imports.delete', error);
  }
};
