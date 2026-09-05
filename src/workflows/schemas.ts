import { validateSemanticConfig } from './semanticValidation.js';
import { z } from 'zod';
import { expandTemplates } from './templates.js';
import { EntitySchema } from '../lib/entitySchema.js';

const text = z.string().min(1);
const positiveInt = z.number().int().positive();
const timeout = positiveInt.default(300_000);
const record = z.record(z.unknown());
const criteria = z.array(z.object({ description: text })).min(1).max(10);
const enrichment = z.object({
  description: text,
  format: z.enum(['text', 'number', 'date', 'email', 'phone', 'url', 'options']).optional(),
  options: z.array(z.object({ label: text })).max(150).optional(),
  metadata: z.record(z.string()).optional(),
}).superRefine((value, ctx) => {
  if (value.format === 'options' && !value.options?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'options format requires non-empty options' });
  }
}).describe('Runtime refinement: format options requires at least one option.');
const enrichments = z.array(enrichment).min(1);
const collection = { query: text, entity: EntitySchema, criteria: criteria.optional(), count: positiveInt.default(25), timeout };
const researchModel = z.enum(['exa-research', 'exa-research-pro']);
const dates = { startPublishedDate: text.optional(), endPublishedDate: text.optional() };
const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'auto']);
const witness = z.object({ lensId: text, itemId: text, createdAt: text, timestampSource: z.literal('provider item-creation time') });
const joinedEntity = z.object({
  entity: z.string(), url: z.string(), presentInLenses: z.array(text), lensCount: z.number().int().nonnegative(),
  shapes: z.record(z.record(z.unknown())), witnesses: z.array(witness).optional(),
});
const temporalWindow = z.object({
  start: text, end: text, witnesses: z.array(witness), entities: z.array(joinedEntity), lensesWithEvidence: z.array(text),
});
const snapshot = z.object({
  evaluatedAt: text,
  lenses: z.record(z.object({
    websetId: text, totalItems: z.number().int().nonnegative(), shapedCount: z.number().int().nonnegative(),
    shapes: z.array(z.object({ name: z.string(), url: z.string(), enrichments: record })),
  })),
  join: z.object({ type: text, entities: z.array(joinedEntity), lensesWithEvidence: z.array(text), windows: z.array(temporalWindow).optional() }),
  signal: z.object({ fired: z.boolean(), satisfiedBy: z.array(text), rule: z.string(), matchedCombination: z.array(text).optional(), entities: z.array(text) }),
});
const semanticConfig = z.object({
  name: text.optional(), proxy: text.optional(),
  lenses: z.array(z.object({ id: text, source: z.object({
    query: text.optional(), websetId: text.optional(), entity: EntitySchema.optional(),
    criteria: criteria.optional(), enrichments: enrichments.optional(), count: positiveInt.optional(),
  }) })).min(1),
  shapes: z.array(z.object({ lensId: text, conditions: z.array(z.object({
    enrichment: text, operator: z.enum(['gte', 'gt', 'lte', 'lt', 'eq', 'contains', 'matches', 'oneOf', 'exists', 'withinDays']),
    value: z.union([z.number(), z.string(), z.array(z.string())]).optional(),
  })), logic: z.enum(['all', 'any']) })).min(1),
  join: z.object({
    by: z.enum(['entity', 'temporal', 'entity+temporal', 'cooccurrence']),
    entityMatch: z.object({ method: text.optional(), nameThreshold: z.number().min(0).max(1).optional() }).optional(),
    temporal: z.object({ window: text.optional(), days: z.number().finite().nonnegative().optional() }).optional(),
    minLensOverlap: positiveInt.optional(), keyEnrichment: text.optional(),
  }),
  signal: z.object({ proxy: text.optional(), requires: z.object({
    type: z.enum(['all', 'any', 'threshold', 'combination']), min: positiveInt.optional(), sufficient: z.array(z.array(text)).optional(),
  }) }),
  monitor: z.object({ cron: text, timezone: text.optional() }).optional(),
  webhookUrl: z.string().url().optional(), webhookEvents: z.array(text).optional(),
});

/** Normalize config before validating enum values, URLs, references, or dispatching.
 * Removing variables ensures the workflow receives resolved config and never expands it twice.
 * Direct workflow invocations still use the same template helper in their execution path.
 */
function expandSemanticArguments(input: unknown, ctx: z.RefinementCtx): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const args = input as Record<string, unknown>;
  if (args.variables === undefined || !args.config || typeof args.config !== 'object') return input;
  const variables = z.record(z.string()).safeParse(args.variables);
  if (!variables.success) {
    for (const issue of variables.error.issues) ctx.addIssue({ ...issue, path: ['variables', ...issue.path] });
    return z.NEVER;
  }
  try {
    const { variables: _variables, ...rest } = args;
    return { ...rest, config: expandTemplates(args.config, variables.data) };
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['config'], message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
}

