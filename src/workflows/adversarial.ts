import type { Exa } from 'exa-js';
import type { TaskStore } from '../lib/taskStore.js';
import { registerWorkflow, type WorkflowMeta } from './types.js';
import {
  createStepTracker,
  isCancelled,
  pollUntilIdle,
  collectItems,
  summarizeItem,
  validateRequired,
  withSummary,
  type StepTiming,
} from './helpers.js';
import { filterAndProjectItems } from '../lib/projections.js';

export interface AdversarialInput {
  thesisQuery: string;
  antithesisQuery: string;
  entity?: { type: string };
  count: number;
  enrichments?: Array<Record<string, unknown>>;
  timeoutMs: number;
  /** Denominator for progress reporting (adversarial uses 5 or 7). */
  totalSteps: number;
}

export interface AdversarialCore {
  thesisWebset: any;
  thesisItems: Record<string, unknown>[];
  antithesisWebset: any;
  antithesisItems: Record<string, unknown>[];
  cancelled: boolean;
  steps: StepTiming[];
}

/**
 * Shared adversarial evidence-gathering core: create a thesis and antithesis
 * webset, poll both to idle, and collect their items. Used by both
 * `adversarial.verify` (which layers projection/synthesis on top) and
 * `thesis.investigate` (which layers a deterministic verdict on top).
 *
 * Honors cancellation between phases, cancelling any created websets. On
 * cancellation returns `{ cancelled: true }` with whatever was collected so far.
 */
export async function runAdversarial(
  taskId: string,
  store: TaskStore,
  exa: Exa,
  input: AdversarialInput,
): Promise<AdversarialCore> {
  const tracker = createStepTracker();
  const { thesisQuery, antithesisQuery, entity, count, enrichments, timeoutMs, totalSteps } = input;

  const empty = (cancelled: boolean, partial: Partial<AdversarialCore> = {}): AdversarialCore => ({
    thesisWebset: partial.thesisWebset,
    thesisItems: partial.thesisItems ?? [],
    antithesisWebset: partial.antithesisWebset,
    antithesisItems: partial.antithesisItems ?? [],
    cancelled,
    steps: tracker.steps,
  });

  if (isCancelled(taskId, store)) return empty(true);

  // Create thesis webset
  const step1 = Date.now();
  store.updateProgress(taskId, { step: 'creating thesis webset', completed: 1, total: totalSteps });
  const thesisParams: Record<string, unknown> = { search: { query: thesisQuery, count, entity } };
  if (enrichments) thesisParams.enrichments = enrichments;
  const thesisWebset = await exa.websets.create(thesisParams as any);
  tracker.track('create-thesis', step1);

  if (isCancelled(taskId, store)) {
    await exa.websets.cancel(thesisWebset.id);
    return empty(true, { thesisWebset });
  }

  // Create antithesis webset
  const step2 = Date.now();
  store.updateProgress(taskId, { step: 'creating antithesis webset', completed: 2, total: totalSteps });
  const antithesisParams: Record<string, unknown> = { search: { query: antithesisQuery, count, entity } };
  if (enrichments) antithesisParams.enrichments = enrichments;
  const antithesisWebset = await exa.websets.create(antithesisParams as any);
  tracker.track('create-antithesis', step2);

  if (isCancelled(taskId, store)) {
    await exa.websets.cancel(thesisWebset.id);
    await exa.websets.cancel(antithesisWebset.id);
    return empty(true, { thesisWebset, antithesisWebset });
  }

  // Poll thesis
  const step3 = Date.now();
  store.updateProgress(taskId, { step: 'polling thesis', completed: 3, total: totalSteps });
  await pollUntilIdle({ exa, websetId: thesisWebset.id, taskId, store, timeoutMs, stepNum: 3, totalSteps });
  tracker.track('poll-thesis', step3);

  if (isCancelled(taskId, store)) return empty(true, { thesisWebset, antithesisWebset });

  // Poll antithesis
  const step4 = Date.now();
  store.updateProgress(taskId, { step: 'polling antithesis', completed: 4, total: totalSteps });
  await pollUntilIdle({ exa, websetId: antithesisWebset.id, taskId, store, timeoutMs, stepNum: 4, totalSteps });
  tracker.track('poll-antithesis', step4);

  if (isCancelled(taskId, store)) return empty(true, { thesisWebset, antithesisWebset });

  // Collect items from both
  const step5 = Date.now();
  store.updateProgress(taskId, { step: 'collecting', completed: 5, total: totalSteps });
  const thesisItems = await collectItems(exa, thesisWebset.id, count * 2);
  const antithesisItems = await collectItems(exa, antithesisWebset.id, count * 2);
  tracker.track('collect', step5);

  return {
    thesisWebset,
    thesisItems,
    antithesisWebset,
    antithesisItems,
    cancelled: false,
    steps: tracker.steps,
  };
}

