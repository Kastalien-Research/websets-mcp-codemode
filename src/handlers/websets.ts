import type { Exa } from 'exa-js';
import { z } from 'zod';
import { OperationHandler, successResult, errorResult, requireParams } from './types.js';
import { projectWebset } from '../lib/projections.js';

export const Schemas = {
  create: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    externalId: z.string().optional(),
    metadata: z.record(z.string()).optional(),
    searchQuery: z.string().optional(),
    searchCount: z.number().optional(),
    searchCriteria: z.array(z.object({ description: z.string() })).optional(),
    entity: z.object({ type: z.string() }).optional(),
    enrichments: z.array(
      z.object({
        description: z.string(),
        format: z.string().optional(),
        options: z.array(z.object({ label: z.string() })).max(150).optional(),
      }),
    ).optional(),
  }),
  get: z.object({
    id: z.string(),
    expand: z.array(z.string()).optional(),
  }),
  list: z.object({
    limit: z.number().optional(),
    cursor: z.string().optional(),
  }),
  update: z.object({
    id: z.string(),
    metadata: z.record(z.string()).optional(),
  }),
  del: z.object({
    id: z.string(),
  }),
  cancel: z.object({
    id: z.string(),
  }),
  waitUntilIdle: z.object({
    id: z.string(),
    timeout: z.number().optional(),
    pollInterval: z.number().optional(),
  }),
  getAll: z.object({
    maxItems: z.number().optional(),
  }),
  preview: z.object({
    query: z.string(),
    count: z.number().optional(),
    entity: z.object({ type: z.string() }).optional(),
    search: z.boolean().optional(),
  }),
};


export const create: OperationHandler = async (args, exa) => {
  try {
    const params: Record<string, unknown> = {};

    if (args.name) params.name = args.name;
    if (args.description) params.description = args.description;
    if (args.externalId) params.externalId = args.externalId;
    if (args.metadata) params.metadata = args.metadata;

    if (args.searchQuery) {
      const search: Record<string, unknown> = {
        query: args.searchQuery,
        count: (args.searchCount as number) || 10,
      };
      if (args.searchCriteria) search.criteria = args.searchCriteria;
      if (args.entity) search.entity = args.entity;
      params.search = search;
    }

    if (args.enrichments && Array.isArray(args.enrichments) && args.enrichments.length > 0) {
      params.enrichments = args.enrichments;
    }

    const response = await exa.websets.create(params as any);
    return successResult(projectWebset(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('websets.create', error, 'Ensure entity is an object like {type: "company"} and criteria is [{description: "..."}]. searchQuery is required to create a search.');
  }
};

export const get: OperationHandler = async (args, exa) => {
  const guard = requireParams('websets.get', args, 'id');
  if (guard) return guard;
  try {
    const id = args.id as string;
    const expand = args.expand as string[] | undefined;
    const response = await exa.websets.get(id, expand as any);
    return successResult(projectWebset(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('websets.get', error, 'Verify the webset ID exists. Use websets.list to find valid IDs.');
  }
};

export const list: OperationHandler = async (args, exa) => {
  try {
    const opts: Record<string, unknown> = {};
    if (args.limit) opts.limit = args.limit;
    if (args.cursor) opts.cursor = args.cursor;

    const response = await exa.websets.list(opts as any);
    const raw = response as unknown as Record<string, unknown>;
    const data = raw.data as Record<string, unknown>[] | undefined;
    if (data) {
      return successResult({ ...raw, data: data.map(projectWebset) });
    }
    return successResult(response);
  } catch (error) {
    return errorResult('websets.list', error);
  }
};

export const update: OperationHandler = async (args, exa) => {
  const guard = requireParams('websets.update', args, 'id');
  if (guard) return guard;
  try {
    const id = args.id as string;
    const response = await exa.websets.update(id, {
      metadata: args.metadata as Record<string, string> | undefined,
    });
    return successResult(projectWebset(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('websets.update', error);
  }
};

export const del: OperationHandler = async (args, exa) => {
  const guard = requireParams('websets.delete', args, 'id');
  if (guard) return guard;
  try {
    const id = args.id as string;
    const response = await exa.websets.delete(id);
    return successResult(response);
  } catch (error) {
    return errorResult('websets.delete', error);
  }
};

export const cancel: OperationHandler = async (args, exa) => {
  const guard = requireParams('websets.cancel', args, 'id');
  if (guard) return guard;
  try {
    const id = args.id as string;
    const response = await exa.websets.cancel(id);
    return successResult(projectWebset(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('websets.cancel', error);
  }
};

export const waitUntilIdle: OperationHandler = async (args, exa) => {
  const guard = requireParams('websets.waitUntilIdle', args, 'id');
  if (guard) return guard;
  try {
    const id = args.id as string;
    const timeout = (args.timeout as number | undefined) ?? 300_000;
    const pollInterval = (args.pollInterval as number | undefined) ?? 1_000;
    const response = await exa.websets.waitUntilIdle(id, { timeout, pollInterval });
    return successResult(projectWebset(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('websets.waitUntilIdle', error);
  }
};

export const getAll: OperationHandler = async (args, exa) => {
  try {
    const maxItems = (args.maxItems as number | undefined) ?? 100;
    const results: unknown[] = [];
    for await (const item of exa.websets.listAll()) {
      results.push(item);
      if (results.length >= maxItems) break;
    }
    const projected = results.map(r => projectWebset(r as Record<string, unknown>));
    return successResult({ data: projected, count: projected.length, truncated: results.length >= maxItems });
  } catch (error) {
    return errorResult('websets.getAll', error);
  }
};

export const preview: OperationHandler = async (args, exa) => {
  const guard = requireParams('websets.preview', args, 'query');
  if (guard) return guard;
  try {
    const search: Record<string, unknown> = {
      query: args.query,
    };
    if (args.count) search.count = args.count;
    if (args.entity) search.entity = args.entity;

    const params = { search };
    const options = args.search !== undefined ? { search: args.search as boolean } : undefined;
    const response = await exa.websets.preview(params as any, options);
    return successResult(response);
  } catch (error) {
    return errorResult('websets.preview', error);
  }
};
