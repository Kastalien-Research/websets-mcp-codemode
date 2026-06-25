import type { Exa } from 'exa-js';

export type TextContent = { type: 'text'; text: string };

export type ResourceLinkContent = {
  type: 'resource_link';
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
};

/**
 * Tool responses always lead with a `TextContent` block (callers rely on
 * `content[0].text` being the JSON/error payload). Additional blocks can be
 * `TextContent` or `ResourceLinkContent` — e.g. resource_link enrichment
 * appended by `successResultWithLinks` per the spec.
 */
export type ToolResult = {
  content: [TextContent, ...Array<TextContent | ResourceLinkContent>];
  isError?: boolean;
};

/**
 * Context plumbed from the MCP transport into operation handlers.
 * - `sendProgress`: emit `notifications/progress` on the in-flight tool call.
 *   Present only when the caller supplied a `progressToken` in the request's
 *   `_meta`. Undefined otherwise (handlers should no-op gracefully).
 * - `signal`: AbortSignal from the request; honor for cancellation.
 * - `silent`: caller asked to suppress MCP notifications (e.g. because they
 *   already receive push delivery via the websets-channel bridge). Handlers
 *   that would otherwise call `sendProgress` should skip when `silent` is true.
 */
export interface OperationContext {
  sendProgress?: (progress: number, message?: string) => Promise<void>;
  signal?: AbortSignal;
  silent?: boolean;
}

export type OperationHandler = (
  args: Record<string, unknown>,
  exa: Exa,
  ctx?: OperationContext,
) => Promise<ToolResult>;

export function successResult(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Build a success result with extra `resource_link` content blocks appended
 * after the JSON text. Empty link arrays produce only the text block — never
 * trailing placeholder entries.
 *
 * See specs/spec-update-052226/workflows-as-prompts-and-resources.md
 * ("Architectural change: embedded resource_link") for the motivation.
 */
export function successResultWithLinks(data: unknown, links: ResourceLinkContent[]): ToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(data, null, 2) },
      ...links,
    ],
  };
}

export function errorResult(operation: string, error: unknown, hints?: string): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  let text = `Error in ${operation}: ${message}`;

  // Append API-level prescriptive hints based on error patterns
  const apiHints: string[] = [];
  if (/401|403|Unauthorized|Forbidden/i.test(message)) {
    const keyHint = operation.startsWith('yelp.')
      ? 'Check that YELP_API_KEY is set and valid.'
      : 'Check that EXA_API_KEY is set and valid.';
    apiHints.push(keyHint);
  }
  if (/404|[Nn]ot [Ff]ound/.test(message)) {
    apiHints.push('Resource not found. It may have been deleted. Use the corresponding .list operation to find valid IDs.');
  }
  if (/429|rate limit/i.test(message)) {
    apiHints.push('Rate limited. Wait before retrying or reduce request frequency.');
  }
  if (apiHints.length > 0) {
    text += `\n\n${apiHints.join(' ')}`;
  }

  if (hints) text += `\n\n${hints}`;
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

export function requireParams(operation: string, args: Record<string, unknown>, ...names: string[]): ToolResult | null {
  const missing = names.filter(n => args[n] === undefined || args[n] === null);
  if (missing.length === 0) return null;
  return {
    content: [{ type: 'text', text: `Missing required parameter(s) for ${operation}: ${missing.join(', ')}` }],
    isError: true,
  };
}

export function validationError(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}
