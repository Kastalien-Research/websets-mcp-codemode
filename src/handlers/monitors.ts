import type { Exa } from 'exa-js';
import { z } from 'zod';
import { OperationHandler, successResult, errorResult, requireParams, validationError } from './types.js';
import { projectMonitor, projectMonitorRun } from '../lib/projections.js';

export const Schemas = {
  create: z.object({
    websetId: z.string(),
    cron: z.string().regex(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/, 'Must have exactly 5 fields'),
    timezone: z.string().optional(),
    query: z.string().optional(),
    criteria: z.array(z.object({ description: z.string() })).optional(),
    entity: z.object({ type: z.string() }).optional(),
    count: z.number().min(1).optional(),
    behavior: z.any().optional(),
    metadata: z.record(z.string()).optional(),
  }),
  get: z.object({
    id: z.string(),
  }),
  list: z.object({
    limit: z.number().optional(),
    cursor: z.string().optional(),
    websetId: z.string().optional(),
  }),
  update: z.object({
    id: z.string(),
    cadence: z.any().optional(),
    behavior: z.any().optional(),
    metadata: z.record(z.string()).optional(),
    status: z.enum(['active', 'paused', 'deleted']).optional(),
  }),
  del: z.object({
    id: z.string(),
  }),
  getAll: z.object({
    maxItems: z.number().optional(),
    websetId: z.string().optional(),
  }),
  runsList: z.object({
    monitorId: z.string(),
    limit: z.number().optional(),
    cursor: z.string().optional(),
  }),
  runsGet: z.object({
    monitorId: z.string(),
    runId: z.string(),
  }),
};


export const create: OperationHandler = async (args, exa) => {
  const guard = requireParams('monitors.create', args, 'websetId', 'cron');
  if (guard) return guard;
  try {
    const cron = args.cron as string;
    const count = args.count as number | undefined;

    // Application-level validation: count must be >= 1
    if (count !== undefined && count < 1) {
      return validationError(`Invalid count: ${count}. Must be at least 1.`);
    }

    // Application-level validation: cron must have exactly 5 fields
    const cronFields = cron.trim().split(/\s+/);
    if (cronFields.length !== 5) {
      return validationError(`Invalid cron expression: "${cron}". Must have exactly 5 fields (minute hour day month weekday). Examples: "0 9 * * 1" (every Monday at 9am), "0 0 * * *" (daily at midnight)`);
    }

    const cadence: Record<string, unknown> = { cron };
    if (args.timezone) cadence.timezone = args.timezone;

    const config: Record<string, unknown> = {};
    if (args.query) config.query = args.query;
    if (args.criteria) config.criteria = args.criteria;
    if (args.entity) config.entity = args.entity;
    if (count) config.count = count;
    if (args.behavior) config.behavior = args.behavior;

    const params: Record<string, unknown> = {
      websetId: args.websetId,
      cadence,
      behavior: { type: 'search', config },
    };
    if (args.metadata) params.metadata = args.metadata;

    const response = await exa.websets.monitors.create(params as any);
    return successResult(projectMonitor(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('monitors.create', error, 'Ensure websetId is valid, cron has exactly 5 fields (e.g., "0 9 * * 1"), and entity is an object like {type: "company"}.');
  }
};

export const get: OperationHandler = async (args, exa) => {
  const guard = requireParams('monitors.get', args, 'id');
  if (guard) return guard;
  try {
    const response = await exa.websets.monitors.get(args.id as string);
    return successResult(projectMonitor(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('monitors.get', error);
  }
};

export const list: OperationHandler = async (args, exa) => {
  try {
    const opts: Record<string, unknown> = {};
    if (args.limit) opts.limit = args.limit;
    if (args.cursor) opts.cursor = args.cursor;
    if (args.websetId) opts.websetId = args.websetId;

    const response = await exa.websets.monitors.list(opts as any);
    const raw = response as unknown as Record<string, unknown>;
    const data = raw.data as Record<string, unknown>[] | undefined;
    if (data) {
      return successResult({ ...raw, data: data.map(projectMonitor) });
    }
    return successResult(response);
  } catch (error) {
    return errorResult('monitors.list', error);
  }
};

export const update: OperationHandler = async (args, exa) => {
  const guard = requireParams('monitors.update', args, 'id');
  if (guard) return guard;
  try {
    const id = args.id as string;
    const params: Record<string, unknown> = {};
    if (args.cadence) params.cadence = args.cadence;
    if (args.behavior) params.behavior = args.behavior;
    if (args.metadata !== undefined) params.metadata = args.metadata;
    if (args.status) params.status = args.status;

    const response = await exa.websets.monitors.update(id, params as any);
    return successResult(projectMonitor(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('monitors.update', error);
  }
};

export const del: OperationHandler = async (args, exa) => {
  const guard = requireParams('monitors.delete', args, 'id');
  if (guard) return guard;
  try {
    const response = await exa.websets.monitors.delete(args.id as string);
    return successResult(projectMonitor(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('monitors.delete', error);
  }
};

export const getAll: OperationHandler = async (args, exa) => {
  try {
    const maxItems = (args.maxItems as number | undefined) ?? 100;
    const opts: Record<string, unknown> = {};
    if (args.websetId) opts.websetId = args.websetId;
    const results: unknown[] = [];
    for await (const item of exa.websets.monitors.listAll(opts as any)) {
      results.push(item);
      if (results.length >= maxItems) break;
    }
    const projected = results.map(r => projectMonitor(r as Record<string, unknown>));
    return successResult({ data: projected, count: projected.length, truncated: results.length >= maxItems });
  } catch (error) {
    return errorResult('monitors.getAll', error);
  }
};

export const runsList: OperationHandler = async (args, exa) => {
  const guard = requireParams('monitors.runs.list', args, 'monitorId');
  if (guard) return guard;
  try {
    const opts: Record<string, unknown> = {};
    if (args.limit) opts.limit = args.limit;
    if (args.cursor) opts.cursor = args.cursor;

    const response = await exa.websets.monitors.runs.list(
      args.monitorId as string,
      opts as any,
    );
    const raw = response as unknown as Record<string, unknown>;
    const data = raw.data as Record<string, unknown>[] | undefined;
    if (data) {
      return successResult({ ...raw, data: data.map(projectMonitorRun) });
    }
    return successResult(response);
  } catch (error) {
    return errorResult('monitors.runs.list', error);
  }
};

export const runsGet: OperationHandler = async (args, exa) => {
  const guard = requireParams('monitors.runs.get', args, 'monitorId', 'runId');
  if (guard) return guard;
  try {
    const response = await exa.websets.monitors.runs.get(
      args.monitorId as string,
      args.runId as string,
    );
    return successResult(projectMonitorRun(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('monitors.runs.get', error);
  }
};
