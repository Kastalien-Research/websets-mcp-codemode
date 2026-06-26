import type { Exa } from 'exa-js';
import type { TaskStore } from '../lib/taskStore.js';
import { registerWorkflow, type WorkflowMeta } from './types.js';
import { isCancelled, collectItems, withSummary } from './helpers.js';
import { create as agentCreate } from '../handlers/agentRuns.js';
import { upsertItem, upsertConnectEnrichment, connectSchemaHash } from '../store/db.js';
import { PROVIDER_CATALOG } from '../handlers/connect.js';

function priceFor(provider: string): number {
  const p = PROVIDER_CATALOG.find((e) => e.id === provider);
  return p?.pricePerCall ?? 0.02; // conservative default when price unknown
}

function deriveDomain(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function itemRow(item: Record<string, unknown>): Record<string, unknown> {
  const props = (item.properties ?? {}) as Record<string, unknown>;
  const company = (props.company ?? {}) as Record<string, unknown>;
  const person = (props.person ?? {}) as Record<string, unknown>;
  return {
    _itemId: item.id,
    name: company.name ?? person.name ?? props.description,
    url: props.url,
    domain: deriveDomain(props.url),
  };
}

export async function runConnectEnrich(
  taskId: string,
  args: Record<string, unknown>,
  exa: Exa,
  store: TaskStore,
): Promise<unknown> {
  const websetId = args.websetId as string;
  if (!websetId) throw new Error('websetId is required');
  const providers = args.providers as string[];
  if (!Array.isArray(providers) || providers.length === 0) throw new Error('providers (string[]) is required');
  const outputSchema = args.outputSchema as Record<string, unknown>;
  if (!outputSchema) throw new Error('outputSchema is required');

  const requestedMax = (args.maxItems as number) ?? 50;
  const envCap = process.env.CONNECT_MAX_ITEMS ? parseInt(process.env.CONNECT_MAX_ITEMS, 10) : undefined;
  const maxItems = envCap && envCap < requestedMax ? envCap : requestedMax;
  const effort = (args.effort as string) ?? 'low';
  const batchSize = (args.batchSize as number) ?? 25;
  const dryRun = (args.dryRun as boolean) ?? false;
  const baseQuery = (args.query as string)
    ?? `Enrich each input row using the attached data partners. Return one structured object per row, echoing its _itemId.`;

  store.updateProgress(taskId, { step: 'loading webset', completed: 1, total: 4 });
  const webset = await exa.websets.get(websetId) as any;
  const entityType = webset?.searches?.[0]?.entity?.type ?? 'unknown';

  store.updateProgress(taskId, { step: 'collecting items', completed: 2, total: 4 });
  const allItems = await collectItems(exa, websetId, maxItems);
  const rows = allItems.map(itemRow).filter((r) => r._itemId);

  const perRowPrice = providers.reduce((sum, p) => sum + priceFor(p), 0);
  const estimatedCost = Math.round(perRowPrice * rows.length * 1000) / 1000;

  if (envCap && requestedMax > envCap) {
    store.updateProgress(taskId, { step: 'capped', message: `CONNECT_MAX_ITEMS=${envCap} capped ${requestedMax} items` });
  }
  store.updateProgress(taskId, {
    step: 'cost-estimate', message: `~$${estimatedCost} for ${rows.length} items × ${providers.length} provider(s) (Agent compute additional)`,
  });

  if (dryRun) {
    return withSummary({ websetId, providers, entityType, itemCount: rows.length, estimatedCost, dryRun: true },
      `Dry run: ~$${estimatedCost} across ${rows.length} items`);
  }
  if (rows.length === 0) {
    return withSummary({ websetId, providers, enriched: 0, failed: 0, costDollars: 0, runIds: [] }, 'No items to enrich');
  }

  store.updateProgress(taskId, { step: 'enriching', completed: 3, total: 4 });
  const dataSources = providers.map((provider) => ({ provider }));
  const schemaHash = connectSchemaHash(providers, outputSchema);
  const runIds: string[] = [];
  let enriched = 0;
  let failed = 0;
  let costDollars = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    if (isCancelled(taskId, store)) break;
    const batch = rows.slice(i, i + batchSize);
    try {
      const result = await agentCreate(
        { query: baseQuery, dataSources, outputSchema, input: { data: batch }, effort },
        exa,
        { silent: true } as any,
      );
      if (result.isError) { failed += batch.length; continue; }
      const run = JSON.parse(result.content[0].text);
      if (run.id) runIds.push(run.id);
      if (typeof run.costDollars === 'number') costDollars += run.costDollars;

      const structuredOut = run?.output?.structured;
      const outRows: Array<Record<string, unknown>> = Array.isArray(structuredOut) ? structuredOut : [];
      for (let j = 0; j < batch.length; j++) {
        const itemId = batch[j]._itemId as string;
        // Correlate by _itemId passthrough; fall back to positional order.
        const out = outRows.find((o) => o._itemId === itemId) ?? outRows[j];
        if (!out) { failed += 1; continue; }
        const src = allItems[i + j];
        const props = (src?.properties ?? {}) as Record<string, unknown>;
        upsertItem({
          id: itemId, websetId,
          name: (batch[j].name as string) ?? undefined,
          url: (props.url as string) ?? undefined,
          entityType,
        });
        const { _itemId, ...structured } = out;
        upsertConnectEnrichment({
          itemId, providers, query: baseQuery, schemaHash, structured,
          grounding: run?.output?.grounding, costDollars: run.costDollars, effort, runId: run.id,
        });
        enriched += 1;
      }
    } catch (err) {
      console.warn(`[connect.enrich] batch starting at index ${i} failed; counting ${batch.length} item(s) as failed`, err);
      failed += batch.length;
    }
  }

  store.updateProgress(taskId, { step: 'done', completed: 4, total: 4 });
  return withSummary(
    { websetId, providers, entityType, enriched, failed, estimatedCost, costDollars, runIds, dryRun: false },
    `Enriched ${enriched}/${rows.length} items via ${providers.join(', ')} (actual $${Math.round(costDollars * 1000) / 1000})`,
  );
}

