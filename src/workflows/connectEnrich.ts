import type { Exa } from 'exa-js';
import type { TaskStore } from '../lib/taskStore.js';
import { registerWorkflow, type WorkflowMeta } from './types.js';
import { isCancelled, collectItems, withSummary } from './helpers.js';
import { create as agentCreate, get as agentGet } from '../handlers/agentRuns.js';
import { upsertItem, upsertConnectEnrichment, connectSchemaHash } from '../store/db.js';
import { PROVIDER_CATALOG } from '../handlers/connect.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_WAIT_MS = 180_000;

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

/**
 * Poll agentRuns.get until the run reaches a terminal status or the deadline passes.
 * Returns the terminal run object, or null if it timed out or the poll itself errored.
 */
async function pollUntilTerminal(
  runId: string,
  exa: Exa,
  pollIntervalMs: number,
  maxWaitMs: number,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const result = await agentGet({ id: runId }, exa);
    if (result.isError) return null;
    const run = JSON.parse(result.content[0].text) as Record<string, unknown>;
    if (TERMINAL_STATUSES.has(run.status as string)) return run;
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return null;
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
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('providers (string[]) is required');
  }
  const outputSchema = args.outputSchema as Record<string, unknown>;
  if (!outputSchema) throw new Error('outputSchema is required');

  // I1 — Validate providers against the active catalog before loading any data or spending.
  const activeIds = new Set(
    PROVIDER_CATALOG.filter((p) => p.status === 'active' && p.id).map((p) => p.id as string),
  );
  const unusable = providers.filter((p) => !activeIds.has(p));
  if (unusable.length > 0) {
    throw new Error(
      `connect.enrich: provider(s) not usable: ${unusable.join(', ')}. ` +
      `Call connect.providers to see active IDs.`,
    );
  }

  const requestedMax = (args.maxItems as number) ?? 50;
  const envCap = process.env.CONNECT_MAX_ITEMS
    ? parseInt(process.env.CONNECT_MAX_ITEMS, 10)
    : undefined;
  const maxItems = envCap && envCap < requestedMax ? envCap : requestedMax;
  const effort = (args.effort as string) ?? 'low';
  const batchSize = (args.batchSize as number) ?? 25;
  const dryRun = (args.dryRun as boolean) ?? false;
  const pollIntervalMs = (args.pollIntervalMs as number) ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = (args.maxWaitMs as number) ?? DEFAULT_MAX_WAIT_MS;
  const baseQuery = (args.query as string)
    ?? 'Enrich each input row using the attached data partners. Return a `results` array ' +
    "with exactly one object per input row; copy each row's `_itemId` verbatim into its output object.";

  store.updateProgress(taskId, { step: 'loading webset', completed: 1, total: 4 });
  const webset = await exa.websets.get(websetId) as any;
  const entityType = webset?.searches?.[0]?.entity?.type ?? 'unknown';

  store.updateProgress(taskId, { step: 'collecting items', completed: 2, total: 4 });
  const allItems = await collectItems(exa, websetId, maxItems);
  const rows = allItems.map(itemRow).filter((r) => r._itemId);

  const perRowPrice = providers.reduce((sum, p) => sum + priceFor(p), 0);
  const estimatedCost = Math.round(perRowPrice * rows.length * 1000) / 1000;

  if (envCap && requestedMax > envCap) {
    store.updateProgress(taskId, {
      step: 'capped',
      message: `CONNECT_MAX_ITEMS=${envCap} capped ${requestedMax} items`,
      completed: 2,
      total: 4,
    });
  }
  store.updateProgress(taskId, {
    step: 'cost-estimate',
    message: `~$${estimatedCost} for ${rows.length} items × ${providers.length} provider(s) ` +
      '(Agent compute additional)',
    completed: 2,
    total: 4,
  });

  if (dryRun) {
    return withSummary(
      { websetId, providers, entityType, itemCount: rows.length, estimatedCost, dryRun: true },
      `Dry run: ~$${estimatedCost} across ${rows.length} items`,
    );
  }
  if (rows.length === 0) {
    return withSummary(
      { websetId, providers, enriched: 0, failed: 0, costDollars: 0, runIds: [] },
      'No items to enrich',
    );
  }

  // C3 — Wrap the caller's outputSchema so the Agent returns { results: [...] }.
  // Each result object echoes the input row's _itemId for reliable correlation.
  const itemSchema = JSON.parse(JSON.stringify(outputSchema)) as Record<string, unknown>;
  if (itemSchema && itemSchema.type === 'object') {
    itemSchema.properties = {
      ...((itemSchema.properties as Record<string, unknown>) || {}),
      _itemId: { type: 'string', description: 'Echo the input row _itemId verbatim.' },
    };
  }
  const wrappedSchema = {
    type: 'object',
    properties: { results: { type: 'array', items: itemSchema } },
    required: ['results'],
  };

  store.updateProgress(taskId, { step: 'enriching', completed: 3, total: 4 });
  const dataSources = providers.map((provider) => ({ provider }));
  // Hash uses the original outputSchema (user intent), not the wrapped one.
  const schemaHash = connectSchemaHash(providers, outputSchema);
  const runIds: string[] = [];
  let enriched = 0;
  let failed = 0;
  let costDollars = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    if (isCancelled(taskId, store)) break;
    const batch = rows.slice(i, i + batchSize);
    try {
      const createResult = await agentCreate(
        { query: baseQuery, dataSources, outputSchema: wrappedSchema, input: { data: batch }, effort },
        exa,
        { silent: true } as any,
      );
      if (createResult.isError) { failed += batch.length; continue; }
      const initialRun = JSON.parse(createResult.content[0].text) as Record<string, unknown>;
      const runId = initialRun.id as string | undefined;
      if (runId) runIds.push(runId);

      // C1 — Drive the run to a terminal status before reading output.
      // The create response may already be terminal if the run finished synchronously.
      let run: Record<string, unknown> | null = null;
      if (TERMINAL_STATUSES.has(initialRun.status as string)) {
        run = initialRun;
      } else if (runId) {
        run = await pollUntilTerminal(runId, exa, pollIntervalMs, maxWaitMs);
      }

      if (!run || run.status !== 'completed') {
        console.warn(
          `[connect.enrich] batch at index ${i}: run ${runId ?? '?'} did not complete` +
          (run ? ` (status: ${run.status})` : ' (timed out or poll failed)'),
        );
        failed += batch.length;
        continue;
      }

      // C2 — costDollars is an object {total, agentCompute, search, emails, phoneNumbers}.
      const runCost = run.costDollars as Record<string, unknown> | undefined;
      const batchCostTotal = typeof runCost?.total === 'number' ? runCost.total : null;
      if (batchCostTotal !== null) costDollars += batchCostTotal;
      // Split evenly so stored per-row values sum to the batch total.
      const costPerRow = batchCostTotal !== null ? batchCostTotal / batch.length : null;

      // C3 — Read rows from the wrapped results array.
      const agentOutput = run.output as Record<string, unknown> | undefined;
      const agentStructured = agentOutput?.structured as Record<string, unknown> | undefined;
      const resultsRaw = agentStructured?.results;
      const outRows: Array<Record<string, unknown>> = Array.isArray(resultsRaw)
        ? (resultsRaw as Array<Record<string, unknown>>)
        : [];

      for (let j = 0; j < batch.length; j++) {
        const itemId = batch[j]._itemId as string;
        // Prefer _itemId correlation; fall back to positional with a warning.
        let out = outRows.find((o) => o._itemId === itemId);
        if (!out) {
          if (outRows[j]) {
            console.warn(
              `[connect.enrich] low-confidence positional correlation for item ${itemId} ` +
              `at batch position ${j} (no _itemId match found)`,
            );
            out = outRows[j];
          } else {
            failed += 1;
            continue;
          }
        }
        const src = allItems[i + j];
        const props = (src?.properties ?? {}) as Record<string, unknown>;
        upsertItem({
          id: itemId,
          websetId,
          name: (batch[j].name as string) ?? undefined,
          url: (props.url as string) ?? undefined,
          entityType,
        });
        const { _itemId, ...structured } = out;
        void _itemId; // stripped — not persisted
        upsertConnectEnrichment({
          itemId,
          providers,
          query: baseQuery,
          schemaHash,
          structured,
          grounding: agentOutput?.grounding,
          costDollars: costPerRow ?? undefined,
          effort,
          runId: runId ?? undefined,
        });
        enriched += 1;
      }
    } catch (err) {
      console.warn(
        `[connect.enrich] batch starting at index ${i} failed; ` +
        `counting ${batch.length} item(s) as failed`,
        err,
      );
      failed += batch.length;
    }
  }

  store.updateProgress(taskId, { step: 'done', completed: 4, total: 4 });
  return withSummary(
    { websetId, providers, entityType, enriched, failed, estimatedCost, costDollars, runIds, dryRun: false },
    `Enriched ${enriched}/${rows.length} items via ${providers.join(', ')} ` +
    `(actual $${Math.round(costDollars * 1000) / 1000})`,
  );
}

