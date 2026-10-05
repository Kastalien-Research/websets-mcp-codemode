// The soft grader. One independent Claude Agent SDK query per criterion, each
// in an isolated setup (IsolatedAgenticJudgeEnv analog):
//   - cwd is a fresh worktree of the advanced HEAD, so only committed files exist;
//   - settingSources: [] and a throwaway HOME, so no project/user settings,
//     CLAUDE.md, memory or plugins from the producing session leak in;
//   - review judges get read-only tools; model-as-user subjects get none.
// Judges report observations and pick an anchor; model-as-user answers are
// scored by this file, not by the model. Retries are driven here, never by the
// judge (see .claude/rules/no-self-graded-verification.md).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { STATES } from './contract.js';
import { SCORES, type Criterion, type ModelAsUserCriterion, type ReviewCriterion, type StateId } from './kernel.js';

export const JUDGE_MODEL = process.env.CONTRACT_JUDGE_MODEL ?? 'claude-opus-5-5';
const MAX_ATTEMPTS = 3;
const CONCURRENCY = 3;

export interface CriterionResult {
  id: string;
  kind: Criterion['kind'];
  weight: number;
  status: 'scored' | 'ungraded';
  score: number | null;
  attempts: number;
  costUsd: number;
  detail: unknown;
  error?: string;
}

interface QueryOutcome {
  structured: unknown;
  costUsd: number;
  error?: string;
}

async function runQuery(prompt: string, options: {
  cwd: string;
  systemPrompt: string;
  tools: string[];
  schema: Record<string, unknown>;
  maxTurns: number;
  maxBudgetUsd: number;
}): Promise<QueryOutcome> {
  const home = mkdtempSync(join(tmpdir(), 'contract-judge-home-'));
  const outcome: QueryOutcome = { structured: undefined, costUsd: 0, error: 'no result message' };
  try {
    for await (const message of query({
      prompt,
      options: {
        model: JUDGE_MODEL,
        cwd: options.cwd,
        systemPrompt: options.systemPrompt,
        settingSources: [],
        tools: options.tools,
        allowedTools: options.tools,
        permissionMode: 'dontAsk',
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        persistSession: false,
        outputFormat: { type: 'json_schema', schema: options.schema },
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
        },
      },
    })) {
      if (message.type !== 'result') continue;
      outcome.costUsd = message.total_cost_usd;
      if (message.subtype === 'success') {
        outcome.structured = message.structured_output;
        outcome.error = undefined;
      } else {
        outcome.error = `${message.subtype}: ${message.errors.join('; ')}`;
      }
    }
  } catch (err) {
    outcome.error = (err as Error).message;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return outcome;
}

// --- review criteria ---------------------------------------------------------

const ReviewOutput = z.object({
  observations: z.array(z.object({ file: z.string(), line: z.number().int().optional(), note: z.string() }).strict()),
  score: z.number().refine(n => (SCORES as readonly number[]).includes(n), 'score must be an anchor value'),
  rationale: z.string(),
}).strict();

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['observations', 'score', 'rationale'],
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'note'],
        properties: { file: { type: 'string' }, line: { type: 'integer' }, note: { type: 'string' } },
      },
    },
    score: { type: 'number', enum: [...SCORES] },
    rationale: { type: 'string' },
  },
};

const REVIEW_SYSTEM = [
  'You are an independent reviewer grading exactly one criterion of a software change.',
  'You did not write this code and owe its author nothing. You have read-only access to the repository at the commit under review.',
  'Ground every observation in the repository: cite file and line. Grade what is there, not what was intended.',
  'First list observations, then pick the anchor whose description fits best, then explain the fit in the rationale.',
].join('\n');

function reviewPrompt(c: ReviewCriterion, target: StateId, transitionId: string): string {
  const state = STATES.find(s => s.id === target)!;
  return [
    `Criterion ${c.id} for transition ${transitionId} (target state ${target}: ${state.name}).`,
    '',
    `Question: ${c.question}`,
    '',
    'Anchors:',
    ...Object.entries(c.anchors).map(([score, text]) => `- ${score}: ${text}`),
    '',
    `Statements the target state must satisfy (already verified by deterministic checks; do not re-verify them, use them as context):`,
    ...state.invariants.map(i => `- ${i.id}: ${i.statement}`),
    '',
    'Evidence (untracked files in the working directory):',
    '- .contract-evidence/diff.patch: the full diff of this transition',
    '- .contract-evidence/verdicts.json: deterministic verdicts and measurements recorded at advance',
    `- contracts/temporal-snapshot/invariants/: the deterministic checks`,
    '',
    'Read the diff first, then whatever source you need.',
  ].join('\n');
}

