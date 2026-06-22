import type { Exa } from 'exa-js';
import type { TaskStore } from '../lib/taskStore.js';
import { registerWorkflow, type WorkflowMeta } from './types.js';
import { createStepTracker, isCancelled, withSummary, WorkflowError } from './helpers.js';
import * as agentRuns from '../handlers/agentRuns.js';
import { annotateItem, upsertItem } from '../store/db.js';

/**
 * Stage-2 of the harvest → verify → research pipeline.
 *
 * Trigger: a `webset.item.ready` event from the channel bridge (PR #24).
 * Dispatch: this workflow via tasks.create({ type: 'agentRuns.verifyItem', args }).
 * Effect: runs an Agent Run with a structured outputSchema asking
 * "is this item real, accurate, and relevant?", then writes the verdict
 * into the SQLite annotations table so Stage-3 can query verified items
 * by annotation in one call.
 *
 * The default verification prompt cites the item's URL, title, and the
 * webset's criteria evaluations. Callers can override:
 *   - verificationPrompt: full prompt string (templated)
 *   - annotationType: change the annotations.type key (default "verification")
 */

type VerifyArgs = {
  item: {
    id: string;
    url?: string;
    name?: string;
    entityType?: string;
    evaluations?: Array<{ criterion: string; satisfied?: string; reasoning?: string }>;
  };
  /**
   * Parent webset id. When supplied, the workflow pre-upserts the item into
   * the local store before annotating — defensive against the annotations
   * table's FOREIGN KEY (item_id → items.id). In the typical production path
   * (dispatched from a webset.item.ready channel event), the item was
   * already upserted by webhookEventBus.publish, so the upsert is a no-op
   * UPDATE. Callers dispatching outside the channel pipeline (manual runs,
   * replays, tests) should pass websetId explicitly to avoid FK errors.
   * meta.webset_id from the channel notification is the right value here.
   */
  websetId?: string;
  originalQuery?: string;
  verificationPrompt?: string;
  annotationType?: string;
  effort?: 'low' | 'medium' | 'high' | 'auto';
};

function buildDefaultPrompt(args: VerifyArgs): string {
  const item = args.item;
  const evalSummary = (item.evaluations ?? [])
    .map(e => `- "${e.criterion}" → ${e.satisfied ?? 'unknown'}`)
    .join('\n');
  return [
    `Verify this candidate item against the original search intent.`,
    args.originalQuery ? `\nOriginal query: ${args.originalQuery}` : '',
    `\nItem:`,
    `  URL: ${item.url ?? '(none)'}`,
    `  Title: ${item.name ?? '(none)'}`,
    evalSummary ? `\nPrior criterion evaluations:\n${evalSummary}` : '',
    `\nAnswer two questions:`,
    `  1. verified: is the URL real, reachable, and accurately described by the title?`,
    `  2. relevant: does the page actually address the original query / criteria?`,
    `Cite the evidence you used.`,
  ].filter(Boolean).join('\n');
}

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['verified', 'relevant', 'reasoning'],
  properties: {
    verified: {
      type: 'boolean',
      description: 'Is the URL real, reachable, and accurately described by the title?',
    },
    relevant: {
      type: 'boolean',
      description: 'Does the page actually address the original query / criteria?',
    },
    reasoning: {
      type: 'string',
      description: 'Brief justification citing the evidence used.',
    },
  },
};

