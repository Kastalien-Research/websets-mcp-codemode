// thesis.investigate — deterministic, headless thesis investigation.
//
// Reuses the adversarial retrieval core and records source-domain retrieval
// statistics in a durable notebook. Query membership does not establish factual
// support, refutation, or calibrated confidence.

import type { Exa } from 'exa-js';
import type { TaskStore } from '../lib/taskStore.js';
import { registerWorkflow, type WorkflowMeta } from './types.js';
import { createStepTracker, validateRequired, withSummary } from './helpers.js';
import { runAdversarial } from './adversarial.js';
import type { RetrievalBalance } from '../notebook/run.js';
import { normalizeDomain } from '../store/db.js';
import { projectItem } from '../lib/projections.js';
import {
  createNotebook,
  readNotebook,
  appendCell,
  appendRun,
  notebookExists,
  type NotebookRun,
} from '../notebook/store.js';

interface SideAnalysis {
  domains: Set<string>;
  evidence: string[]; // human-readable "name — url" lines, distinct by domain
}

function analyzeSide(items: Record<string, unknown>[]): SideAnalysis {
  const domains = new Set<string>();
  const evidence: string[] = [];
  for (const item of items) {
    const projected = projectItem(item);
    const url = (projected.url as string) ?? '';
    if (!url) continue;
    const domain = normalizeDomain(url);
    if (domains.has(domain)) continue;
    domains.add(domain);
    evidence.push(`${(projected.name as string) ?? 'unknown'} — ${url}`);
  }
  return { domains, evidence };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export interface RetrievalStats {
  retrievalBalance: RetrievalBalance;
  retrievalScore: number;
  thesisQueryDomains: number;
  antithesisQueryDomains: number;
  thesisQueryShare: number;
}

/**
 * Source-domain retrieval balance; neither labels nor score assess claim truth.
 * Retains the original thresholds and score arithmetic:
 * clamp((distinctDomains / targetN) * abs(thesisQueryShare - 0.5) * 2, 0, 1).
 */
export function computeRetrievalStats(s: number, a: number, distinctDomains: number, opts: { minEvidence: number; targetN: number }): RetrievalStats {
  const { minEvidence, targetN } = opts;
  const total = s + a;
  const r = total > 0 ? s / total : 0;
  let retrievalBalance: RetrievalBalance;
  if (r >= 0.66 && s >= minEvidence) retrievalBalance = 'thesis-heavy';
  else if (r <= 0.34 && a >= minEvidence) retrievalBalance = 'antithesis-heavy';
  else if (s >= minEvidence && a >= minEvidence) retrievalBalance = 'mixed';
  else retrievalBalance = 'sparse';
  const coverage = targetN > 0 ? distinctDomains / targetN : 0;
  const retrievalScore = clamp(coverage * Math.abs(r - 0.5) * 2, 0, 1);
  return { retrievalBalance, retrievalScore, thesisQueryDomains: s, antithesisQueryDomains: a, thesisQueryShare: r };
}

async function thesisInvestigateWorkflow(
  taskId: string,
  args: Record<string, unknown>,
  exa: Exa,
  store: TaskStore,
): Promise<unknown> {
  const startTime = Date.now();
  const tracker = createStepTracker();

  validateRequired(args, 'thesis', 'The thesis statement to investigate');
  const thesis = args.thesis as string;
  const count = (args.count as number) ?? 25;
  const minEvidence = (args.minEvidence as number) ?? 3;
  const timeoutMs = (args.timeout as number) ?? 300_000;
  const entity = args.entity as { type: string } | undefined;
  const notebookSlug = args.notebookSlug as string | undefined;

  // Naive query defaults (documented limitation — no LLM framing).
  const thesisQuery = (args.thesisQuery as string) ?? thesis;
  const antithesisQuery = (args.antithesisQuery as string) ?? `${thesis} criticism problems downsides counterevidence`;

  // Step 1: ensure notebook
  const step0 = Date.now();
  store.updateProgress(taskId, { step: 'ensuring notebook', completed: 0, total: 6 });
  const nb = (notebookSlug && notebookExists(notebookSlug))
    ? readNotebook(notebookSlug)
    : createNotebook({ thesis, slug: notebookSlug });
  const slug = nb.slug;
  tracker.track('ensure-notebook', step0);

  // Steps 2–6: gather adversarial evidence
  const core = await runAdversarial(taskId, store, exa, {
    thesisQuery,
    antithesisQuery,
    entity,
    count,
    timeoutMs,
    totalSteps: 6,
  });
  for (const s of core.steps) tracker.steps.push(s);
  if (core.cancelled) return null;

  // Analyze distinct domains returned by each query side.
  const stepAnalyze = Date.now();
  const forSide = analyzeSide(core.thesisItems);
  const againstSide = analyzeSide(core.antithesisItems);
  const union = new Set<string>([...forSide.domains, ...againstSide.domains]);
  const stats = computeRetrievalStats(forSide.domains.size, againstSide.domains.size, union.size, { minEvidence, targetN: count });
  tracker.track('analyze', stepAnalyze);

  // Write query results and retrieval statistics back into the notebook.
  const stepWrite = Date.now();
  const timestamp = new Date().toISOString();
  appendCell(slug, {
    type: 'markdown',
    text:
      `### Evidence snapshot ${timestamp}\n\n` +
      `**Thesis-query results (${forSide.domains.size} domains):**\n` +
      (forSide.evidence.length ? forSide.evidence.map(e => `- ${e}`).join('\n') : '_none_') +
      `\n\n**Antithesis-query results (${againstSide.domains.size} domains):**\n` +
      (againstSide.evidence.length ? againstSide.evidence.map(e => `- ${e}`).join('\n') : '_none_'),
  });

  const run: NotebookRun = {
    timestamp,
    kind: 'retrieval',
    ...stats,
    thesisQueryResults: forSide.evidence,
    antithesisQueryResults: againstSide.evidence,
    websetIds: [core.thesisWebset?.id, core.antithesisWebset?.id].filter(Boolean) as string[],
  };
  appendRun(slug, run);
  tracker.track('write-notebook', stepWrite);

  store.updateProgress(taskId, { step: 'complete', completed: 6, total: 6 });

  const duration = Date.now() - startTime;
  return withSummary(
    {
      notebookSlug: slug,
      thesis,
      ...stats,
      websetIds: run.websetIds,
      duration,
      steps: tracker.steps,
    },
    `Thesis "${thesis}" → retrieval balance ${stats.retrievalBalance} (retrieval score ${stats.retrievalScore.toFixed(2)}, ${stats.thesisQueryDomains} thesis-query / ${stats.antithesisQueryDomains} antithesis-query domains). Retrieval statistics do not establish factual support or calibrated confidence. ${(duration / 1000).toFixed(0)}s`,
  );
}

const meta: WorkflowMeta = {
  title: 'Thesis Investigation',
  description: 'Gather results from thesis and antithesis queries, compute source-domain retrieval balance and score, and append a tagged retrieval run to a durable .src.md notebook. These statistics do not establish factual support, refutation, or calibrated confidence.',
  category: 'analysis',
  parameters: [
    { name: 'thesis', type: 'string', required: true, description: 'The thesis statement to investigate' },
    { name: 'thesisQuery', type: 'string', required: false, description: 'Query for supporting evidence (defaults to the thesis)' },
    { name: 'antithesisQuery', type: 'string', required: false, description: 'Query for counter-evidence (defaults to a naive negation of the thesis)' },
    { name: 'entity', type: 'object', required: false, description: 'Entity type filter, e.g. { type: "article" }' },
    { name: 'count', type: 'number', required: false, description: 'Results per side', default: 25 },
    { name: 'minEvidence', type: 'number', required: false, description: 'Minimum distinct domains per query side for the retrieval balance classification', default: 3 },
    { name: 'notebookSlug', type: 'string', required: false, description: 'Reuse an existing notebook (appends a new run) instead of creating one' },
    { name: 'timeout', type: 'number', required: false, description: 'Per-webset poll timeout in milliseconds', default: 300000 },
  ],
  steps: [
    'Ensure a thesis notebook exists (create or reuse by slug)',
    'Create supporting (thesis) and countering (antithesis) websets',
    'Poll both websets until idle and collect items',
    'Count distinct source domains returned by each query side',
    'Compute source-domain retrieval balance and retrieval score (not factual confidence)',
    'Append query result lists and a tagged retrieval Run section to the notebook',
  ],
  output: 'Notebook slug, retrievalBalance (thesis-heavy/antithesis-heavy/mixed/sparse), retrievalScore, thesisQueryDomains, antithesisQueryDomains, thesisQueryShare, and Webset IDs. The score is clamp((unique domains / requested count) × abs(thesisQueryShare − 0.5) × 2, 0, 1); it is a retrieval statistic, not factual confidence. Legacy notebook runs remain readable.',
  example: `await callOperation('tasks.create', {\n  type: 'thesis.investigate',\n  args: {\n    thesis: 'Remote-first companies retain employees better',\n    entity: { type: 'article' },\n  }\n});`,
  relatedWorkflows: ['adversarial.verify', 'convergent.search'],
  tags: ['thesis', 'investigate', 'retrieval', 'notebook', 'adversarial', 'evidence', 'deterministic'],
};

registerWorkflow('thesis.investigate', thesisInvestigateWorkflow, meta);
