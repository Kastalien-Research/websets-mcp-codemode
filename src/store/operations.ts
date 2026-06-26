// Store operations — expose the local SQLite shadow to Claude via the execute tool.

import { z } from 'zod';
import type { OperationHandler, ToolResult } from '../handlers/types.js';
import { successResult, errorResult } from '../handlers/types.js';
import {
  annotateItem,
  getItemWithAnnotations,
  itemExists,
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
  upsertYelpBusiness as dbUpsertYelpBusiness,
  upsertConnectEnrichment as dbUpsertConnectEnrichment,
  connectSchemaHash,
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
    // Raw Exa items emit enrichments as a record; items.getAll projects them as
    // an array of { description, format, result }. Accept both so projected
    // items can be mirrored (db stores it as JSON either way).
    enrichments: z.union([z.record(z.unknown()), z.array(z.unknown())]).optional(),
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
  attachYelp: z.object({
    itemId: z.string(),
    yelp: z.record(z.unknown()),
  }),
  attachConnect: z.object({
    itemId: z.string(),
    providers: z.array(z.string()).min(1),
    structured: z.record(z.string(), z.unknown()),
    query: z.string().optional(),
    grounding: z.unknown().optional(),
    cost: z.number().optional(),
    runId: z.string().optional(),
    effort: z.string().optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
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

export const attachYelp: OperationHandler = async (args) => {
  try {
    const itemId = args.itemId as string;
    const y = args.yelp as Record<string, unknown>;
    const yelpId = y.id as string | undefined;
    if (!yelpId) {
      throw new Error('attachYelp: yelp object is missing required `id` field');
    }
    if (!itemExists(itemId)) {
      throw new Error(
        `attachYelp: item '${itemId}' is not in the local store. Call store.syncItem first so the Yelp data has an item to join to.`,
      );
    }
    const loc = (y.location ?? {}) as Record<string, unknown>;
    const coords = (y.coordinates ?? {}) as Record<string, unknown>;
    const displayAddress = Array.isArray(loc.display_address)
      ? (loc.display_address as string[]).join(', ')
      : undefined;

    dbUpsertYelpBusiness({
      yelpId,
      itemId,
      name: y.name as string | undefined,
      rating: y.rating as number | undefined,
      reviewCount: y.review_count as number | undefined,
      price: y.price as string | undefined,
      phone: y.phone as string | undefined,
      displayAddress,
      latitude: coords.latitude as number | undefined,
      longitude: coords.longitude as number | undefined,
      url: y.url as string | undefined,
      categories: y.categories,
      raw: y,
    });
    return successResult({ yelpId, itemId, attached: true });
  } catch (error) {
    return errorResult('store.attachYelp', error);
  }
};

export const attachConnect: OperationHandler = async (args) => {
  try {
    const itemId = args.itemId as string;
    const providers = args.providers as string[];
    const structured = args.structured as Record<string, unknown>;
    if (!itemExists(itemId)) {
      throw new Error(
        `attachConnect: item '${itemId}' is not in the local store. Call store.syncItem first so the Connect data has an item to join to.`,
      );
    }
    const schemaBasis = (args.outputSchema as unknown) ?? Object.keys(structured).sort();
    const schemaHash = connectSchemaHash(providers, schemaBasis);
    dbUpsertConnectEnrichment({
      itemId,
      providers,
      query: args.query as string | undefined,
      schemaHash,
      structured,
      grounding: args.grounding,
      costDollars: args.cost as number | undefined,
      effort: args.effort as string | undefined,
      runId: args.runId as string | undefined,
    });
    return successResult({ itemId, schemaHash, attached: true });
  } catch (error) {
    return errorResult('store.attachConnect', error);
  }
};
