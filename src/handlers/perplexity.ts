// Perplexity Sonar operations — a second, architecturally independent search
// engine for cross-checking Exa-derived claims. Handlers return the answer,
// citations, and a usage-based cost estimate so workflow ledgers can track
// spend mechanically (same discipline as exa.* costDollars).

import { z } from 'zod';
import type { OperationHandler } from './types.js';
import { successResult, errorResult } from './types.js';
import { perplexityAsk } from '../lib/perplexity.js';

const ModelEnum = z.enum(['sonar', 'sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research']);

export const Schemas = {
  ask: z.object({
    question: z.string(),
    model: ModelEnum.optional(),
    systemPrompt: z.string().optional(),
    maxTokens: z.number().int().min(16).max(8192).optional(),
    temperature: z.number().min(0).max(2).optional(),
  }),
  verifyPerson: z.object({
    name: z.string(),
    city: z.string().optional(),
    state: z.string().optional(),
    licenseNumber: z.string().optional(),
    claims: z.array(z.string()).optional(),
    model: ModelEnum.optional(),
  }),
};

export const ask: OperationHandler = async (args) => {
  try {
    const result = await perplexityAsk(args.question as string, {
      model: args.model as any,
      systemPrompt: args.systemPrompt as string | undefined,
      maxTokens: args.maxTokens as number | undefined,
      temperature: args.temperature as number | undefined,
    });
    return successResult(result);
  } catch (error) {
    return errorResult('perplexity.ask', error);
  }
};

// Predefined verification workflow: one call, structured prompt. Returns prose
// + citations; the CALLER grades it (no self-graded verdict fields here).
export const verifyPerson: OperationHandler = async (args) => {
  try {
    const name = args.name as string;
    const locality = [args.city, args.state].filter(Boolean).join(', ');
    const claims = (args.claims as string[] | undefined) ?? [];
    const question =
      `Who is ${name}${locality ? `, associated with ${locality}` : ''}` +
      `${args.licenseNumber ? ` (professional engineer license #${args.licenseNumber})` : ''}? ` +
      `Report their current employer, job title, engineering discipline, and any professional profile URLs. ` +
      `Cite sources for every fact.` +
      (claims.length
        ? ` Additionally, for each of the following claims, state what your sources support or contradict — ` +
          `if you find no evidence either way, say so explicitly rather than guessing:\n` +
          claims.map((c, i) => `${i + 1}. ${c}`).join('\n')
        : '');
    const result = await perplexityAsk(question, {
      model: (args.model as any) ?? 'sonar',
      systemPrompt:
        'You are verifying facts about a specific real person. Precision matters more than coverage: ' +
        'never blend facts from different same-named people — if multiple candidates exist, say so and ' +
        'distinguish them. Absence of evidence must be reported as absence, not filled in.',
      maxTokens: 1536,
    });
    return successResult(result);
  } catch (error) {
    return errorResult('perplexity.verifyPerson', error);
  }
};
