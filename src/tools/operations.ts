import { z } from 'zod';
import type { Exa } from 'exa-js';
import type { OperationHandler, ToolResult } from '../handlers/types.js';

import * as websets from '../handlers/websets.js';
import * as searches from '../handlers/searches.js';
import * as items from '../handlers/items.js';
import * as enrichments from '../handlers/enrichments.js';
import * as monitors from '../handlers/monitors.js';
import * as webhooks from '../handlers/webhooks.js';
import * as imports from '../handlers/imports.js';
import * as events from '../handlers/events.js';
import * as tasks from '../handlers/tasks.js';
import * as research from '../handlers/research.js';
import * as exaSearch from '../handlers/exa.js';
import { applyCompatCoercions, type AppliedCoercion, type CompatMode } from './coercion.js';

// Single barrel import for all workflow side-effect registrations
import '../workflows/index.js';

const FIELD_HINTS: Record<string, string> = {
  entity: 'entity must be an object like {type: "company"}, not a bare string. Known types: company, person, article, research_paper, custom. For custom: {type: "custom", description: "..."}.',
  criteria: 'criteria must be [{description: "..."}], not an array of strings.',
  options: 'options must be [{label: "..."}] with 1-20 items, not an array of strings.',
};

// Operation metadata
export interface OperationMeta {
  handler: OperationHandler;
  summary: string;
}

export const OPERATIONS: Record<string, OperationMeta> = {
  'websets.create': { handler: websets.create, summary: 'Create a new webset' },
  'websets.get': { handler: websets.get, summary: 'Get a webset by ID' },
  'websets.list': { handler: websets.list, summary: 'List all websets' },
  'websets.update': { handler: websets.update, summary: 'Update webset metadata' },
  'websets.delete': { handler: websets.del, summary: 'Delete a webset' },
  'websets.cancel': { handler: websets.cancel, summary: 'Cancel a webset' },
  'websets.preview': { handler: websets.preview, summary: 'Preview a webset query' },
  'websets.waitUntilIdle': { handler: websets.waitUntilIdle, summary: 'Poll until webset status becomes idle' },
  'websets.getAll': { handler: websets.getAll, summary: 'Auto-paginate all websets' },
  'searches.create': { handler: searches.create, summary: 'Create a search on a webset' },
  'searches.get': { handler: searches.get, summary: 'Get search status' },
  'searches.cancel': { handler: searches.cancel, summary: 'Cancel a search' },
  'items.list': { handler: items.list, summary: 'List items in a webset' },
  'items.get': { handler: items.get, summary: 'Get a specific item' },
  'items.delete': { handler: items.del, summary: 'Delete an item' },
  'items.getAll': { handler: items.getAll, summary: 'Auto-paginate all items in a webset' },
  'enrichments.create': { handler: enrichments.create, summary: 'Create an enrichment' },
  'enrichments.get': { handler: enrichments.get, summary: 'Get enrichment status' },
  'enrichments.cancel': { handler: enrichments.cancel, summary: 'Cancel an enrichment' },
  'enrichments.update': { handler: enrichments.update, summary: 'Update an enrichment' },
  'enrichments.delete': { handler: enrichments.del, summary: 'Delete an enrichment' },
  'monitors.create': { handler: monitors.create, summary: 'Create a monitor' },
  'monitors.get': { handler: monitors.get, summary: 'Get a monitor' },
  'monitors.list': { handler: monitors.list, summary: 'List monitors' },
  'monitors.update': { handler: monitors.update, summary: 'Update a monitor' },
  'monitors.delete': { handler: monitors.del, summary: 'Delete a monitor' },
  'monitors.getAll': { handler: monitors.getAll, summary: 'Auto-paginate all monitors' },
  'monitors.runs.list': { handler: monitors.runsList, summary: 'List monitor runs' },
  'monitors.runs.get': { handler: monitors.runsGet, summary: 'Get a monitor run' },
  'webhooks.create': { handler: webhooks.create, summary: 'Create a webhook' },
  'webhooks.get': { handler: webhooks.get, summary: 'Get a webhook' },
  'webhooks.list': { handler: webhooks.list, summary: 'List webhooks' },
  'webhooks.update': { handler: webhooks.update, summary: 'Update a webhook' },
  'webhooks.delete': { handler: webhooks.del, summary: 'Delete a webhook' },
  'webhooks.list_attempts': { handler: webhooks.listAttempts, summary: 'List webhook delivery attempts' },
  'webhooks.getAll': { handler: webhooks.getAll, summary: 'Auto-paginate all webhooks' },
  'webhooks.getAllAttempts': { handler: webhooks.getAllAttempts, summary: 'Auto-paginate all webhook attempts' },
  'imports.create': { handler: imports.create, summary: 'Create an import' },
  'imports.get': { handler: imports.get, summary: 'Get an import' },
  'imports.list': { handler: imports.list, summary: 'List imports' },
  'imports.update': { handler: imports.update, summary: 'Update an import' },
  'imports.delete': { handler: imports.del, summary: 'Delete an import' },
  'imports.waitUntilCompleted': { handler: imports.waitUntilCompleted, summary: 'Poll until import completes or fails' },
  'imports.getAll': { handler: imports.getAll, summary: 'Auto-paginate all imports' },
  'events.list': { handler: events.list, summary: 'List events' },
  'events.get': { handler: events.get, summary: 'Get an event' },
  'events.getAll': { handler: events.getAll, summary: 'Auto-paginate all events' },
  'tasks.create': { handler: tasks.create, summary: 'Create a background task' },
  'tasks.get': { handler: tasks.get, summary: 'Get task status and progress' },
  'tasks.result': { handler: tasks.result, summary: 'Get task result when completed' },
  'tasks.list': { handler: tasks.list, summary: 'List tasks, optionally filtered by status' },
  'tasks.cancel': { handler: tasks.cancel, summary: 'Cancel a running task' },
  'research.create': { handler: research.create, summary: 'Create a research request' },
  'research.get': { handler: research.get, summary: 'Get research status' },
  'research.list': { handler: research.list, summary: 'List research requests' },
  'research.pollUntilFinished': { handler: research.pollUntilFinished, summary: 'Poll until research completes' },
  'exa.search': { handler: exaSearch.search, summary: 'Instant web search' },
  'exa.findSimilar': { handler: exaSearch.findSimilar, summary: 'Find pages similar to a URL' },
  'exa.getContents': { handler: exaSearch.getContents, summary: 'Extract content from URLs' },
  'exa.answer': { handler: exaSearch.answer, summary: 'Question answering with citations' },
};

