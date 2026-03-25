import type { Exa } from 'exa-js';
import { z } from 'zod';
import { OperationHandler, successResult, errorResult, requireParams } from './types.js';
import { filterAndProjectItems } from '../lib/projections.js';

export const Schemas = {
  list: z.object({
    websetId: z.string(),
    limit: z.number().optional(),
    cursor: z.string().optional(),
  }),
  get: z.object({
    websetId: z.string(),
    itemId: z.string(),
  }),
  getAll: z.object({
    websetId: z.string(),
    maxItems: z.number().optional(),
    sourceId: z.string().optional(),
  }),
  del: z.object({
    websetId: z.string(),
    itemId: z.string(),
  }),
};


export const list: OperationHandler = async (args, exa) => {
  const guard = requireParams('items.list', args, 'websetId');
  if (guard) return guard;
  try {
    const response = await exa.websets.items.list(args.websetId as string, {
      limit: args.limit as number | undefined,
      cursor: args.cursor as string | undefined,
    });
    const items = (response as any).data ?? response;
    if (Array.isArray(items)) {
      const projected = filterAndProjectItems(items);
      return successResult({ ...projected, cursor: (response as any).cursor ?? null });
    }
    return successResult(response);
  } catch (error) {
    return errorResult('items.list', error, 'Verify the websetId is valid. Use websets.list to find valid webset IDs.');
  }
};

export const get: OperationHandler = async (args, exa) => {
  const guard = requireParams('items.get', args, 'websetId', 'itemId');
  if (guard) return guard;
  try {
    const response = await exa.websets.items.get(
      args.websetId as string,
      args.itemId as string,
    );
    return successResult(response);
  } catch (error) {
    return errorResult('items.get', error, 'Verify both websetId and itemId are valid. Use items.list to find valid item IDs within a webset.');
  }
};

export const getAll: OperationHandler = async (args, exa) => {
  const guard = requireParams('items.getAll', args, 'websetId');
  if (guard) return guard;
  try {
    const websetId = args.websetId as string;
    const maxItems = (args.maxItems as number | undefined) ?? 1000;
    const opts: Record<string, unknown> = {};
    if (args.sourceId) opts.sourceId = args.sourceId;
    const results: unknown[] = [];
    for await (const item of exa.websets.items.listAll(websetId, opts as any)) {
      results.push(item);
      if (results.length >= maxItems) break;
    }
    const projected = filterAndProjectItems(results);
    return successResult({ ...projected, truncated: results.length >= maxItems });
  } catch (error) {
    return errorResult('items.getAll', error);
  }
};

export const del: OperationHandler = async (args, exa) => {
  const guard = requireParams('items.delete', args, 'websetId', 'itemId');
  if (guard) return guard;
  try {
    const response = await exa.websets.items.delete(
      args.websetId as string,
      args.itemId as string,
    );
    return successResult(response);
  } catch (error) {
    return errorResult('items.delete', error);
  }
};
