import type { Exa } from 'exa-js';
import { z } from 'zod';
import { OperationHandler, successResult, errorResult, requireParams } from './types.js';
import { EventTypeEnum } from './eventTypes.js';

// Top-level Search Monitors API (`/monitors/*`). Distinct product from
// the v0 Webset Monitors at `monitors.*` (which routes to
// `/v0/monitors` via `exa.websets.monitors.*`). Standalone scheduled
// searches with their own webhook delivery + semantic deduplication.
// SDK: `exa.monitors.*` (SearchMonitorsClient).

const SearchMonitorSearchSchema = z.object({
  query: z.string(),
  numResults: z.number().optional(),
  includeDomains: z.array(z.string()).optional(),
  excludeDomains: z.array(z.string()).optional(),
  // ContentsOptions: rich, defer to SDK validation.
  contents: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
}).passthrough();

const SearchMonitorTriggerSchema = z.object({
  type: z.literal('interval'),
  period: z.string(),
});

const SearchMonitorWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(EventTypeEnum).optional(),
}).passthrough();

export const Schemas = {
  create: z.object({
    name: z.string().optional(),
    search: SearchMonitorSearchSchema,
    trigger: SearchMonitorTriggerSchema.optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string()).optional(),
    // SDK requires webhook. We default `url` to `${WEBSETS_PUBLIC_URL}/webhooks/exa`
    // when not supplied; caller may pass the whole object to override.
    webhook: SearchMonitorWebhookSchema.optional(),
  }),
  get: z.object({ id: z.string() }),
  list: z.object({
    cursor: z.string().optional(),
    limit: z.number().optional(),
    status: z.enum(['active', 'paused', 'disabled']).optional(),
  }),
  update: z.object({
    id: z.string(),
    name: z.string().optional(),
    // Pause/resume control — primary monitor-lifecycle action. Same enum
    // values as list filter; SDK rejects illegal transitions at API call time.
    status: z.enum(['active', 'paused', 'disabled']).optional(),
    search: SearchMonitorSearchSchema.optional(),
    trigger: SearchMonitorTriggerSchema.optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string()).optional(),
    webhook: SearchMonitorWebhookSchema.optional(),
  }),
  del: z.object({ id: z.string() }),
  trigger: z.object({ id: z.string() }),
  getAll: z.object({
    maxItems: z.number().optional(),
    status: z.enum(['active', 'paused', 'disabled']).optional(),
  }),
  runsList: z.object({
    monitorId: z.string(),
    cursor: z.string().optional(),
    limit: z.number().optional(),
  }),
  runsGet: z.object({
    monitorId: z.string(),
    runId: z.string(),
  }),
};

// Project a SearchMonitor response for stable downstream shape.
function projectSearchMonitor(monitor: Record<string, unknown>): Record<string, unknown> {
  return {
    id: monitor.id,
    name: monitor.name ?? null,
    status: monitor.status ?? null,
    search: monitor.search ?? null,
    trigger: monitor.trigger ?? null,
    webhook: monitor.webhook ?? null,
    nextRunAt: monitor.nextRunAt ?? null,
    metadata: monitor.metadata ?? null,
    createdAt: monitor.createdAt ?? null,
    updatedAt: monitor.updatedAt ?? null,
  };
}

function projectSearchMonitorRun(run: Record<string, unknown>): Record<string, unknown> {
  return {
    id: run.id,
    monitorId: run.monitorId ?? null,
    status: run.status ?? null,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    itemCount: run.itemCount ?? null,
    error: run.error ?? null,
  };
}

// Resolve the webhook payload. Caller-supplied webhook wins; otherwise we
// default `url` from WEBSETS_PUBLIC_URL. Throws if neither is available —
// SearchMonitor.webhook is required by the SDK.
function resolveWebhook(
  webhookArg: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const supplied = webhookArg ?? {};
  if (typeof supplied.url === 'string' && supplied.url.length > 0) {
    return supplied;
  }
  const publicUrl = process.env.WEBSETS_PUBLIC_URL;
  if (!publicUrl) {
    throw new Error(
      'webhook.url is required for searchMonitors. Either pass `webhook: { url: ... }` '
      + 'or set the WEBSETS_PUBLIC_URL environment variable so the server can '
      + 'auto-default it to `${WEBSETS_PUBLIC_URL}/webhooks/exa`.',
    );
  }
  return { ...supplied, url: `${publicUrl}/webhooks/exa` };
}

export const create: OperationHandler = async (args, exa) => {
  const guard = requireParams('searchMonitors.create', args, 'search');
  if (guard) return guard;
  try {
    const params: Record<string, unknown> = {
      search: args.search,
      webhook: resolveWebhook(args.webhook as Record<string, unknown> | undefined),
    };
    if (args.name) params.name = args.name;
    if (args.trigger) params.trigger = args.trigger;
    if (args.outputSchema) params.outputSchema = args.outputSchema;
    if (args.metadata) params.metadata = args.metadata;

    const response = await (exa as any).monitors.create(params);
    return successResult(projectSearchMonitor(response as Record<string, unknown>));
  } catch (error) {
    return errorResult('searchMonitors.create', error);
  }
};

