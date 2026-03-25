import vm from 'node:vm';
import type { Exa } from 'exa-js';
import type { CompatMode } from './coercion.js';
import { dispatchOperation } from './operations.js';

export interface SandboxOptions {
  timeoutMs?: number;
  compatMode?: CompatMode;
}

export interface SandboxResult {
  result: unknown;
  logs: string[];
}

const MAX_SETTIMEOUT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export async function executeInSandbox(
  code: string,
  exa: Exa,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const compatMode = options.compatMode ?? 'strict';
  const logs: string[] = [];

  const capturedConsole = {
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    warn: (...args: unknown[]) => logs.push(`WARN: ${args.map(String).join(' ')}`),
    error: (...args: unknown[]) => logs.push(`ERROR: ${args.map(String).join(' ')}`),
  };

  const callOperation = async (operation: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await dispatchOperation(operation, args, exa, compatMode);
    if (result.isError) {
      throw new Error(result.content[0]?.text ?? `Operation ${operation} failed`);
    }
    const text = result.content[0]?.text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const context = vm.createContext({
    callOperation,
    console: capturedConsole,
    setTimeout: (fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) =>
      setTimeout(fn, Math.min(ms ?? 0, MAX_SETTIMEOUT_MS), ...args),
    clearTimeout,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Date,
    Math,
    RegExp,
    Promise,
    Map,
    Set,
    Error,
    TypeError,
    RangeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
  });

  // Wrap in async IIFE so top-level await works and return captures the value
  const wrappedCode = `(async () => {\n${code}\n})()`;

  const script = new vm.Script(wrappedCode, {
    filename: 'sandbox.js',
  });

  // Run with async timeout enforcement via Promise.race
  const resultPromise = script.runInContext(context, { timeout: timeoutMs }) as Promise<unknown>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const id = setTimeout(() => reject(new Error(`Execution timed out after ${timeoutMs}ms`)), timeoutMs);
    // Allow the process to exit even if the timeout hasn't fired
    if (typeof id === 'object' && 'unref' in id) (id as any).unref();
  });

  const result = await Promise.race([resultPromise, timeoutPromise]);

  return { result, logs };
}