export const OPERATION_NAMES = Object.keys(OPERATIONS) as [string, ...string[]];

export const OPERATION_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'websets.create': websets.Schemas.create,
  'websets.get': websets.Schemas.get,
  'websets.list': websets.Schemas.list,
  'websets.update': websets.Schemas.update,
  'websets.delete': websets.Schemas.del,
  'websets.cancel': websets.Schemas.cancel,
  'websets.preview': websets.Schemas.preview,
  'websets.waitUntilIdle': websets.Schemas.waitUntilIdle,
  'websets.getAll': websets.Schemas.getAll,
  'searches.create': searches.Schemas.create,
  'searches.get': searches.Schemas.get,
  'searches.cancel': searches.Schemas.cancel,
  'items.list': items.Schemas.list,
  'items.get': items.Schemas.get,
  'items.delete': items.Schemas.del,
  'items.getAll': items.Schemas.getAll,
  'enrichments.create': enrichments.Schemas.create,
  'enrichments.get': enrichments.Schemas.get,
  'enrichments.cancel': enrichments.Schemas.cancel,
  'enrichments.update': enrichments.Schemas.update,
  'enrichments.delete': enrichments.Schemas.del,
  'monitors.create': monitors.Schemas.create,
  'monitors.get': monitors.Schemas.get,
  'monitors.list': monitors.Schemas.list,
  'monitors.update': monitors.Schemas.update,
  'monitors.delete': monitors.Schemas.del,
  'monitors.getAll': monitors.Schemas.getAll,
  'monitors.runs.list': monitors.Schemas.runsList,
  'monitors.runs.get': monitors.Schemas.runsGet,
  'webhooks.create': webhooks.Schemas.create,
  'webhooks.get': webhooks.Schemas.get,
  'webhooks.list': webhooks.Schemas.list,
  'webhooks.update': webhooks.Schemas.update,
  'webhooks.delete': webhooks.Schemas.del,
  'webhooks.list_attempts': webhooks.Schemas.listAttempts,
  'webhooks.getAll': webhooks.Schemas.getAll,
  'webhooks.getAllAttempts': webhooks.Schemas.getAllAttempts,
  'imports.create': imports.Schemas.create,
  'imports.get': imports.Schemas.get,
  'imports.list': imports.Schemas.list,
  'imports.update': imports.Schemas.update,
  'imports.delete': imports.Schemas.del,
  'imports.waitUntilCompleted': imports.Schemas.waitUntilCompleted,
  'imports.getAll': imports.Schemas.getAll,
  'events.list': events.Schemas.list,
  'events.get': events.Schemas.get,
  'events.getAll': events.Schemas.getAll,
  'tasks.create': tasks.Schemas.create,
  'tasks.get': tasks.Schemas.get,
  'tasks.result': tasks.Schemas.result,
  'tasks.list': tasks.Schemas.list,
  'tasks.cancel': tasks.Schemas.cancel,
  'research.create': research.Schemas.create,
  'research.get': research.Schemas.get,
  'research.list': research.Schemas.list,
  'research.pollUntilFinished': research.Schemas.pollUntilFinished,
  'exa.search': exaSearch.Schemas.search,
  'exa.findSimilar': exaSearch.Schemas.findSimilar,
  'exa.getContents': exaSearch.Schemas.getContents,
  'exa.answer': exaSearch.Schemas.answer,
};