const meta: WorkflowMeta = {
  title: 'Connect Enrich',
  description:
    "Batch-enrich a webset's items with Exa Connect data partners (Similarweb, Fiber.ai, " +
    'Baselayer, …). Runs one Agent call per batch via input.data, fuses partner + web data into ' +
    'your outputSchema, and persists results to the local store (connect_enrichments). Reports ' +
    'cost; honors CONNECT_MAX_ITEMS. Providers are anchored by the item\'s domain/company name ' +
    '(from url/name); ticker- or state-keyed providers (e.g. financial_datasets, baselayer) ' +
    'require that identifier to be present in the item and may under-enrich otherwise.',
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
    { name: 'pollIntervalMs', type: 'number', required: false, description: 'Polling interval (ms) while waiting for agent run', default: 2000 },
    { name: 'maxWaitMs', type: 'number', required: false, description: 'Max total wait (ms) per batch before counting as failed', default: 180000 },
  ],
  steps: [
    'Validate providers against the active catalog',
    'Load webset metadata to determine entity type',
    'Collect items and build input.data rows (with _itemId passthrough)',
    'Estimate cost; if dryRun, stop and return the estimate',
    'Run the Agent per batch with dataSources + wrapped outputSchema; poll until terminal status; persist results via connect_enrichments',
  ],
  output: 'Webset ID, providers, entity type, enriched/failed counts, estimated vs actual cost, and run IDs.',
  example: `await callOperation('tasks.create', {\n  type: 'connect.enrich',\n  args: {\n    websetId: 'webset_abc',\n    providers: ['similarweb', 'fiber_ai'],\n    outputSchema: { type: 'object', properties: { monthlyVisits: { type: 'number' }, employee_count: { type: 'number' } } },\n    maxItems: 25,\n  }\n});`,
  relatedWorkflows: ['verify.enrichments'],
  tags: ['connect', 'enrichment', 'partners', 'similarweb', 'fiber', 'firmographics', 'cost'],
};

registerWorkflow('connect.enrich', runConnectEnrich, meta);
