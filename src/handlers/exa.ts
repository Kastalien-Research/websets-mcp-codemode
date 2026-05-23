import { z } from 'zod';
import type { OperationHandler } from './types.js';
import { successResult, errorResult, requireParams } from './types.js';

export const Schemas = {
  search: z.object({
    query: z.string(),
    type: z.enum(['instant', 'fast', 'auto', 'deep-lite', 'deep', 'deep-reasoning']).optional(),
    numResults: z.number().optional(),
    category: z.enum(['company', 'research paper', 'news', 'personal site', 'financial report', 'people']).optional(),
    includeDomains: z.array(z.string()).optional(),
    excludeDomains: z.array(z.string()).optional(),
    startCrawlDate: z.string().optional(),
    endCrawlDate: z.string().optional(),
    startPublishedDate: z.string().optional(),
    endPublishedDate: z.string().optional(),
    contents: z.object({
      text: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
      highlights: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
      summary: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
    }).optional(),
    additionalQueries: z.array(z.string()).max(10).optional(),
    userLocation: z.string().optional(),
    moderation: z.boolean().optional(),
    stream: z.boolean().optional(),
    compliance: z.enum(['hipaa']).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  }),
  findSimilar: z.object({
    url: z.string().url(),
    numResults: z.number().optional(),
    excludeSourceDomain: z.boolean().optional(),
    includeDomains: z.array(z.string()).optional(),
    excludeDomains: z.array(z.string()).optional(),
    startCrawlDate: z.string().optional(),
    endCrawlDate: z.string().optional(),
    startPublishedDate: z.string().optional(),
    endPublishedDate: z.string().optional(),
    contents: z.object({
      text: z.boolean().optional(),
      highlights: z.boolean().optional(),
      summary: z.boolean().optional(),
    }).optional(),
    includeText: z.array(z.string()).optional(),
    excludeText: z.array(z.string()).optional(),
    category: z.enum(['company', 'research paper', 'news', 'pdf', 'github', 'tweet', 'personal site', 'people', 'financial report']).optional(),
    userLocation: z.string().optional(),
  }),
  getContents: z.object({
    // At least one of `urls` or `ids` is required (refined below).
    urls: z.union([z.string().url(), z.array(z.string().url())]).optional(),
    ids: z.array(z.string()).optional(),
    // Spec accepts boolean OR rich options object for each of text/highlights/summary.
    text: z.union([
      z.boolean(),
      z.object({
        maxCharacters: z.number().optional(),
        includeHtmlTags: z.boolean().optional(),
      }).passthrough(),
    ]).optional(),
    highlights: z.union([
      z.boolean(),
      z.object({
        query: z.string().optional(),
        numSentences: z.number().optional(),
        highlightsPerUrl: z.number().optional(),
      }).passthrough(),
    ]).optional(),
    summary: z.union([
      z.boolean(),
      z.object({
        query: z.string().optional(),
      }).passthrough(),
    ]).optional(),
    livecrawl: z.enum(['never', 'fallback', 'always', 'preferred']).optional(),
    livecrawlTimeout: z.number().optional(),
    maxAgeHours: z.number().optional(),
    subpages: z.number().optional(),
    subpageTarget: z.array(z.string()).optional(),
    extras: z.record(z.string(), z.unknown()).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  }).refine(data => data.urls !== undefined || data.ids !== undefined, {
    message: "Either 'urls' or 'ids' is required",
    path: ['urls'],
  }),
  answer: z.object({
    query: z.string(),
    text: z.boolean().optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    userLocation: z.string().optional(),
    stream: z.boolean().optional(),
  }),
};


const SEARCH_HINTS = `Common issues:
- type must be one of: instant, fast, auto, deep-lite, deep, deep-reasoning
- category must be: company, research paper, news, personal site, financial report, people
- contents is an object like {text: true, summary: true}, NOT a boolean
- Date filters use ISO 8601: "2024-01-01T00:00:00.000Z"
- additionalQueries only works when type is "deep" (max 10)`;

