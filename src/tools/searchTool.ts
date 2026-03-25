import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchCatalog } from './catalog.js';

const DOMAINS = [
  'websets', 'searches', 'items', 'enrichments', 'monitors',
  'webhooks', 'imports', 'events', 'tasks', 'research', 'exa', 'workflow',
] as const;

const inputSchema = z.object({
  query: z.string().describe('Search query: keyword, domain name, or description'),
  detail: z.enum(['brief', 'detailed', 'full']).optional().default('brief')
    .describe('Level of detail: brief (names+summaries), detailed (with params), full (complete schemas)'),
  domain: z.enum(DOMAINS).optional()
    .describe('Filter to a specific domain'),
  limit: z.number().optional().default(10)
    .describe('Maximum number of results to return'),
});

const DESCRIPTION = `Discover available API operations by keyword, domain, or pattern.

Use this tool before writing code for the 'execute' tool, to find operation names and parameter schemas.

Examples:
  query: "create" → all create operations across domains
  query: "webset lifecycle" → webset CRUD + lifecycle workflow
  domain: "monitors" → all monitor operations
  query: "search", detail: "detailed" → search ops with parameter info`;

export function registerSearchTool(server: McpServer): void {
  server.registerTool(
    'search',
    {
      description: DESCRIPTION,
      inputSchema: inputSchema as any,
    },
    async (input: any) => {
      const parsed = inputSchema.parse(input);
      const result = searchCatalog(parsed.query, {
        detail: parsed.detail,
        domain: parsed.domain,
        limit: parsed.limit,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
