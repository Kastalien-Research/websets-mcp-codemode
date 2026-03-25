// Store operations — expose the local SQLite shadow to Claude via the execute tool.

import { z } from 'zod';
import type { OperationHandler, ToolResult } from '../handlers/types.js';
import { successResult, errorResult } from '../handlers/types.js';
import {
  annotateItem,
  getItemWithAnnotations,
  getUninvestigatedItems,
  getDb,
} from './db.js';

export const Schemas = {
  annotate: z.object({
    itemId: z.string(),
    type: z.string(),
    value: z.string(),
    source: z.string().optional(),
  }),
  getItem: z.object({
    itemId: z.string(),
  }),
  listUninvestigated: z.object({
    websetId: z.string().optional(),
    limit: z.number().optional(),
  }),
  query: z.object({
    sql: z.string(),
    params: z.array(z.unknown()).optional(),
  }),
};

export const annotate: OperationHandler = async (args) => {
  try {
    const id = annotateItem(
      args.itemId as string,
      args.type as string,
      args.value as string,
      (args.source as string) ?? 'claude',
    );
    return successResult({ annotationId: id });
  } catch (error) {
    return errorResult('store.annotate', error);
  }
};

export const getItem: OperationHandler = async (args) => {
  try {
    const result = getItemWithAnnotations(args.itemId as string);
    if (!result) {
      return successResult({ found: false });
    }
    return successResult({
      found: true,
      item: {
        ...result.item,
        enrichments: result.item.enrichments ? JSON.parse(result.item.enrichments) : null,
        evaluations: result.item.evaluations ? JSON.parse(result.item.evaluations) : null,
      },
      annotations: result.annotations,
    });
  } catch (error) {
    return errorResult('store.getItem', error);
  }
};

export const listUninvestigated: OperationHandler = async (args) => {
  try {
    const limit = (args.limit as number) ?? 50;
    let items = getUninvestigatedItems(args.websetId as string | undefined);
    if (items.length > limit) items = items.slice(0, limit);
    return successResult({
      items: items.map(i => ({
        ...i,
        enrichments: i.enrichments ? JSON.parse(i.enrichments) : null,
        evaluations: i.evaluations ? JSON.parse(i.evaluations) : null,
      })),
      count: items.length,
    });
  } catch (error) {
    return errorResult('store.listUninvestigated', error);
  }
};

export const query: OperationHandler = async (args) => {
  try {
    const sql = (args.sql as string).trim();
    // Only allow SELECT queries for safety
    if (!sql.toUpperCase().startsWith('SELECT')) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: 'Only SELECT queries are allowed via store.query. Use store.annotate for writes.',
        }) }],
        isError: true,
      } satisfies ToolResult;
    }

    const d = getDb();
    const params = (args.params as unknown[]) ?? [];
    const rows = d.prepare(sql).all(...params);
    return successResult({ rows, count: rows.length });
  } catch (error) {
    return errorResult('store.query', error);
  }
};