export function withCoercionMetadata(
  result: ToolResult,
  coercions: AppliedCoercion[],
  warnings: string[],
): ToolResult {
  if (coercions.length === 0 && warnings.length === 0) return result;

  if (result.isError) {
    const lines: string[] = [];
    if (coercions.length > 0) {
      lines.push('Coercions applied:');
      for (const c of coercions) {
        lines.push(`- ${c.path}: ${c.from} -> ${c.to}`);
      }
    }
    if (warnings.length > 0) {
      lines.push('Warnings:');
      for (const w of warnings) {
        lines.push(`- ${w}`);
      }
    }

    return {
      ...result,
      content: [{
        type: 'text',
        text: `${result.content[0]?.text ?? ''}\n\n${lines.join('\n')}`.trim(),
      }],
    };
  }

  const rawText = result.content[0]?.text;
  if (!rawText) return result;

  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return result;
    }

    const enriched = parsed as Record<string, unknown>;
    if (coercions.length > 0) enriched._coercions = coercions;
    if (warnings.length > 0) enriched._warnings = warnings;

    return {
      ...result,
      content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }],
    };
  } catch {
    return result;
  }
}

export function formatValidationError(operation: string, issues: z.ZodIssue[]): ToolResult {
  const details = issues
    .map(issue => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `- ${path}: ${issue.message}`;
    })
    .join('\n');

  // Collect relevant field hints based on issue paths
  const hintSet = new Set<string>();
  for (const issue of issues) {
    const rootField = String(issue.path[0] ?? '');
    const hint = FIELD_HINTS[rootField];
    if (hint) hintSet.add(hint);
  }
  const hintsBlock = hintSet.size > 0 ? `\n\nHints:\n${[...hintSet].map(h => `- ${h}`).join('\n')}` : '';

  return {
    content: [{
      type: 'text',
      text: `Error in ${operation}: Validation failed\n${details}${hintsBlock}`,
    }],
    isError: true,
  };
}

export async function dispatchOperation(
  operation: string,
  args: Record<string, unknown>,
  exa: Exa,
  compatMode: CompatMode = 'strict',
): Promise<ToolResult> {
  const meta = OPERATIONS[operation];
  if (!meta) {
    return {
      content: [{ type: 'text' as const, text: `Unknown operation: ${operation}` }],
      isError: true,
    };
  }

  const coercion = applyCompatCoercions(
    operation,
    (args || {}) as Record<string, unknown>,
    compatMode,
  );
  const schema = OPERATION_SCHEMAS[operation];
  const validation = schema.safeParse(coercion.args);
  if (!validation.success) {
    const validationResult = formatValidationError(operation, validation.error.issues);
    return withCoercionMetadata(
      validationResult,
      coercion.coercions,
      coercion.warnings,
    );
  }
  const validatedArgs = validation.data as Record<string, unknown>;

  // Handle dry-run preview if requested via compat.preview
  if (coercion.preview) {
    const previewResult: ToolResult = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          preview: true,
          operation,
          execution: 'skipped',
          effectiveCompatMode: coercion.effectiveMode || compatMode,
          normalizedArgs: validatedArgs,
        }, null, 2),
      }],
    };

    return withCoercionMetadata(
      previewResult,
      coercion.coercions,
      coercion.warnings,
    );
  }

  const result = await meta.handler(validatedArgs, exa);
  return withCoercionMetadata(result, coercion.coercions, coercion.warnings);
}
