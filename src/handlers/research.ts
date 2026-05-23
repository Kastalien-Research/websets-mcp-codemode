import { z } from 'zod';
import type { OperationHandler } from './types.js';
import { successResult, errorResult, requireParams } from './types.js';

export const Schemas = {
  create: z.object({
    instructions: z.string(),
    model: z.enum(['exa-research', 'exa-research-pro']).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  }),
  get: z.object({
    researchId: z.string(),
    events: z.boolean().optional(),
    stream: z.boolean().optional(),
  }),
  list: z.object({
    cursor: z.string().optional(),
    limit: z.number().optional(),
  }),
  pollUntilFinished: z.object({
    researchId: z.string(),
    pollInterval: z.number().optional(),
    timeoutMs: z.number().optional(),
    events: z.boolean().optional(),
  }),
};

import { projectResearch } from '../lib/projections.js';

export const create: OperationHandler = async (args, exa) => {
  const guard = requireParams('research.create', args, 'instructions');
  if (guard) return guard;
  try {
    const params: Record<string, unknown> = {
      instructions: args.instructions,
    };
    if (args.model) params.model = args.model;
    if (args.outputSchema) params.outputSchema = args.outputSchema;
    const response = await exa.research.create(params as any);
    return successResult(projectResearch(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('research.create', error);
  }
};

export const get: OperationHandler = async (args, exa) => {
  const guard = requireParams('research.get', args, 'researchId');
  if (guard) return guard;
  try {
    const opts: Record<string, unknown> = {};
    if (args.events !== undefined) opts.events = args.events;
    const hasOpts = Object.keys(opts).length > 0;
    const response = await exa.research.get(args.researchId as string, hasOpts ? opts as any : undefined);
    return successResult(projectResearch(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('research.get', error);
  }
};

export const list: OperationHandler = async (args, exa) => {
  try {
    const opts: Record<string, unknown> = {};
    if (args.cursor) opts.cursor = args.cursor;
    if (args.limit) opts.limit = args.limit;
    const hasOpts = Object.keys(opts).length > 0;
    const response = await exa.research.list(hasOpts ? opts as any : undefined);
    const raw = response as unknown as Record<string, unknown>;
    const data = raw.data as Record<string, unknown>[] | undefined;
    if (data) {
      return successResult({ ...raw, data: data.map(projectResearch) });
    }
    return successResult(response);
  } catch (error) {
    return errorResult('research.list', error);
  }
};

export const pollUntilFinished: OperationHandler = async (args, exa) => {
  const guard = requireParams('research.pollUntilFinished', args, 'researchId');
  if (guard) return guard;
  try {
    const opts: Record<string, unknown> = {};
    if (args.pollInterval) opts.pollInterval = args.pollInterval;
    if (args.timeoutMs) opts.timeoutMs = args.timeoutMs;
    if (args.events !== undefined) opts.events = args.events;
    const hasOpts = Object.keys(opts).length > 0;
    const response = await exa.research.pollUntilFinished(
      args.researchId as string,
      hasOpts ? opts as any : undefined,
    );
    return successResult(projectResearch(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('research.pollUntilFinished', error);
  }
};
