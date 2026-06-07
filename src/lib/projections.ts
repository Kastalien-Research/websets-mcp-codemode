// Response projection functions — extract decision-relevant fields, drop noise.
// Applied at the handler output boundary so workflow internals use full raw data.

// --- Item name extraction (shared with helpers.ts:summarizeItem) ---

function extractItemFields(item: Record<string, unknown>): {
  name: string;
  url: string;
  entityType: string;
  description: string;
} {
  const props = item.properties as Record<string, unknown> | undefined;
  if (!props) return { name: 'unknown', url: '', entityType: 'unknown', description: '' };

  const company = props.company as Record<string, unknown> | undefined;
  const person = props.person as Record<string, unknown> | undefined;
  const article = props.article as Record<string, unknown> | undefined;
  const researchPaper = props.researchPaper as Record<string, unknown> | undefined;
  const custom = props.custom as Record<string, unknown> | undefined;

  const name = (
    company?.name ?? person?.name ?? article?.title ??
    researchPaper?.title ?? custom?.title ?? props.description ?? 'unknown'
  ) as string;

  const url = (props.url ?? '') as string;
  const entityType = (props.type ?? 'unknown') as string;
  const description = (props.description ?? '') as string;

  return { name, url, entityType, description };
}

// --- Item projection ---

function hasSatisfiedEvaluation(item: Record<string, unknown>): boolean {
  const evaluations = item.evaluations as Array<Record<string, unknown>> | undefined;
  if (!evaluations || evaluations.length === 0) return true; // no criteria = pass
  return evaluations.some(e => e.satisfied === 'yes');
}

export function projectItem(item: Record<string, unknown>): Record<string, unknown> {
  const { name, url, entityType, description } = extractItemFields(item);

  const evaluations = item.evaluations as Array<Record<string, unknown>> | undefined;
  const projectedEvals = evaluations?.map(e => ({
    criterion: e.criterion,
    satisfied: e.satisfied,
  })) ?? null;

  const enrichments = item.enrichments as Array<Record<string, unknown>> | undefined;
  // Raw item enrichments carry `enrichmentId` (e.g. "wenrich_…") but usually no
  // inline `description`. Surface the id so callers can map each value back to
  // its criterion via the webset's enrichment list (projectWebset exposes id +
  // description) instead of relying on array position.
  const projectedEnrichments = enrichments?.map(e => ({
    enrichmentId: e.enrichmentId ?? null,
    description: e.description ?? null,
    format: e.format,
    result: e.result,
  })) ?? null;

  return {
    id: item.id,
    name,
    url,
    entityType,
    description,
    evaluations: projectedEvals,
    enrichments: projectedEnrichments,
  };
}

export function filterAndProjectItems(items: unknown[]): {
  data: unknown[];
  total: number;
  included: number;
  excluded: number;
} {
  const total = items.length;
  const passing = (items as Record<string, unknown>[]).filter(hasSatisfiedEvaluation);
  const data = passing.map(projectItem);
  return {
    data,
    total,
    included: data.length,
    excluded: total - data.length,
  };
}

// --- Webset projection ---

export function projectWebset(webset: Record<string, unknown>): Record<string, unknown> {
  const searches = webset.searches as Array<Record<string, unknown>> | undefined;
  const enrichments = webset.enrichments as Array<Record<string, unknown>> | undefined;
  const monitors = webset.monitors as Array<Record<string, unknown>> | undefined;
  const imports = webset.imports as Array<Record<string, unknown>> | undefined;

  // Promote entityType from first search
  const firstSearch = searches?.[0] as Record<string, unknown> | undefined;
  const searchEntity = firstSearch?.entity as Record<string, unknown> | undefined;
  const entityType = (searchEntity?.type ?? null) as string | null;

  return {
    id: webset.id,
    status: webset.status,
    title: webset.title ?? null,
    entityType,
    metadata: webset.metadata ?? null,
    searches: searches?.map(s => {
      const prog = s.progress as Record<string, unknown> | undefined;
      return {
        id: s.id,
        status: s.status,
        query: s.query,
        progress: prog ? {
          found: prog.found,
          completion: prog.completion,
          timeLeft: prog.timeLeft,
        } : null,
      };
    }) ?? null,
    enrichments: enrichments?.map(e => ({
      id: e.id,
      status: e.status,
      description: e.description,
      format: e.format,
    })) ?? null,
    monitors: monitors?.map(m => ({
      id: m.id,
      status: m.status,
      nextRunAt: m.nextRunAt ?? null,
    })) ?? null,
    imports: imports?.map(i => ({
      id: i.id,
      status: i.status,
      count: i.count ?? null,
    })) ?? null,
  };
}