async function verifyItemWorkflow(
  taskId: string,
  args: Record<string, unknown>,
  exa: Exa,
  store: TaskStore,
): Promise<unknown> {
  const startTime = Date.now();
  const tracker = createStepTracker();
  const typed = args as unknown as VerifyArgs;

  // Validate
  const step0 = Date.now();
  if (!typed.item || typeof typed.item !== 'object' || !typed.item.id) {
    throw new WorkflowError(
      'agentRuns.verifyItem requires args.item with at least an id field. '
      + 'Typical usage: dispatch from a webset.item.ready event payload, '
      + 'passing the full item object as args.item.',
      'validate',
      false,
    );
  }
  const annotationType = typed.annotationType ?? 'verification';
  tracker.track('validate', step0);

  if (isCancelled(taskId, store)) return null;

  // Dispatch Agent Run
  const step1 = Date.now();
  store.updateProgress(taskId, { step: 'verifying', completed: 1, total: 3 });
  const prompt = typed.verificationPrompt ?? buildDefaultPrompt(typed);
  // stream:true makes agentRuns.create await the run's terminal SSE event
  // and return the final AgentRun envelope (with output.structured populated).
  // Without it the non-streaming path returns immediately with status:running
  // and no output, leaving the workflow with nothing to parse. ctx is
  // intentionally omitted so the SSE frames don't double-emit progress
  // through both this workflow's TaskStore step tracker AND the caller's
  // notifications/progress channel.
  const runResult = await agentRuns.create(
    {
      query: prompt,
      outputSchema: OUTPUT_SCHEMA,
      effort: typed.effort ?? 'low',
      stream: true,
    },
    exa,
  );
  if (runResult.isError) {
    throw new WorkflowError(
      `agentRuns.create failed: ${runResult.content[0].text}`,
      'verify',
      true, // recoverable — caller may retry
    );
  }
  const agentRun = JSON.parse(runResult.content[0].text) as {
    id: string;
    status: string;
    output?: { structured?: { verified?: boolean; relevant?: boolean; reasoning?: string } };
    costDollars?: { total?: number };
  };
  tracker.track('verify', step1);

  if (isCancelled(taskId, store)) return null;

  // Parse the structured verdict.
  const structured = agentRun.output?.structured;
  if (!structured) {
    throw new WorkflowError(
      `Agent Run ${agentRun.id} completed without structured output. ` +
      `Status: ${agentRun.status}. The outputSchema may have failed to validate.`,
      'parse',
      false,
    );
  }
  const verdict = {
    verified: structured.verified === true,
    relevant: structured.relevant === true,
    reasoning: structured.reasoning ?? null,
    runId: agentRun.id,
    cost: agentRun.costDollars?.total ?? null,
    verifiedAt: new Date().toISOString(),
  };

  // Persist verdict to the SQLite annotations table. Stage-3 queries this
  // by annotation type/value to find items worth deeper research.
  //
  // The annotations table has FOREIGN KEY (item_id → items.id). In the
  // production path (channel handler dispatch from webset.item.ready) the
  // item is already in the items table — webhookEventBus.publish upserted
  // it from the raw webhook payload before the bridge synthesized the
  // ready event. For replays / manual runs / tests, the caller can pass
  // args.websetId so we pre-upsert defensively.
  const step2 = Date.now();
  store.updateProgress(taskId, { step: 'annotating', completed: 2, total: 3 });
  if (typed.websetId) {
    upsertItem({
      id: typed.item.id,
      websetId: typed.websetId,
      name: typed.item.name,
      url: typed.item.url,
      entityType: typed.item.entityType,
      evaluations: typed.item.evaluations as unknown[] | undefined,
    });
  }
  const annotationId = annotateItem(
    typed.item.id,
    annotationType,
    JSON.stringify(verdict),
    'agentRuns.verifyItem',
  );
  tracker.track('annotate', step2);

  store.updateProgress(taskId, { step: 'complete', completed: 3, total: 3 });

  const duration = Date.now() - startTime;
  const result: Record<string, unknown> = {
    itemId: typed.item.id,
    verdict,
    annotationId,
    annotationType,
    duration,
    steps: tracker.steps,
  };

  return withSummary(
    result,
    `Verified item ${typed.item.id}: verified=${verdict.verified} relevant=${verdict.relevant} (agent_run=${verdict.runId}, $${verdict.cost ?? '?'}, ${(duration / 1000).toFixed(1)}s)`,
  );
}

const meta: WorkflowMeta = {
  title: 'Agent Runs — Verify Item',
  description:
    'Stage-2 verifier in the harvest→verify→research pipeline. Takes a webset item (typically from a webset.item.ready channel event), dispatches an Agent Run with a structured outputSchema asking whether the URL is real and relevant, and writes the structured verdict into the SQLite annotations table so Stage-3 can query verified items by annotation.',
  category: 'verification',
  parameters: [
    {
      name: 'item',
      type: 'object',
      required: true,
      description:
        'The webset item to verify. Required fields: { id }. Recommended: { id, url, name, evaluations }. Typically the full payload from a webset.item.ready channel event.',
    },
    {
      name: 'websetId',
      type: 'string',
      required: false,
      description: 'Parent webset id (typically channel meta.webset_id). When supplied, the workflow pre-upserts the item to satisfy the annotations.item_id FK. Required for replays/tests where the item isn\'t already in the local store.',
    },
    {
      name: 'originalQuery',
      type: 'string',
      required: false,
      description: 'The original search query / intent. Included in the verification prompt so the agent can judge relevance.',
    },
    {
      name: 'verificationPrompt',
      type: 'string',
      required: false,
      description: 'Full prompt override. When omitted, a default prompt is constructed from item URL/title/evaluations + originalQuery.',
    },
    {
      name: 'annotationType',
      type: 'string',
      required: false,
      description: 'Annotation type key written to the store. Default "verification". Use a custom key when multiple verification passes coexist.',
      default: 'verification',
    },
    {
      name: 'effort',
      type: 'string',
      required: false,
      description: 'Agent Run effort: low | medium | high | auto. Default low (Stage-2 is a cheap gate; deeper research happens in Stage-3).',
      default: 'low',
    },
  ],
  steps: [
    'Validate args.item.id exists',
    'Build verification prompt from item + originalQuery (unless overridden)',
    'Dispatch agentRuns.create with structured outputSchema { verified, relevant, reasoning }',
    'Parse the structured verdict from output.structured',
    'Persist verdict to SQLite annotations table (type=annotationType, source=agentRuns.verifyItem)',
  ],
  output:
    '{ itemId, verdict: { verified, relevant, reasoning, runId, cost, verifiedAt }, annotationId, annotationType, duration, steps }',
  example: `// Typical dispatch from a webset.item.ready channel handler:
await callOperation('tasks.create', {
  type: 'agentRuns.verifyItem',
  args: {
    item: channelEvent.payload.item,  // full item from the synthesized event
    originalQuery: 'Official documentation websites for popular JavaScript build tools',
  }
});

// Then Stage-3 reads verified items via store.query:
await callOperation('store.query', {
  sql: "SELECT item_id, value FROM annotations WHERE type = 'verification' AND json_extract(value, '$.verified') = 1 AND json_extract(value, '$.relevant') = 1"
});`,
  relatedWorkflows: ['research.verifiedCollection', 'verify.enrichments', 'research.deep'],
  tags: ['verification', 'agent-runs', 'stage-2', 'pipeline', 'annotation'],
};

registerWorkflow('agentRuns.verifyItem', verifyItemWorkflow, meta);