/** Authoritative input contracts. Defaults and representable constraints feed discovery and dispatch. */
export const WORKFLOW_SCHEMAS: Record<string, z.ZodTypeAny> = {
  echo: z.object({ message: z.unknown().optional(), delayMs: z.number().int().nonnegative().default(100) }),
  'echo.effect': z.object({ message: text, delayMs: z.number().int().nonnegative().default(100) }),
  'lifecycle.harvest': z.object({ ...collection, enrichments: enrichments.optional(), cleanup: z.boolean().default(false) }),
  'convergent.search': z.object({ ...collection, query: z.never().optional(), queries: z.array(text).min(2).max(5) }).omit({ query: true }),
  'adversarial.verify': z.object({ thesis: text, thesisQuery: text, antithesisQuery: text, entity: EntitySchema.optional(), count: positiveInt.default(25), enrichments: enrichments.optional(), synthesize: z.boolean().default(false), timeout }),
  'qd.winnow': z.object({ ...collection, entity: EntitySchema.optional(), query: text.optional(), criteria, enrichments, count: positiveInt.default(50), seedWebsetId: text.optional(), selectionStrategy: z.enum(['all-criteria', 'any-criteria', 'diverse']).default('diverse'), critique: z.boolean().default(false) })
    .refine(a => !!(a.query || a.seedWebsetId), { message: 'query is required unless seedWebsetId is provided', path: ['query'] })
    .refine(a => !!(a.seedWebsetId || a.entity), { message: 'entity is required unless seedWebsetId is provided', path: ['entity'] })
    .refine(a => !a.critique || !!a.entity, { message: 'entity is required when critique is true', path: ['entity'] })
    .describe('Runtime refinements: query and entity are required unless seedWebsetId is provided; entity is always required when critique is true.'),
  'research.deep': z.object({ instructions: text, model: researchModel.default('exa-research'), outputSchema: record.optional(), timeout }),
  'research.verifiedCollection': z.object({ ...collection, researchPrompt: text, enrichments: enrichments.optional(), researchSchema: record.optional(), researchModel: researchModel.default('exa-research'), researchLimit: positiveInt.default(10) }),
  'retrieval.searchAndRead': z.object({ query: text, numResults: positiveInt.default(5), type: z.enum(['instant', 'fast', 'auto', 'deep-lite', 'deep', 'deep-reasoning']).optional(), category: text.optional(), includeDomains: z.array(text).optional(), excludeDomains: z.array(text).optional(), startCrawlDate: text.optional(), endCrawlDate: text.optional(), ...dates }),
  'retrieval.expandAndCollect': z.object({ query: text, numResults: positiveInt.default(5), expandTop: positiveInt.default(3), category: text.optional(), ...dates }),
  'retrieval.verifiedAnswer': z.object({ query: text, numValidation: positiveInt.default(3), model: text.optional(), systemPrompt: text.optional() }),
  'verify.enrichments': z.object({ websetId: text, maxItems: positiveInt.default(50), concurrency: positiveInt.default(10), keywords: z.array(text).default(['mcp']) }),
  'agentRuns.verifyItem': z.object({
    item: z.object({ id: text, url: z.string().optional(), name: z.string().optional(), entityType: z.string().optional(), evaluations: z.array(z.object({ criterion: z.string(), satisfied: z.string().optional(), reasoning: z.string().optional() })).optional() }).passthrough(),
    websetId: text.optional(), originalQuery: text.optional(), verificationPrompt: text.optional(), annotationType: text.default('verification'), effort: effort.default('low'),
  }),
  'thesis.investigate': z.object({ thesis: text, thesisQuery: text.optional(), antithesisQuery: text.optional(), entity: EntitySchema.optional(), count: positiveInt.default(25), minEvidence: positiveInt.default(3), notebookSlug: text.optional(), timeout }),
  'connect.enrich': z.object({ websetId: text, providers: z.array(text).min(1), outputSchema: z.object({ type: z.literal('object') }).passthrough(), query: text.optional(), maxItems: positiveInt.default(50), batchSize: positiveInt.default(25), effort: effort.default('low'), dryRun: z.boolean().default(false), pollIntervalMs: positiveInt.default(2000), maxWaitMs: positiveInt.default(180000) }).describe('Provider IDs are checked against the active Connect catalog at runtime before provider work.'),
  'semantic.cron': z.preprocess(expandSemanticArguments, z.object({ config: semanticConfig, variables: z.record(z.string()).optional(), existingWebsets: z.record(text).optional(), timeout: positiveInt.default(3_600_000), previousSnapshot: snapshot.optional() })
    .superRefine((args, ctx) => {
      try { validateSemanticConfig(args.config, args.existingWebsets); }
      catch (error) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['config'], message: error instanceof Error ? error.message : String(error) });
      }
    })).describe('Before task creation, variables expand config templates once, then the resolved config is validated. Runtime refinements: shape and combination lens IDs must exist; signal lens counts, thresholds, combination sizes, and entity join overlap must be meaningful; a supplied existingWebsets map must cover every lens, otherwise each lens needs a query or source webset. Provider-dependent checks also run at execution.'),
  'semantic.cron.replay': z.object({ configName: text.optional(), snapshot: snapshot.optional() })
    .refine(a => !!(a.configName || a.snapshot), { message: 'configName or snapshot is required' }).describe('Runtime refinement: configName or snapshot is required.'),
  'webhook.inject': z.object({ event: z.object({ type: text }).passthrough() }),
};

export function workflowArgumentSchema(type: string): z.ZodTypeAny {
  const schema = WORKFLOW_SCHEMAS[type];
  if (!schema) throw new Error(`Workflow ${type} has no argument schema`);
  return schema;
}
