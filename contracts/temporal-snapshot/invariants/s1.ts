// S1 (Strict surface): nothing a caller sends is dropped without an error.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordingClient } from '../harness/recording-client.js';
import { fail, pass, type Check, type CheckEnv } from '../kernel.js';

const PROBE_KEY = '__contract_probe_unknown_key__';
const SNAPSHOT_AS_OF = '2026-06-01T00:00:00Z';

async function operationsModule(env: CheckEnv) {
  return import(pathToFileURL(join(env.root, 'src/tools/operations.ts')).href);
}

const textOf = (result: { content?: Array<{ text?: string }> }) =>
  (result.content ?? []).map(c => c.text ?? '').join('\n');

/**
 * Visits every zod object schema reachable from `schema`, yielding its dotted
 * path and unknown-key mode. Written against zod v3 internals (`_def`).
 */
function* objectModes(schema: any, path: string, seen = new Set<unknown>()): Generator<{ path: string; mode: string }> {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return;
  seen.add(schema);
  const def = schema._def ?? {};
  switch (def.typeName) {
    case 'ZodObject': {
      const catchallIsNever = def.catchall?._def?.typeName === 'ZodNever';
      yield { path: path || '(root)', mode: catchallIsNever ? def.unknownKeys : 'catchall' };
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      for (const [key, value] of Object.entries(shape ?? {})) {
        yield* objectModes(value, path ? `${path}.${key}` : key, seen);
      }
      if (!catchallIsNever) yield* objectModes(def.catchall, `${path}.*`, seen);
      return;
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
      yield* objectModes(def.innerType, path, seen);
      return;
    case 'ZodEffects':
      yield* objectModes(def.schema, path, seen);
      return;
    case 'ZodBranded':
    case 'ZodPromise':
      yield* objectModes(def.type, path, seen);
      return;
    case 'ZodArray':
    case 'ZodSet':
      yield* objectModes(def.type ?? def.valueType, `${path}[]`, seen);
      return;
    case 'ZodRecord':
    case 'ZodMap':
      yield* objectModes(def.valueType, `${path}{}`, seen);
      return;
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = def.options instanceof Map ? [...def.options.values()] : def.options;
      for (const [i, option] of (options ?? []).entries()) yield* objectModes(option, `${path}|${i}`, seen);
      return;
    }
    case 'ZodIntersection':
      yield* objectModes(def.left, path, seen);
      yield* objectModes(def.right, path, seen);
      return;
    case 'ZodTuple':
      for (const [i, item] of (def.items ?? []).entries()) yield* objectModes(item, `${path}[${i}]`, seen);
      if (def.rest) yield* objectModes(def.rest, `${path}[...]`, seen);
      return;
    case 'ZodLazy':
      yield* objectModes(def.getter(), path, seen);
      return;
    case 'ZodPipeline':
      yield* objectModes(def.in, path, seen);
      yield* objectModes(def.out, path, seen);
      return;
    default:
      return;
  }
}

export const checks: Record<string, Check> = {
  async 'S1.1'(env) {
    const { OPERATIONS, dispatchOperation } = await operationsModule(env);
    const rec = recordingClient();
    const violations: string[] = [];
    for (const op of Object.keys(OPERATIONS)) {
      const result = await dispatchOperation(op, { [PROBE_KEY]: 1, compat: { preview: true } }, rec.client);
      if (!result.isError) violations.push(`${op}: accepted`);
      else if (!textOf(result).includes(PROBE_KEY)) violations.push(`${op}: rejected without naming the key`);
    }
    const m = { operations: Object.keys(OPERATIONS).length, violations: violations.length, calls: rec.calls.length };
    if (rec.calls.length > 0) violations.push(`client calls recorded: ${rec.calls.map(c => c.path).join(', ')}`);
    return violations.length === 0
      ? pass(`all ${m.operations} operations reject and name an unknown top-level key`, m)
      : fail(`${violations.length} violations: ${violations.slice(0, 25).join('; ')}${violations.length > 25 ? '; ...' : ''}`, m);
  },

  async 'S1.2'(env) {
    const { OPERATION_SCHEMAS } = await operationsModule(env);
    const stripped: string[] = [];
    let strict = 0;
    let passthrough = 0;
    for (const [op, schema] of Object.entries(OPERATION_SCHEMAS)) {
      for (const { path, mode } of objectModes(schema, '')) {
        if (mode === 'strip') stripped.push(`${op}:${path}`);
        else if (mode === 'strict') strict++;
        else passthrough++;
      }
    }
    const m = { strict, passthrough, strip: stripped.length };
    // Every operation schema is an object, so a walk that finds fewer objects
    // than operations is not seeing the schemas (e.g. zod internals changed).
    const operations = Object.keys(OPERATION_SCHEMAS).length;
    if (strict + passthrough + stripped.length < operations) {
      return fail(`walk found ${strict + passthrough + stripped.length} object schemas for ${operations} operations; the walker is not seeing them`, m);
    }
    return stripped.length === 0
      ? pass(`no strip-mode object schemas (${strict} strict, ${passthrough} passthrough/catchall)`, m)
      : fail(`${stripped.length} strip-mode object schemas: ${stripped.slice(0, 25).join(', ')}${stripped.length > 25 ? ', ...' : ''}`, m);
  },

  async 'S1.3'(env) {
    const { dispatchOperation } = await operationsModule(env);
    const cases: Array<{
      name: string;
      op: string;
      args: Record<string, unknown>;
      forwarded: (calls: ReturnType<typeof recordingClient>['calls']) => boolean;
    }> = [
      {
        name: 'exa.search contents',
        op: 'exa.search',
        args: { query: 'contract probe', contents: { snapshotAsOf: SNAPSHOT_AS_OF, highlights: true } },
        forwarded: calls => calls.some(c =>
          c.path === 'search' && (c.args[1] as any)?.contents?.snapshotAsOf === SNAPSHOT_AS_OF),
      },
      {
        name: 'exa.getContents urls',
        op: 'exa.getContents',
        args: { urls: ['https://example.com/'], snapshotAsOf: SNAPSHOT_AS_OF, text: true },
        forwarded: calls => calls.some(c =>
          (c.path === 'getContents' && (c.args[1] as any)?.snapshotAsOf === SNAPSHOT_AS_OF) ||
          (c.path === 'rawRequest' && (c.args[2] as any)?.snapshotAsOf === SNAPSHOT_AS_OF)),
      },
      {
        name: 'exa.getContents ids',
        op: 'exa.getContents',
        args: { ids: ['https://example.com/'], snapshotAsOf: SNAPSHOT_AS_OF, text: true },
        forwarded: calls => calls.some(c =>
          c.path === 'rawRequest' && (c.args[2] as any)?.snapshotAsOf === SNAPSHOT_AS_OF),
      },
    ];

    const outcomes: string[] = [];
    const violations: string[] = [];
    for (const k of cases) {
      const rec = recordingClient();
      const result = await dispatchOperation(k.op, k.args, rec.client);
      // A rejection must happen before any request and name the key itself
      // (quoted, as the error formatter does), not merely list it as valid.
      if (result.isError && rec.calls.length === 0 && textOf(result).includes("'snapshotAsOf'")) {
        outcomes.push(`${k.name}: rejected`);
      }
      else if (k.forwarded(rec.calls)) outcomes.push(`${k.name}: forwarded`);
      else violations.push(`${k.name}: silently dropped (calls: ${rec.calls.map(c => c.path).join(', ') || 'none'})`);
    }
    return violations.length === 0
      ? pass(outcomes.join('; '))
      : fail(violations.join('; '));
  },
};
