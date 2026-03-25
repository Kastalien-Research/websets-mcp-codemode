import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Exa } from 'exa-js';
import { executeInSandbox } from './sandbox.js';
import type { CompatMode } from './coercion.js';

const inputSchema = z.object({
  code: z.string().describe('JavaScript code to execute in the sandbox'),
  timeout: z.number().optional().default(30000)
    .describe('Execution timeout in milliseconds (max 120000)'),
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
- cron: MUST be 5-field format "minute hour day month weekday"`;

export interface ExecuteToolOptions {
  defaultCompatMode?: CompatMode;
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
      inputSchema: inputSchema as any,
    },
    async (input: any) => {
      const parsed = inputSchema.parse(input);

      try {
        const { result, logs } = await executeInSandbox(parsed.code, exa, {
          timeoutMs: Math.min(parsed.timeout, 120_000),
          compatMode,
        });

        const output: Record<string, unknown> = { result };
        if (logs.length > 0) output.logs = logs;

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
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
    },
  );
}
