import type { Exa } from 'exa-js';
import { z } from 'zod';
import { OperationHandler, successResult, errorResult, requireParams, validationError } from './types.js';
import { projectEnrichment } from '../lib/projections.js';

export const Schemas = {
  create: z.object({
    websetId: z.string(),
    description: z.string(),
    format: z.enum(['text', 'date', 'number', 'options', 'email', 'phone', 'url']).optional(),
    options: z.array(z.object({ label: z.string() })).max(150).optional(),
    metadata: z.record(z.string()).optional(),
  }),
  get: z.object({
    websetId: z.string(),
    enrichmentId: z.string(),
  }),
  cancel: z.object({
    websetId: z.string(),
    enrichmentId: z.string(),
  }),
  update: z.object({
    websetId: z.string(),
    enrichmentId: z.string(),
    description: z.string().optional(),
    format: z.enum(['text', 'date', 'number', 'options', 'email', 'phone', 'url']).optional(),
    options: z.array(z.object({ label: z.string() })).max(150).optional(),
    metadata: z.record(z.string()).optional(),
  }),
  del: z.object({
    websetId: z.string(),
    enrichmentId: z.string(),
  }),
};


const ENRICHMENT_HINTS = `Common issues:
- options must be array of objects: [{label: "option"}]
- format must be one of: text, date, number, options, email, phone, url
- When format is "options", you must provide the options parameter`;

export const create: OperationHandler = async (args, exa) => {
  const guard = requireParams('enrichments.create', args, 'websetId', 'description');
  if (guard) return guard;
  try {
    const websetId = args.websetId as string;
    const format = args.format as string | undefined;
    const options = args.options as Array<{ label: string }> | undefined;

    // Application-level validation: options required when format='options'
    if (format === 'options' && (!options || options.length === 0)) {
      return validationError('When format is "options", you must provide the options parameter with at least one option.');
    }

    // Application-level validation: max 150 options
    if (options && options.length > 150) {
      return validationError(`Too many options: ${options.length}. Maximum is 150 options.`);
    }

    const params: Record<string, unknown> = { description: args.description };
    if (format) params.format = format;
    if (options) params.options = options;
    if (args.metadata) params.metadata = args.metadata;

    const response = await exa.websets.enrichments.create(websetId, params as any);
    return successResult(projectEnrichment(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('enrichments.create', error, ENRICHMENT_HINTS);
  }
};

export const get: OperationHandler = async (args, exa) => {
  const guard = requireParams('enrichments.get', args, 'websetId', 'enrichmentId');
  if (guard) return guard;
  try {
    const response = await exa.websets.enrichments.get(
      args.websetId as string,
      args.enrichmentId as string,
    );
    return successResult(projectEnrichment(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('enrichments.get', error);
  }
};

export const cancel: OperationHandler = async (args, exa) => {
  const guard = requireParams('enrichments.cancel', args, 'websetId', 'enrichmentId');
  if (guard) return guard;
  try {
    const response = await exa.websets.enrichments.cancel(
      args.websetId as string,
      args.enrichmentId as string,
    );
    return successResult(projectEnrichment(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('enrichments.cancel', error);
  }
};

export const update: OperationHandler = async (args, exa) => {
  const guard = requireParams('enrichments.update', args, 'websetId', 'enrichmentId');
  if (guard) return guard;
  try {
    const websetId = args.websetId as string;
    const enrichmentId = args.enrichmentId as string;
    const params: Record<string, unknown> = {};

    if (args.description) params.description = args.description;
    if (args.format) params.format = args.format;
    if (args.options) params.options = args.options;
    if (args.metadata !== undefined) params.metadata = args.metadata;

    // The SDK update() returns void; fetch the enrichment afterward so we return
    // confirmed state (consistent with create/get/cancel/delete) rather than a
    // locally synthesized success shape.
    await exa.websets.enrichments.update(websetId, enrichmentId, params as any);
    const response = await exa.websets.enrichments.get(websetId, enrichmentId);
    return successResult(projectEnrichment(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('enrichments.update', error);
  }
};

export const del: OperationHandler = async (args, exa) => {
  const guard = requireParams('enrichments.delete', args, 'websetId', 'enrichmentId');
  if (guard) return guard;
  try {
    const response = await exa.websets.enrichments.delete(
      args.websetId as string,
      args.enrichmentId as string,
    );
    return successResult(projectEnrichment(response as unknown as Record<string, unknown>));
  } catch (error) {
    return errorResult('enrichments.delete', error);
  }
};