// --- Search projection ---

export function projectSearch(search: Record<string, unknown>): Record<string, unknown> {
  const prog = search.progress as Record<string, unknown> | undefined;
  const criteria = search.criteria as Array<Record<string, unknown>> | undefined;

  return {
    id: search.id,
    status: search.status,
    query: search.query,
    metadata: search.metadata ?? null,
    progress: prog ? {
      found: prog.found,
      analyzed: prog.analyzed,
      completion: prog.completion,
      timeLeft: prog.timeLeft,
    } : null,
    criteria: criteria?.map(c => ({
      description: c.description,
      successRate: c.successRate,
    })) ?? null,
  };
}

// --- Enrichment projection ---

export function projectEnrichment(enrichment: Record<string, unknown>): Record<string, unknown> {
  // Preserve title, websetId, instructions, options, timestamps. Without
  // these, callers can't verify what options/instructions are active after
  // create and can't associate an enrichment with its webset.
  return {
    id: enrichment.id,
    websetId: enrichment.websetId ?? null,
    title: enrichment.title ?? null,
    status: enrichment.status,
    description: enrichment.description,
    instructions: enrichment.instructions ?? null,
    format: enrichment.format,
    options: enrichment.options ?? null,
    metadata: enrichment.metadata ?? null,
    createdAt: enrichment.createdAt ?? null,
    updatedAt: enrichment.updatedAt ?? null,
  };
}

// --- Monitor projection ---

export function projectMonitor(monitor: Record<string, unknown>): Record<string, unknown> {
  const lastRun = monitor.lastRun as Record<string, unknown> | undefined;
  return {
    id: monitor.id,
    status: monitor.status,
    nextRunAt: monitor.nextRunAt ?? null,
    metadata: monitor.metadata ?? null,
    lastRun: lastRun ? {
      status: lastRun.status,
      completedAt: lastRun.completedAt ?? null,
    } : null,
  };
}

export function projectMonitorRun(run: Record<string, unknown>): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    type: run.type ?? null,
    completedAt: run.completedAt ?? null,
    failedReason: run.failedReason ?? null,
  };
}

// --- Webhook projection ---

export function projectWebhook(webhook: Record<string, unknown>): Record<string, unknown> {
  return {
    id: webhook.id,
    status: webhook.status,
    url: webhook.url,
    events: webhook.events,
    metadata: webhook.metadata ?? null,
  };
}

export function projectWebhookAttempt(attempt: Record<string, unknown>): Record<string, unknown> {
  // Preserve id (so callers can correlate retries) and request/response
  // bodies (so callers can debug delivery failures). Previously stripped.
  return {
    id: attempt.id ?? null,
    eventType: attempt.eventType,
    successful: attempt.successful,
    responseStatusCode: attempt.responseStatusCode,
    attemptedAt: attempt.attemptedAt,
    createdAt: attempt.createdAt ?? null,
    request: attempt.request ?? null,
    response: attempt.response ?? null,
  };
}

// --- Import projection ---

export function projectImport(imp: Record<string, unknown>): Record<string, unknown> {
  return {
    id: imp.id,
    status: imp.status,
    count: imp.count ?? null,
    title: imp.title ?? null,
    metadata: imp.metadata ?? null,
    failedReason: imp.failedReason ?? null,
  };
}

// --- Event projection ---

export function projectEvent(event: Record<string, unknown>): Record<string, unknown> {
  // Preserve the spec's `Event.data` payload. Stripping it broke channel-bridge
  // dispatch routing (channel.ts reads `payload.data.websetId` to route by
  // webset). Forward the full data field as-is; downstream consumers can shape
  // it further if needed.
  return {
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    data: event.data ?? null,
  };
}

// --- Research projection ---

export function projectResearch(research: Record<string, unknown>): Record<string, unknown> {
  const status = research.status as string;
  const base: Record<string, unknown> = {
    researchId: research.researchId ?? research.id,
    status,
    model: research.model ?? null,
  };

  if (status === 'completed') {
    const output = research.output as Record<string, unknown> | string | undefined;
    const costDollars = research.costDollars as Record<string, unknown> | undefined;
    base.output = output ?? null;
    if (costDollars) base.cost = costDollars.total ?? null;
  }

  return base;
}