async function gradeReview(c: ReviewCriterion, target: StateId, transitionId: string, cwd: string): Promise<CriterionResult> {
  const result: CriterionResult = { id: c.id, kind: c.kind, weight: c.weight, status: 'ungraded', score: null, attempts: 0, costUsd: 0, detail: null };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    result.attempts = attempt;
    const outcome = await runQuery(reviewPrompt(c, target, transitionId), {
      cwd, systemPrompt: REVIEW_SYSTEM, tools: ['Read', 'Grep', 'Glob'], schema: REVIEW_SCHEMA, maxTurns: 60, maxBudgetUsd: 4,
    });
    result.costUsd += outcome.costUsd;
    const parsed = ReviewOutput.safeParse(outcome.structured);
    if (!outcome.error && parsed.success) {
      return { ...result, status: 'scored', score: parsed.data.score, detail: parsed.data, error: undefined };
    }
    result.error = outcome.error ?? `invalid judge output: ${parsed.success ? '' : parsed.error.message}`;
  }
  return result;
}

// --- model-as-user criteria ----------------------------------------------------

const SUBJECT_SYSTEM = [
  'You are using a research tool. You will be shown one response it produced and asked questions about it.',
  'Answer only from the response. Keep each answer as short as the question asks.',
].join('\n');

export function answerMatches(match: ModelAsUserCriterion['questions'][number]['match'], answer: string, expect: string): boolean {
  const a = answer.trim();
  switch (match) {
    case 'exact':
      return a === expect;
    case 'contains':
      return a.toLowerCase().includes(expect.toLowerCase());
    case 'iso-instant': {
      const t = Date.parse(a);
      return Number.isFinite(t) && t === Date.parse(expect);
    }
    case 'yes-no':
      return (a.toLowerCase().match(/\b(yes|no)\b/)?.[1] ?? '') === expect.toLowerCase();
  }
}

async function gradeModelAsUser(c: ModelAsUserCriterion, cwd: string): Promise<CriterionResult> {
  const result: CriterionResult = { id: c.id, kind: c.kind, weight: c.weight, status: 'ungraded', score: null, attempts: 0, costUsd: 0, detail: null };
  let artifact: string;
  try {
    artifact = readFileSync(join(cwd, c.artifact), 'utf8');
  } catch {
    return { ...result, error: `artifact ${c.artifact} is missing at HEAD` };
  }
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: c.questions.map(q => q.id),
    properties: Object.fromEntries(c.questions.map(q => [q.id, { type: 'string' }])),
  };
  const Output = z.object(Object.fromEntries(c.questions.map(q => [q.id, z.string()]))).strict();
  const prompt = [
    'Response:',
    '```json',
    artifact.trim(),
    '```',
    '',
    'Questions:',
    ...c.questions.map(q => `- ${q.id}: ${q.ask}`),
  ].join('\n');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    result.attempts = attempt;
    const outcome = await runQuery(prompt, { cwd, systemPrompt: SUBJECT_SYSTEM, tools: [], schema, maxTurns: 2, maxBudgetUsd: 1 });
    result.costUsd += outcome.costUsd;
    const parsed = Output.safeParse(outcome.structured);
    if (!outcome.error && parsed.success) {
      const answers = c.questions.map(q => {
        const answer = (parsed.data as Record<string, string>)[q.id];
        return { id: q.id, answer, expect: q.expect, correct: answerMatches(q.match, answer, q.expect) };
      });
      const score = answers.filter(a => a.correct).length / answers.length;
      return { ...result, status: 'scored', score, detail: { answers }, error: undefined };
    }
    result.error = outcome.error ?? `invalid subject output: ${parsed.success ? '' : parsed.error.message}`;
  }
  return result;
}

// --- entry point ----------------------------------------------------------------

export async function gradeTransition(criteria: Criterion[], target: StateId, transitionId: string, cwd: string) {
  const results: CriterionResult[] = new Array(criteria.length);
  let next = 0;
  const worker = async () => {
    while (next < criteria.length) {
      const i = next++;
      const c = criteria[i];
      results[i] = c.kind === 'review'
        ? await gradeReview(c, target, transitionId, cwd)
        : await gradeModelAsUser(c, cwd);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, criteria.length) }, worker));

  const scored = results.filter(r => r.status === 'scored');
  const weight = scored.reduce((s, r) => s + r.weight, 0);
  const aggregate = weight > 0 ? scored.reduce((s, r) => s + r.weight * (r.score ?? 0), 0) / weight : null;
  const costUsd = results.reduce((s, r) => s + r.costUsd, 0);
  return { results, aggregate, costUsd };
}
