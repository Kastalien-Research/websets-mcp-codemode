import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** Input schemas preserve representable constraints. Custom refinements still run in Zod. */
export function inputJsonSchema(schema: z.ZodTypeAny): Record<string, any> {
  return {
    ...zodToJsonSchema(schema, { $refStrategy: 'none', effectStrategy: 'input' }),
    $comment: 'Custom refinements, when present, are enforced by runtime Zod validation and are not fully expressible in JSON Schema.',
  };
}

export function schemaParameters(schema: z.ZodTypeAny) {
  const json = inputJsonSchema(schema);
  return Object.entries(json.properties ?? {}).map(([name, value]) => {
    const field = value as Record<string, any>;
    const { description, default: defaultValue, type, ...constraints } = field;
    return {
      name,
      type: Array.isArray(type) ? type.join(' | ') : type ?? (field.anyOf || field.oneOf ? 'union' : 'any'),
      required: (json.required ?? []).includes(name),
      description: description ?? '',
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(Object.keys(constraints).length ? { constraints: JSON.stringify(constraints) } : {}),
      schema: field,
    };
  });
}