export const search: OperationHandler = async (args, exa) => {
  const guard = requireParams('exa.search', args, 'query');
  if (guard) return guard;
  try {
    const opts: Record<string, unknown> = {};
    if (args.type) opts.type = args.type;
    if (args.numResults) opts.numResults = args.numResults;
    if (args.category) opts.category = args.category;
    if (args.includeDomains) opts.includeDomains = args.includeDomains;
    if (args.excludeDomains) opts.excludeDomains = args.excludeDomains;
    if (args.startCrawlDate) opts.startCrawlDate = args.startCrawlDate;
    if (args.endCrawlDate) opts.endCrawlDate = args.endCrawlDate;
    if (args.startPublishedDate) opts.startPublishedDate = args.startPublishedDate;
    if (args.endPublishedDate) opts.endPublishedDate = args.endPublishedDate;
    if (args.contents) opts.contents = args.contents;
    if (args.additionalQueries) opts.additionalQueries = args.additionalQueries;
    if (args.userLocation) opts.userLocation = args.userLocation;
    if (args.moderation !== undefined) opts.moderation = args.moderation;
    if (args.compliance) opts.compliance = args.compliance;
    if (args.outputSchema) opts.outputSchema = args.outputSchema;
    // NOTE: args.stream is consumed by Phase 6 streaming wire-up; ignored here.
    const hasOpts = Object.keys(opts).length > 0;
    const response = await exa.search(args.query as string, hasOpts ? opts as any : undefined);
    return successResult(response);
  } catch (error) {
    return errorResult('exa.search', error, SEARCH_HINTS);
  }
};

export const findSimilar: OperationHandler = async (args, exa) => {
  const guard = requireParams('exa.findSimilar', args, 'url');
  if (guard) return guard;
  try {
    const opts: Record<string, unknown> = {};
    if (args.numResults) opts.numResults = args.numResults;
    if (args.excludeSourceDomain !== undefined) opts.excludeSourceDomain = args.excludeSourceDomain;
    if (args.includeDomains) opts.includeDomains = args.includeDomains;
    if (args.excludeDomains) opts.excludeDomains = args.excludeDomains;
    if (args.startCrawlDate) opts.startCrawlDate = args.startCrawlDate;
    if (args.endCrawlDate) opts.endCrawlDate = args.endCrawlDate;
    if (args.startPublishedDate) opts.startPublishedDate = args.startPublishedDate;
    if (args.endPublishedDate) opts.endPublishedDate = args.endPublishedDate;
    if (args.contents) opts.contents = args.contents;
    if (args.includeText) opts.includeText = args.includeText;
    if (args.excludeText) opts.excludeText = args.excludeText;
    if (args.category) opts.category = args.category;
    if (args.userLocation) opts.userLocation = args.userLocation;
    const hasOpts = Object.keys(opts).length > 0;
    const response = await exa.findSimilar(args.url as string, hasOpts ? opts as any : undefined);
    return successResult(response);
  } catch (error) {
    return errorResult('exa.findSimilar', error, 'Ensure url is a valid URL. Use excludeSourceDomain: true to filter out results from the same domain.');
  }
};

export const getContents: OperationHandler = async (args, exa) => {
  try {
    const opts: Record<string, unknown> = {};
    if (args.text !== undefined) opts.text = args.text;
    if (args.highlights !== undefined) opts.highlights = args.highlights;
    if (args.summary !== undefined) opts.summary = args.summary;
    if (args.livecrawl) opts.livecrawl = args.livecrawl;
    if (args.livecrawlTimeout) opts.livecrawlTimeout = args.livecrawlTimeout;
    if (args.maxAgeHours) opts.maxAgeHours = args.maxAgeHours;
    if (args.subpages) opts.subpages = args.subpages;
    if (args.subpageTarget) opts.subpageTarget = args.subpageTarget;
    if (args.extras) opts.extras = args.extras;
    if (args.context !== undefined) opts.context = args.context;

    // ID path: SDK's getContents only sends `urls`, never `ids`. Drop to
    // rawRequest with the spec's ContentsRequest shape when ids are supplied.
    if (args.ids !== undefined) {
      const payload: Record<string, unknown> = { ids: args.ids, ...opts };
      if (args.urls !== undefined) payload.urls = args.urls;
      const response = await (exa as any).rawRequest('/contents', 'POST', payload);
      const json = await response.json();
      return successResult(json);
    }

    // URL-only path: existing SDK call.
    const urls = args.urls as string | string[];
    const hasOpts = Object.keys(opts).length > 0;
    const response = await exa.getContents(urls, hasOpts ? opts as any : undefined);
    return successResult(response);
  } catch (error) {
    return errorResult('exa.getContents', error);
  }
};

export const answer: OperationHandler = async (args, exa) => {
  const guard = requireParams('exa.answer', args, 'query');
  if (guard) return guard;
  try {
    const opts: Record<string, unknown> = {};
    if (args.text !== undefined) opts.text = args.text;
    if (args.outputSchema) opts.outputSchema = args.outputSchema;
    if (args.userLocation) opts.userLocation = args.userLocation;
    // NOTE: args.stream is consumed by Phase 6 streaming wire-up; ignored here.
    const hasOpts = Object.keys(opts).length > 0;
    const response = await exa.answer(args.query as string, hasOpts ? opts as any : undefined);
    return successResult(response);
  } catch (error) {
    return errorResult('exa.answer', error);
  }
};
