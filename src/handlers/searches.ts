import type { Exa } from 'exa-js';
import { z } from 'zod';
import { OperationHandler, successResult, errorResult, requireParams } from './types.js';
import { projectSearch } from '../lib/projections.js';

export const Schemas = {
  create: z.object({
    websetId: z.string(),
    query: z.string(),
    // Per spec CreateWebsetSearchParameters: count is required.
    count: z.number(),
    entity: z.object({ type: z.string() }).optional(),
    criteria: z.array(z.object({ description: z.string() })).optional(),
    behavior: z.enum(['override', 'append']).optional(),
    recall: z.boolean().optional(),
    metadata: z.record(z.string()).optional(),
    // Spec additions: graph/import scoping, dedup exclusions, per-company cap.
    // Sub-object shapes vary; defer inner validation to the SDK.
    scope: z.array(z.unknown()).optional(),
    exclude: z.array(z.unknown()).optional(),
    maxPeoplePerCompany: z.number().optional(),
  }),
  get: z.object({
    websetId: z.string(),
    searchId: z.string(),
  }),
  cancel: z.object({
    websetId: z.string(),
    searchId: z.string(),
  }),
};


const SEARCH_HINTS = `Common issues:
- criteria must be array of objects: [{description: "criterion"}]
- entity must be object: {type: "company"}
- count must be a positive number
- behavior must be "override" or "append"`;

export const create: OperationHandler = async (args, exa) => {
  const guard = requireParams('searches.create', args, 'websetId', 'query', 'count');
  if (guard) return guard;
  try {
    const websetId = args.websetId as string;
    const params: Record<string, unknown> = {
      query: args.query,
      count: args.count,
    };

    if (args.entity) params.entity = args.entity;
    if (args.criteria) params.criteria = args.criteria;
    if (args.behavior) params.behavior = args.behavior;
    if (args.recall !== undefined) params.recall = args.recall;
    if (args.metadata) params.metadata = args.metadata;
    if (args.scope) params.scope = args.scope;
    if (args.exclude) params.exclude = args.exclude;
    if (args.maxPeoplePerCompany !== undefined) params.maxPeoplePerCompany = args.maxPeoplePerCompany;

    const response = await exa.websets.searches.create(websetId, params as any);
    return successResult(projectSearch(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('searches.create', error, SEARCH_HINTS);
  }
};

export const get: OperationHandler = async (args, exa) => {
  const guard = requireParams('searches.get', args, 'websetId', 'searchId');
  if (guard) return guard;
  try {
    const response = await exa.websets.searches.get(
      args.websetId as string,
      args.searchId as string,
    );
    return successResult(projectSearch(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('searches.get', error);
  }
};

export const cancel: OperationHandler = async (args, exa) => {
  const guard = requireParams('searches.cancel', args, 'websetId', 'searchId');
  if (guard) return guard;
  try {
    const response = await exa.websets.searches.cancel(
      args.websetId as string,
      args.searchId as string,
    );
    return successResult(projectSearch(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('searches.cancel', error);
  }
};