const meta: WorkflowMeta = {
  title: 'Connect Enrich',
  description: 'Batch-enrich a webset\'s items with Exa Connect data partners (Similarweb, Fiber.ai, Baselayer, …). Runs one Agent call per batch via input.data, fuses partner + web data into your outputSchema, and persists results to the local store (connect_enrichments). Reports cost; honors CONNECT_MAX_ITEMS.',
  category: 'enrichment',
  parameters: [
    { name: 'websetId', type: 'string', required: true, description: 'Webset whose items to enrich' },
    { name: 'providers', type: 'array', required: true, description: 'Connect provider IDs (see connect.providers)' },
    { name: 'outputSchema', type: 'object', required: true, description: 'JSON Schema for the enrichment shape' },
    { name: 'query', type: 'string', required: false, description: 'Natural-language framing; sensible default if omitted' },
    { name: 'maxItems', type: 'number', required: false, description: 'Max items to enrich', default: 50 },
    { name: 'batchSize', type: 'number', required: false, description: 'Items per Agent run (input.data)', default: 25 },
    { name: 'effort', type: 'string', required: false, description: 'low|medium|high|xhigh|auto', default: 'low' },
    { name: 'dryRun', type: 'boolean', required: false, description: 'Return a cost estimate without spending', default: false },
  ],
  steps: [
    'Load webset metadata to determine entity type',
    'Collect items and build input.data rows (with _itemId passthrough)',
    'Estimate cost; if dryRun, stop and return the estimate',
    'Run the Agent per batch with dataSources + outputSchema; persist results via connect_enrichments',
  ],
  output: 'Webset ID, providers, entity type, enriched/failed counts, estimated vs actual cost, and run IDs.',
  example: `await callOperation('tasks.create', {\n  type: 'connect.enrich',\n  args: {\n    websetId: 'webset_abc',\n    providers: ['similarweb', 'fiber_ai'],\n    outputSchema: { type: 'object', properties: { monthlyVisits: { type: 'number' }, employee_count: { type: 'number' } } },\n    maxItems: 25,\n  }\n});`,
  relatedWorkflows: ['verify.enrichments'],
  tags: ['connect', 'enrichment', 'partners', 'similarweb', 'fiber', 'firmographics', 'cost'],
};

registerWorkflow('connect.enrich', runConnectEnrich, meta);
