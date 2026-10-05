import { z } from 'zod';

/**
 * Returns a copy of `schema` in which every object that would silently strip
 * unknown keys (zod's default) rejects them instead. Objects declared
 * `.passthrough()` or with a `.catchall()` keep their behavior.
 *
 * Without this, a misspelled or newer parameter is dropped at dispatch and the
 * call runs as if it had never been sent (e.g. `snapshotAsOf` returning live
 * content). Walks zod v3 internals (`_def`), as catalog.ts does.
 */
export function rejectUnknownKeys<T extends z.ZodTypeAny>(schema: T): T {
  return strictCopy(schema) as T;
}

function strictCopy(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = (schema as any)._def;
  const rebuild = (patch: Record<string, unknown>) => {
    const Schema = schema.constructor as new (def: unknown) => z.ZodTypeAny;
    return new Schema({ ...def, ...patch });
  };

  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(
      Object.entries(schema.shape as z.ZodRawShape).map(([key, value]) => [key, strictCopy(value)]),
    );
    const strips = def.unknownKeys === 'strip' && def.catchall instanceof z.ZodNever;
    return rebuild({
      shape: () => shape,
      unknownKeys: strips ? 'strict' : def.unknownKeys,
      catchall: strictCopy(def.catchall),
    });
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly
  ) {
    return rebuild({ innerType: strictCopy(def.innerType) });
  }
  if (schema instanceof z.ZodEffects) return rebuild({ schema: strictCopy(def.schema) });
  if (schema instanceof z.ZodArray) return rebuild({ type: strictCopy(def.type) });
  if (schema instanceof z.ZodRecord) return rebuild({ valueType: strictCopy(def.valueType) });
  if (schema instanceof z.ZodUnion) return rebuild({ options: def.options.map(strictCopy) });
  if (schema instanceof z.ZodIntersection) {
    return rebuild({ left: strictCopy(def.left), right: strictCopy(def.right) });
  }
  if (schema instanceof z.ZodTuple) {
    return rebuild({ items: def.items.map(strictCopy), rest: def.rest ? strictCopy(def.rest) : null });
  }
  if (schema instanceof z.ZodLazy) return rebuild({ getter: () => strictCopy(def.getter()) });
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return z.discriminatedUnion(def.discriminator, def.options.map(strictCopy));
  }
  return schema;
}

/** Keys accepted by the object schema at `path`, or null when it is not a single object. */
export function keysAt(schema: z.ZodTypeAny, path: Array<string | number>): string[] | null {
  let current: z.ZodTypeAny | undefined = schema;
  for (let i = 0; ; i++) {
    current = unwrap(current);
    if (i === path.length) break;
    const step = path[i];
    if (current instanceof z.ZodObject && typeof step === 'string') {
      current = (current.shape as z.ZodRawShape)[step];
    } else if (current instanceof z.ZodArray && typeof step === 'number') {
      current = current.element;
    } else if (current instanceof z.ZodRecord) {
      current = (current as any)._def.valueType;
    } else {
      return null;
    }
    if (!current) return null;
  }
  return current instanceof z.ZodObject ? Object.keys(current.shape as z.ZodRawShape) : null;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    const def = (current as any)._def;
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodCatch ||
      current instanceof z.ZodReadonly
    ) {
      current = def.innerType;
    } else if (current instanceof z.ZodEffects) {
      current = def.schema;
    } else {
      return current;
    }
  }
}

/** The valid key a model most plausibly meant, if any is close enough to suggest. */
export function nearestKey(unknown: string, valid: string[]): string | null {
  const lower = unknown.toLowerCase();
  let best: { key: string; distance: number } | null = null;
  for (const key of valid) {
    const distance = key.toLowerCase() === lower ? 0 : editDistance(lower, key.toLowerCase());
    if (!best || distance < best.distance) best = { key, distance };
  }
  if (!best) return null;
  return best.distance <= Math.max(2, Math.floor(unknown.length / 3)) ? best.key : null;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}