async function adversarialVerifyWorkflow(
  taskId: string,
  args: Record<string, unknown>,
  exa: Exa,
  store: TaskStore,
): Promise<unknown> {
  const startTime = Date.now();
  const tracker = createStepTracker();

  const entity = args.entity as { type: string } | undefined;
  const count = (args.count as number) ?? 25;
  const enrichments = args.enrichments as Array<Record<string, unknown>> | undefined;
  const synthesize = (args.synthesize as boolean) ?? false;
  const timeoutMs = (args.timeout as number) ?? 300_000;

  // Validate
  const step0 = Date.now();
  validateRequired(args, 'thesis', 'The hypothesis to test, e.g. "Remote work improves developer productivity"');
  validateRequired(args, 'thesisQuery', 'Search query for supporting evidence');
  validateRequired(args, 'antithesisQuery', 'Search query for counter-evidence');
  const thesis = args.thesis as string;
  const thesisQuery = args.thesisQuery as string;
  const antithesisQuery = args.antithesisQuery as string;
  tracker.track('validate', step0);

  // Gather evidence via the shared adversarial core (create + poll + collect).
  const core = await runAdversarial(taskId, store, exa, {
    thesisQuery,
    antithesisQuery,
    entity,
    count,
    enrichments,
    timeoutMs,
    totalSteps: synthesize ? 7 : 5,
  });
  for (const s of core.steps) tracker.steps.push(s);
  if (core.cancelled) return null;

  const { thesisWebset, thesisItems, antithesisWebset, antithesisItems } = core;

  store.setPartialResult(taskId, {
    thesis: { websetId: thesisWebset.id, itemCount: thesisItems.length },
    antithesis: { websetId: antithesisWebset.id, itemCount: antithesisItems.length },
  });

  // Synthesize if requested
  let synthesis: Record<string, unknown> | undefined;
  if (synthesize) {
    const step6 = Date.now();
    store.updateProgress(taskId, { step: 'synthesizing', completed: 6, total: 7 });

    const thesisSummaries = thesisItems.slice(0, 20).map(i => `- ${summarizeItem(i)}`).join('\n');
    const antithesisSummaries = antithesisItems.slice(0, 20).map(i => `- ${summarizeItem(i)}`).join('\n');

    const instructions = `Given supporting evidence for the thesis "${thesis}":
${thesisSummaries}

And counter-evidence:
${antithesisSummaries}

Provide a balanced assessment including: verdict, confidence level, key supporting factors, key countering factors, and identified blind spots.`;

    try {
      const researchResp = await (exa.research as any).create({
        instructions,
        model: 'exa-research-fast',
      });
      const researchId = researchResp.researchId ?? researchResp.id;
      const researchResult = await (exa.research as any).pollUntilFinished(researchId, {
        timeoutMs: 120_000,
      });
      synthesis = {
        researchId,
        content: researchResult.output ?? researchResult.result ?? JSON.stringify(researchResult),
      };
    } catch (err) {
      synthesis = {
        researchId: 'error',
        content: `Synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    tracker.track('synthesize', step6);
  }

  const totalSteps = synthesize ? 7 : 5;
  store.updateProgress(taskId, { step: 'complete', completed: totalSteps, total: totalSteps });

  const duration = Date.now() - startTime;
  const projectedThesis = filterAndProjectItems(thesisItems);
  const projectedAntithesis = filterAndProjectItems(antithesisItems);
  const result: Record<string, unknown> = {
    thesis: {
      websetId: thesisWebset.id,
      items: projectedThesis.data,
      itemCount: projectedThesis.included,
      itemsExcluded: projectedThesis.excluded,
    },
    antithesis: {
      websetId: antithesisWebset.id,
      items: projectedAntithesis.data,
      itemCount: projectedAntithesis.included,
      itemsExcluded: projectedAntithesis.excluded,
    },
    duration,
    steps: tracker.steps,
  };
  if (synthesis) result.synthesis = synthesis;

  const synthLabel = synthesis ? ', synthesis completed' : '';
  return withSummary(result, `Thesis: ${projectedThesis.included} items, Antithesis: ${projectedAntithesis.included} items${synthLabel} in ${(duration / 1000).toFixed(0)}s`);
}

const meta: WorkflowMeta = {
  title: 'Adversarial Verification',
  description: 'Test a hypothesis by gathering evidence for and against it in parallel. Creates two websets — one for supporting evidence (thesis), one for counter-evidence (antithesis). Optionally synthesizes a balanced assessment using the Exa Research API.',
  category: 'analysis',
  parameters: [
    { name: 'thesis', type: 'string', required: true, description: 'The hypothesis to test' },
    { name: 'thesisQuery', type: 'string', required: true, description: 'Search query for supporting evidence' },
    { name: 'antithesisQuery', type: 'string', required: true, description: 'Search query for counter-evidence' },
    { name: 'entity', type: 'object', required: false, description: 'Entity type filter' },
    { name: 'enrichments', type: 'array', required: false, description: 'Enrichments for both websets' },
    { name: 'count', type: 'number', required: false, description: 'Results per side', default: 25 },
    { name: 'synthesize', type: 'boolean', required: false, description: 'Run Research API synthesis for balanced assessment', default: false },
    { name: 'timeout', type: 'number', required: false, description: 'Timeout in milliseconds', default: 300000 },
  ],
  steps: [
    'Validate thesis, thesisQuery, and antithesisQuery',
    'Create thesis webset (supporting evidence)',
    'Create antithesis webset (counter-evidence)',
    'Poll thesis webset until idle',
    'Poll antithesis webset until idle',
    'Collect items from both websets',
    'Optionally synthesize balanced assessment via Research API',
  ],
  output: 'Thesis side (webset ID, items, counts), antithesis side (webset ID, items, counts), and optional synthesis with balanced verdict, confidence, and identified blind spots.',
  example: `await callOperation('tasks.create', {\n  type: 'adversarial.verify',\n  args: {\n    thesis: 'Remote-first companies have higher employee retention',\n    thesisQuery: 'remote work companies employee retention benefits',\n    antithesisQuery: 'remote work downsides turnover attrition problems',\n    entity: { type: 'article' },\n    synthesize: true,\n  }\n});`,
  relatedWorkflows: ['convergent.search', 'research.deep', 'retrieval.verifiedAnswer'],
  tags: ['adversarial', 'hypothesis', 'thesis', 'antithesis', 'verification', 'debate', 'synthesis'],
};
registerWorkflow('adversarial.verify', adversarialVerifyWorkflow, meta);
