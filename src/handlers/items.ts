import type { Exa } from 'exa-js';
import { z } from 'zod';
import { OperationHandler, successResult, errorResult, requireParams } from './types.js';
import { filterAndProjectItems } from '../lib/projections.js';
import { upsertItem } from '../store/db.js';

export const Schemas = {
  list: z.object({
    websetId: z.string(),
    limit: z.number().optional(),
    cursor: z.string().optional(),
    // Opt-in: also write fetched items into the local shadow store so they
    // become visible to store.listUninvestigated / the sweep-webset workflow.
    // Items created purely via the API never reach the store otherwise (only
    // the webhook path upserts), so backlog tooling sees nothing without this.
    ingest: z.boolean().optional(),
  }),
  get: z.object({
    websetId: z.string(),
    itemId: z.string(),
  }),
  getAll: z.object({
    websetId: z.string(),
    maxItems: z.number().optional(),
    sourceId: z.string().optional(),
    ingest: z.boolean().optional(),
  }),
  del: z.object({
    websetId: z.string(),
    itemId: z.string(),
  }),
};

// Read-through ingest: mirror raw Exa items into the SQLite shadow store. Mirrors
// the webhook ingest shape (eventBus.ts) so both paths populate the same table.
// Returns the number of items written. Best-effort: a store error never fails the
// read, since ingest is a side benefit of the fetch, not its purpose.
function ingestRawItems(rawItems: unknown[], websetId: string): number {
  let n = 0;
  for (const raw of rawItems) {
    const data = raw as Record<string, unknown> | undefined;
    if (!data?.id) continue;
    const props = (data.properties ?? {}) as Record<string, unknown>;
    const company = props.company as Record<string, unknown> | undefined;
    const person = props.person as Record<string, unknown> | undefined;
    const article = props.article as Record<string, unknown> | undefined;
    const custom = props.custom as Record<string, unknown> | undefined;
    const name = (
      company?.name ?? person?.name ?? article?.title ??
      custom?.title ?? props.description ?? ''
    ) as string;

    const rawEnrichments = data.enrichments as Array<Record<string, unknown>> | undefined;
    const enrichments = rawEnrichments
      ?.filter((e) => (e.result as unknown[] | null)?.length)
      ?.reduce((acc, e) => {
        // No webset-definition lookup here, so key by inline description when
        // present, else the enrichmentId (the webhook path resolves labels).
        const key = (e.description ?? e.enrichmentId ?? 'unknown') as string;
        acc[key] = (e.result as unknown[])[0];
        return acc;
      }, {} as Record<string, unknown>);

    try {
      upsertItem({
        id: data.id as string,
        websetId,
        name: name || undefined,
        url: ((props.url ?? '') as string) || undefined,
        entityType: ((props.type ?? 'unknown') as string) || undefined,
        enrichments,
        evaluations: data.evaluations as unknown[] | undefined,
        raw: data,
        createdAt: data.createdAt as string | undefined,
      });
      n += 1;
    } catch {
      /* best-effort: don't let a store write failure break the read */
    }
  }
  return n;
}


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
      const ingested = args.ingest ? ingestRawItems(items, args.websetId as string) : 0;
      const projected = filterAndProjectItems(items);
      return successResult({ ...projected, cursor: (response as any).cursor ?? null, ingested });
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
    const ingested = args.ingest ? ingestRawItems(results, websetId) : 0;
    const projected = filterAndProjectItems(results);
    return successResult({ ...projected, truncated: results.length >= maxItems, ingested });
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
