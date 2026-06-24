// Store operations — expose the local SQLite shadow to Claude via the execute tool.

import { z } from 'zod';
import type { OperationHandler, ToolResult } from '../handlers/types.js';
import { successResult, errorResult } from '../handlers/types.js';
import {
  annotateItem,
  upsertItem,
  getItemWithAnnotations,
  getUninvestigatedItems,
  getUninvestigatedLean,
  countUninvestigatedItems,
  getDb,
  upsertItem as dbUpsertItem,
  upsertCompany as dbUpsertCompany,
  recordLensHit as dbRecordLensHit,
  updateScore as dbUpdateScore,
  saveVerdict as dbSaveVerdict,
  getCompany as dbGetCompany,
  listCandidates as dbListCandidates,
} from './db.js';

export const Schemas = {
  annotate: z.object({
    itemId: z.string(),
    type: z.string(),
    value: z.string(),
    source: z.string().optional(),
  }),
  syncItem: z.object({
    id: z.string(),
    websetId: z.string(),
    name: z.string().optional(),
    url: z.string().optional(),
    entityType: z.string().optional(),
    enrichments: z.record(z.unknown()).optional(),
    evaluations: z.array(z.unknown()).optional(),
    raw: z.unknown().optional(),
    createdAt: z.string().optional(),
  }),
  getItem: z.object({
    itemId: z.string(),
  }),
  listUninvestigated: z.object({
    websetId: z.string().optional(),
    limit: z.number().optional(),
    verbose: z.boolean().optional(),
  }),
  query: z.object({
    sql: z.string(),
    params: z.array(z.unknown()).optional(),
  }),
  syncItem: z.object({
    id: z.string(),
    websetId: z.string(),
    name: z.string().optional(),
    url: z.string().optional(),
    entityType: z.string().optional(),
    enrichments: z.record(z.unknown()).optional(),
    evaluations: z.array(z.unknown()).optional(),
    raw: z.unknown().optional(),
    createdAt: z.string().optional(),
  }),
  upsertCompany: z.object({
    domain: z.string(),
    name: z.string(),
    sector: z.string().optional(),
    employeeSignal: z.string().optional(),
  }),
  recordLensHit: z.object({
    domain: z.string(),
    lensId: z.string(),
    websetId: z.string().optional(),
    itemId: z.string().optional(),
    strength: z.string().optional(),
    evidenceUrl: z.string().optional(),
    evidenceSummary: z.string().optional(),
  }),
  updateScore: z.object({
    domain: z.string(),
    score: z.number(),
    components: z.record(z.number()),
    verdict: z.string(),
  }),
  saveVerdict: z.object({
    domain: z.string(),
    verdict: z.string(),
    confidence: z.number().optional(),
    payload: z.unknown().optional(),
  }),
  getCompany: z.object({
    domain: z.string(),
  }),
  listCandidates: z.object({
    minScore: z.number().optional(),
    verdict: z.string().optional(),
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

export const syncItem: OperationHandler = async (args) => {
  try {
    dbUpsertItem({
      id: args.id as string,
      websetId: args.websetId as string,
      name: args.name as string | undefined,
      url: args.url as string | undefined,
      entityType: args.entityType as string | undefined,
      enrichments: args.enrichments as Record<string, unknown> | undefined,
      evaluations: args.evaluations as unknown[] | undefined,
      raw: args.raw,
      createdAt: args.createdAt as string | undefined,
    });
    return successResult({ id: args.id, synced: true });
  } catch (error) {
    return errorResult('store.syncItem', error);
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
    const websetId = args.websetId as string | undefined;
    const limit = (args.limit as number) ?? 50;
    const total = countUninvestigatedItems(websetId);

    // Default: lean worklist (no `raw`/`evaluations` blobs). Opt into the full
    // record with `verbose: true` when you genuinely need the heavy payload.
    if (args.verbose) {
      const items = getUninvestigatedItems(websetId, limit);
      return successResult({
        items: items.map(i => ({
          ...i,
          enrichments: i.enrichments ? JSON.parse(i.enrichments) : null,
          evaluations: i.evaluations ? JSON.parse(i.evaluations) : null,
        })),
        count: items.length,
        total,
        truncated: items.length < total,
      });
    }

    const rows = getUninvestigatedLean(websetId, limit);
    return successResult({
      items: rows.map(r => ({
        itemId: r.id,
        websetId: r.webset_id,
        name: r.name,
        url: r.url,
        entityType: r.entity_type,
        enrichmentSummary: r.enrichments ? JSON.parse(r.enrichments) : null,
        receivedAt: r.received_at,
      })),
      count: rows.length,
      total,
      truncated: rows.length < total,
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

export const syncItem: OperationHandler = async (args) => {
  try {
    upsertItem({
      id: args.id as string,
      websetId: args.websetId as string,
      name: args.name as string | undefined,
      url: args.url as string | undefined,
      entityType: args.entityType as string | undefined,
      enrichments: args.enrichments as Record<string, unknown> | undefined,
      evaluations: args.evaluations as unknown[] | undefined,
      raw: args.raw,
      createdAt: args.createdAt as string | undefined,
    });
    return successResult({ id: args.id, synced: true });
  } catch (error) {
    return errorResult('store.syncItem', error);
  }
};

export const upsertCompany: OperationHandler = async (args) => {
  try {
    dbUpsertCompany(
      args.domain as string,
      args.name as string,
      args.sector as string | undefined,
      args.employeeSignal as string | undefined,
    );
    return successResult({ domain: args.domain, upserted: true });
  } catch (error) {
    return errorResult('store.upsertCompany', error);
  }
};

export const recordLensHit: OperationHandler = async (args) => {
  try {
    dbRecordLensHit(args.domain as string, args.lensId as string, {
      websetId: args.websetId as string | undefined,
      itemId: args.itemId as string | undefined,
      strength: args.strength as string | undefined,
      evidenceUrl: args.evidenceUrl as string | undefined,
      evidenceSummary: args.evidenceSummary as string | undefined,
    });
    return successResult({ domain: args.domain, lensId: args.lensId, recorded: true });
  } catch (error) {
    return errorResult('store.recordLensHit', error);
  }
};

export const updateScoreOp: OperationHandler = async (args) => {
  try {
    dbUpdateScore(
      args.domain as string,
      args.score as number,
      args.components as Record<string, number>,
      args.verdict as string,
    );
    return successResult({ domain: args.domain, score: args.score, verdict: args.verdict });
  } catch (error) {
    return errorResult('store.updateScore', error);
  }
};

export const saveVerdictOp: OperationHandler = async (args) => {
  try {
    dbSaveVerdict(
      args.domain as string,
      args.verdict as string,
      args.confidence as number | undefined,
      args.payload,
    );
    return successResult({ domain: args.domain, verdict: args.verdict, saved: true });
  } catch (error) {
    return errorResult('store.saveVerdict', error);
  }
};

export const getCompanyOp: OperationHandler = async (args) => {
  try {
    const result = dbGetCompany(args.domain as string);
    if (!result) return successResult({ found: false });
    return successResult({
      found: true,
      ...result,
      score: result.score ? {
        ...result.score,
        components: result.score.components ? JSON.parse(result.score.components) : null,
      } : null,
      latestVerdict: result.latestVerdict ? {
        ...result.latestVerdict,
        payload: result.latestVerdict.payload ? JSON.parse(result.latestVerdict.payload) : null,
      } : null,
    });
  } catch (error) {
    return errorResult('store.getCompany', error);
  }
};

export const listCandidatesOp: OperationHandler = async (args) => {
  try {
    const results = dbListCandidates(
      args.minScore as number | undefined,
      args.verdict as string | undefined,
    );
    return successResult({ candidates: results, count: results.length });
  } catch (error) {
    return errorResult('store.listCandidates', error);
  }
};
