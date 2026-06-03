// thesis.investigate — deterministic, headless thesis investigation.
//
// Reuses the adversarial evidence-gathering core, scores a rule-based verdict
// from distinct supporting/countering source domains (no LLM judge), and writes
// the result back into a durable `.src.md` thesis notebook. Re-running appends a
// new Run section → a verdict timeline.

import type { Exa } from 'exa-js';
import type { TaskStore } from '../lib/taskStore.js';
import { registerWorkflow, type WorkflowMeta } from './types.js';
import { createStepTracker, validateRequired, withSummary } from './helpers.js';
import { runAdversarial } from './adversarial.js';
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

export interface Verdict {
  verdict: 'supported' | 'refuted' | 'mixed' | 'inconclusive';
  confidence: number;
  supportingDomains: number;
  counteringDomains: number;
  ratio: number;
}

/**
 * Deterministic verdict from distinct-domain counts. `s`/`a` are supporting /
 * countering distinct source domains; `r = s/(s+a)`. Priority order:
 * supported → refuted → mixed → inconclusive.
 */
export function computeVerdict(s: number, a: number, distinctDomains: number, opts: { minEvidence: number; targetN: number }): Verdict {
  const { minEvidence, targetN } = opts;
  const total = s + a;
  const r = total > 0 ? s / total : 0;

  let verdict: Verdict['verdict'];
  if (r >= 0.66 && s >= minEvidence) verdict = 'supported';
  else if (r <= 0.34 && a >= minEvidence) verdict = 'refuted';
  else if (s >= minEvidence && a >= minEvidence) verdict = 'mixed';
  else verdict = 'inconclusive';

  const coverage = targetN > 0 ? distinctDomains / targetN : 0;
  const confidence = clamp(coverage * Math.abs(r - 0.5) * 2, 0, 1);

  return { verdict, confidence, supportingDomains: s, counteringDomains: a, ratio: r };
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

  // Analyze: distinct supporting / countering domains
  const stepAnalyze = Date.now();
  const forSide = analyzeSide(core.thesisItems);
  const againstSide = analyzeSide(core.antithesisItems);
  const union = new Set<string>([...forSide.domains, ...againstSide.domains]);
  const verdict = computeVerdict(forSide.domains.size, againstSide.domains.size, union.size, { minEvidence, targetN: count });
  tracker.track('analyze', stepAnalyze);

  // Write evidence + verdict back into the notebook
  const stepWrite = Date.now();
  const timestamp = new Date().toISOString();
  appendCell(slug, {
    type: 'markdown',
    text:
      `### Evidence snapshot ${timestamp}\n\n` +
      `**Supporting (${forSide.domains.size} domains):**\n` +
      (forSide.evidence.length ? forSide.evidence.map(e => `- ${e}`).join('\n') : '_none_') +
      `\n\n**Countering (${againstSide.domains.size} domains):**\n` +
      (againstSide.evidence.length ? againstSide.evidence.map(e => `- ${e}`).join('\n') : '_none_'),
  });

  const run: NotebookRun = {
    timestamp,
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    evidenceFor: forSide.evidence,
    evidenceAgainst: againstSide.evidence,
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
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      supportingDomains: verdict.supportingDomains,
      counteringDomains: verdict.counteringDomains,
      ratio: verdict.ratio,
      websetIds: run.websetIds,
      duration,
      steps: tracker.steps,
    },
    `Thesis "${thesis}" → ${verdict.verdict} (confidence ${verdict.confidence.toFixed(2)}, ${verdict.supportingDomains} for / ${verdict.counteringDomains} against) in ${(duration / 1000).toFixed(0)}s`,
  );
}

const meta: WorkflowMeta = {
  title: 'Thesis Investigation',
  description: 'Investigate a thesis end-to-end: gather adversarial evidence (supporting + countering websets), score a deterministic verdict from distinct source domains, and persist it to a durable, re-runnable .src.md thesis notebook. Reruns append a new verdict to the notebook timeline.',
  category: 'analysis',
  parameters: [
    { name: 'thesis', type: 'string', required: true, description: 'The thesis statement to investigate' },
    { name: 'thesisQuery', type: 'string', required: false, description: 'Query for supporting evidence (defaults to the thesis)' },
    { name: 'antithesisQuery', type: 'string', required: false, description: 'Query for counter-evidence (defaults to a naive negation of the thesis)' },
    { name: 'entity', type: 'object', required: false, description: 'Entity type filter, e.g. { type: "article" }' },
    { name: 'count', type: 'number', required: false, description: 'Results per side', default: 25 },
    { name: 'minEvidence', type: 'number', required: false, description: 'Minimum distinct domains per side for a decisive verdict', default: 3 },
    { name: 'notebookSlug', type: 'string', required: false, description: 'Reuse an existing notebook (appends a new run) instead of creating one' },
    { name: 'timeout', type: 'number', required: false, description: 'Per-webset poll timeout in milliseconds', default: 300000 },
  ],
  steps: [
    'Ensure a thesis notebook exists (create or reuse by slug)',
    'Create supporting (thesis) and countering (antithesis) websets',
    'Poll both websets until idle and collect items',
    'Count distinct supporting/countering source domains',
    'Score a deterministic verdict (supported/refuted/mixed/inconclusive) with confidence',
    'Append an evidence snapshot + verdict Run section to the notebook',
  ],
  output: 'Notebook slug, verdict, confidence, distinct-domain counts, ratio, and the webset IDs. The notebook accumulates a verdict timeline across reruns.',
  example: `await callOperation('tasks.create', {\n  type: 'thesis.investigate',\n  args: {\n    thesis: 'Remote-first companies retain employees better',\n    entity: { type: 'article' },\n  }\n});`,
  relatedWorkflows: ['adversarial.verify', 'convergent.search'],
  tags: ['thesis', 'investigate', 'verdict', 'notebook', 'adversarial', 'evidence', 'deterministic'],
};

registerWorkflow('thesis.investigate', thesisInvestigateWorkflow, meta);
