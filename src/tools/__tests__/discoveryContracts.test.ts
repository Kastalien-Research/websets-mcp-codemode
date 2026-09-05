import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { inputJsonSchema } from '../../lib/jsonSchema.js';
import { OPERATIONS } from '../operations.js';
import { DOMAINS } from '../searchTool.js';
import { registerExecuteTool } from '../executeTool.js';
import { executeInSandbox } from '../sandbox.js';
import { searchCatalog } from '../catalog.js';

describe('discovery contracts', () => {
  it('derives every searchable domain from registered operations', () => {
    for (const name of Object.keys(OPERATIONS)) expect(DOMAINS).toContain(name.split('.')[0]);
    expect(DOMAINS).toContain('workflow');
    for (const domain of ['yelp', 'github', 'connect', 'teams', 'notebook']) expect(DOMAINS).toContain(domain);
  });

  it('preserves records, unions, nullable values, defaults and constraints', () => {
    const schema = inputJsonSchema(z.object({
      labels: z.record(z.string()),
      choice: z.union([z.string().min(2), z.number().int().min(1).max(5)]),
      nullable: z.string().nullable(),
      values: z.array(z.string()).min(1).max(3).default(['x']),
    }));
    expect(schema.properties.labels.additionalProperties).toEqual({ type: 'string' });
    expect(schema.properties.choice.anyOf).toContainEqual({ type: 'string', minLength: 2 });
    expect(schema.properties.choice.anyOf).toContainEqual({ type: 'integer', minimum: 1, maximum: 5 });
    expect(schema.properties.nullable.type).toEqual(['string', 'null']);
    expect(schema.properties.values).toMatchObject({ minItems: 1, maxItems: 3, default: ['x'] });
    expect(schema.required).not.toContain('values');
    expect(JSON.stringify(schema)).not.toContain('"type":"unknown"');
  });

  it('advertises runtime refinements without weakening runtime validation', () => {
    const entry = searchCatalog('yelp.search', { detail: 'full' }).results.find(r => r.name === 'yelp.search') as any;
    expect(entry.schema.$comment).toContain('runtime Zod validation');
  });

  it('executes the exact published example against a mocked provider', async () => {
    const registerTool = vi.fn();
    const create = vi.fn().mockResolvedValue({ id: 'ws_example', status: 'idle' });
    const waitUntilIdle = vi.fn().mockResolvedValue({ id: 'ws_example', status: 'idle' });
    const listAll = vi.fn().mockImplementation(async function* () {});
    const exa = { websets: { create, waitUntilIdle, items: { listAll } } } as any;
    registerExecuteTool({ registerTool } as any, exa);
    const description = registerTool.mock.calls[0][1].description as string;
    const code = description.split('Example:\n')[1].split('\n\nPARAMETER FORMAT RULES')[0];
    await executeInSandbox(code, exa);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ search: expect.objectContaining({ count: 10 }) }));
    expect(waitUntilIdle).toHaveBeenCalledWith('ws_example', expect.objectContaining({ timeout: 300000 }));
    expect(listAll).toHaveBeenCalledWith('ws_example', expect.anything());
  });
});