export const get: OperationHandler = async (args, exa) => {
  const guard = requireParams('searchMonitors.get', args, 'id');
  if (guard) return guard;
  try {
    const response = await (exa as any).monitors.get(args.id as string);
    return successResult(projectSearchMonitor(response as Record<string, unknown>));
  } catch (error) {
    return errorResult('searchMonitors.get', error);
  }
};

export const list: OperationHandler = async (args, exa) => {
  try {
    const opts: Record<string, unknown> = {};
    if (args.cursor) opts.cursor = args.cursor;
    if (args.limit) opts.limit = args.limit;
    if (args.status) opts.status = args.status;
    const response = await (exa as any).monitors.list(Object.keys(opts).length > 0 ? opts : undefined);
    const raw = response as Record<string, unknown>;
    const data = raw.data as Record<string, unknown>[] | undefined;
    if (data) {
      return successResult({ ...raw, data: data.map(projectSearchMonitor) });
    }
    return successResult(response);
  } catch (error) {
    return errorResult('searchMonitors.list', error);
  }
};

export const update: OperationHandler = async (args, exa) => {
  const guard = requireParams('searchMonitors.update', args, 'id');
  if (guard) return guard;
  try {
    const id = args.id as string;
    const params: Record<string, unknown> = {};
    if (args.name !== undefined) params.name = args.name;
    if (args.status !== undefined) params.status = args.status;
    if (args.search) params.search = args.search;
    if (args.trigger) params.trigger = args.trigger;
    if (args.outputSchema !== undefined) params.outputSchema = args.outputSchema;
    if (args.metadata !== undefined) params.metadata = args.metadata;
    if (args.webhook) params.webhook = args.webhook;
    const response = await (exa as any).monitors.update(id, params);
    return successResult(projectSearchMonitor(response as Record<string, unknown>));
  } catch (error) {
    return errorResult('searchMonitors.update', error);
  }
};

export const del: OperationHandler = async (args, exa) => {
  const guard = requireParams('searchMonitors.delete', args, 'id');
  if (guard) return guard;
  try {
    const response = await (exa as any).monitors.delete(args.id as string);
    return successResult(projectSearchMonitor(response as Record<string, unknown>));
  } catch (error) {
    return errorResult('searchMonitors.delete', error);
  }
};

export const trigger: OperationHandler = async (args, exa) => {
  const guard = requireParams('searchMonitors.trigger', args, 'id');
  if (guard) return guard;
  try {
    const response = await (exa as any).monitors.trigger(args.id as string);
    return successResult(response);
  } catch (error) {
    return errorResult('searchMonitors.trigger', error);
  }
};

export const getAll: OperationHandler = async (args, exa) => {
  try {
    const maxItems = (args.maxItems as number | undefined) ?? 100;
    const opts: Record<string, unknown> = {};
    if (args.status) opts.status = args.status;
    const results: unknown[] = [];
    for await (const item of (exa as any).monitors.listAll(
      Object.keys(opts).length > 0 ? opts : undefined,
    )) {
      results.push(item);
      if (results.length >= maxItems) break;
    }
    const projected = results.map(r => projectSearchMonitor(r as Record<string, unknown>));
    return successResult({
      data: projected,
      count: projected.length,
      truncated: results.length >= maxItems,
    });
  } catch (error) {
    return errorResult('searchMonitors.getAll', error);
  }
};

export const runsList: OperationHandler = async (args, exa) => {
  const guard = requireParams('searchMonitors.runs.list', args, 'monitorId');
  if (guard) return guard;
  try {
    const monitorId = args.monitorId as string;
    const opts: Record<string, unknown> = {};
    if (args.cursor) opts.cursor = args.cursor;
    if (args.limit) opts.limit = args.limit;
    const response = await (exa as any).monitors.runs.list(
      monitorId,
      Object.keys(opts).length > 0 ? opts : undefined,
    );
    const raw = response as Record<string, unknown>;
    const data = raw.data as Record<string, unknown>[] | undefined;
    if (data) {
      return successResult({ ...raw, data: data.map(projectSearchMonitorRun) });
    }
    return successResult(response);
  } catch (error) {
    return errorResult('searchMonitors.runs.list', error);
  }
};

export const runsGet: OperationHandler = async (args, exa) => {
  const guard = requireParams('searchMonitors.runs.get', args, 'monitorId', 'runId');
  if (guard) return guard;
  try {
    const response = await (exa as any).monitors.runs.get(
      args.monitorId as string,
      args.runId as string,
    );
    return successResult(projectSearchMonitorRun(response as Record<string, unknown>));
  } catch (error) {
    return errorResult('searchMonitors.runs.get', error);
  }
};
