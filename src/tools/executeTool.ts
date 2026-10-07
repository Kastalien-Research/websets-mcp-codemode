import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Exa } from 'exa-js';
import { executeInSandbox } from './sandbox.js';
import type { CompatMode } from './coercion.js';
import type { OperationContext, ToolResult } from '../handlers/types.js';
import { parseAsOf, snapshotInstant } from '../temporal/instant.js';

export const executeInputSchema = z.object({
  code: z.string().describe('JavaScript code to execute in the sandbox'),
  timeout: z.number().optional().default(30000)
    .describe('Execution timeout in milliseconds (max 120000)'),
  silent: z.boolean().optional().default(false)
    .describe('Suppress MCP notifications/progress emission from streaming operations. Default false. Set true if the calling client receives push delivery through another channel (e.g. the websets-channel bridge in Claude Code) and you don\'t want redundant progress notifications.'),
  asOf: snapshotInstant.optional()
    .describe('Pin this run to a past instant: an ISO 8601 date (2026-06-01, midnight UTC) or date-time with a timezone, within the last 5 months. exa.search and exa.getContents then return the newest version Exa stored at or before it; every other operation is refused. Page content is bounded; search ranking is not.'),
});

const DESCRIPTION = `Execute JavaScript code with access to all Exa Websets operations.

Available in sandbox:
- callOperation(name, args) — call any API operation (use 'search' tool to discover operations)
- console.log/warn/error — captured and returned with results

Code runs as an async function body. Use 'return' to output results.

Example:
  const ws = await callOperation('websets.create', {
    searchQuery: 'AI startups in healthcare',
    entity: { type: 'company' },
    count: 10
  });
  await callOperation('websets.waitUntilIdle', { websetId: ws.id });
  const items = await callOperation('items.getAll', { websetId: ws.id });
  return items;

PARAMETER FORMAT RULES (when using callOperation):
- criteria: MUST be [{description: "..."}] (array of objects, NOT strings)
- entity: MUST be {type: "company"} (object, NOT string)
- options: MUST be [{label: "..."}] (array of objects, NOT strings)
- cron: MUST be 5-field format "minute hour day month weekday"

PINNED RUNS (asOf):
- Pass asOf to bound the whole run to a past instant. exa.search and exa.getContents
  return the newest stored version of each page at or before it, and each response
  carries a temporal block saying how the bound was checked. Every other operation
  is refused with TEMPORAL_BOUNDARY.
- Content is bounded, discovery is not: which pages search finds, and their order,
  still come from Exa's current index.`;

export interface ExecuteToolOptions {
  defaultCompatMode?: CompatMode;
}

export interface RunExecuteOptions {
  compatMode?: CompatMode;
  /** Progress and cancellation plumbing from the MCP request, if any. */
  ctx?: OperationContext;
}

/**
 * Runs one `execute` call. A pinned run (`asOf`) threads the normalized
 * instant through every callOperation and stamps it at the top of the result.
 */
export async function runExecute(
  input: unknown,
  exa: Exa,
  options: RunExecuteOptions = {},
): Promise<ToolResult> {
  const parsed = executeInputSchema.parse(input);
  let asOf: string | undefined;
  if (parsed.asOf !== undefined) {
    const pinned = parseAsOf(parsed.asOf);
    if (!pinned.ok) {
      return { content: [{ type: 'text' as const, text: `Execution error: asOf ${pinned.reason}` }], isError: true };
    }
    asOf = pinned.asOf;
  }
  const ctx: OperationContext = { ...options.ctx, silent: parsed.silent, ...(asOf !== undefined ? { asOf } : {}) };

  try {
    const { result, logs, resourceLinks } = await executeInSandbox(parsed.code, exa, {
      timeoutMs: Math.min(parsed.timeout, 120_000),
      compatMode: options.compatMode ?? 'strict',
      ctx,
    });

    const output: Record<string, unknown> = asOf !== undefined ? { asOf, result } : { result };
    if (logs.length > 0) output.logs = logs;

    // Forward any resource_link blocks the inner handlers attached
    // (e.g. tasks.create returning a workflow:// link). Without this
    // append the MCP client never sees them: the sandbox unwraps only
    // content[0].text into the JS return value, and the execute tool
    // would otherwise return only that text. Surfacing them here gives
    // the model inline access to workflow docs / spec resources
    // exactly when it dispatches the corresponding operation.
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(output, null, 2) },
        ...resourceLinks,
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Append pattern-matched hints for common agent mistakes
    const hints: string[] = [];
    if (/Expected object, received string/i.test(message) || /entity/i.test(message)) {
      hints.push('Hint: entity must be an object like {type: "company"}, not a bare string.');
    }
    if (/criteria/i.test(message) && /string/i.test(message)) {
      hints.push('Hint: criteria must be [{description: "..."}], not an array of strings.');
    }
    if (/options/i.test(message) && /string/i.test(message)) {
      hints.push('Hint: options must be [{label: "..."}], not an array of strings.');
    }
    if (/401|403|Unauthorized|Forbidden/i.test(message)) {
      hints.push('Hint: Check that EXA_API_KEY is set and valid.');
    }
    if (/404|[Nn]ot [Ff]ound/.test(message)) {
      hints.push('Hint: Resource not found. It may have been deleted. Use the corresponding .list operation to find valid IDs.');
    }
    if (/429|rate limit/i.test(message)) {
      hints.push('Hint: Rate limited. Wait before retrying or reduce request frequency.');
    }

    const hintSuffix = hints.length > 0 ? `\n\n${hints.join('\n')}` : '';
    return {
      content: [{ type: 'text' as const, text: `Execution error: ${message}${hintSuffix}` }],
      isError: true,
    };
  }
}

export function registerExecuteTool(
  server: McpServer,
  exa: Exa,
  options: ExecuteToolOptions = {},
): void {
  const compatMode = options.defaultCompatMode ?? 'strict';

  server.registerTool(
    'execute',
    {
      description: DESCRIPTION,
      inputSchema: executeInputSchema as any,
    },
    async (input: any, extra: any) => {
      // Build the operation context that's threaded through callOperation
      // into each handler. The MCP SDK exposes:
      //   extra._meta?.progressToken   — caller's progress correlator
      //   extra.sendNotification(n)    — sends notification on this request's
      //                                  SSE stream (auto-tagged with the
      //                                  related requestId by the transport)
      //   extra.signal                 — AbortSignal for cancellation
      // Any of these may be absent (e.g. in tests). Build sendProgress only
      // when both a progressToken and sendNotification exist.
      const progressToken = extra?._meta?.progressToken;
      const canSendProgress =
        progressToken !== undefined && typeof extra?.sendNotification === 'function';

      const sendProgress = canSendProgress
        ? async (progress: number, message?: string): Promise<void> => {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress,
                ...(message !== undefined ? { message } : {}),
              },
            });
          }
        : undefined;

      return runExecute(input, exa, { compatMode, ctx: { sendProgress, signal: extra?.signal } });
    },
  );
}
