import type { Exa } from 'exa-js';

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export type OperationHandler = (
  args: Record<string, unknown>,
  exa: Exa
) => Promise<ToolResult>;

export function successResult(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

export function errorResult(operation: string, error: unknown, hints?: string): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  let text = `Error in ${operation}: ${message}`;

  // Append API-level prescriptive hints based on error patterns
  const apiHints: string[] = [];
  if (/401|403|Unauthorized|Forbidden/i.test(message)) {
    apiHints.push('Check that EXA_API_KEY is set and valid.');
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
