import { describe, it, expect, vi } from 'vitest';
import '../index.js';
import { workflowRegistry, workflowMetadata, registerDevWorkflow, registerWorkflow } from '../types.js';
import { WORKFLOW_SCHEMAS, workflowArgumentSchema } from '../schemas.js';
import { inputJsonSchema, schemaParameters } from '../../lib/jsonSchema.js';
import { searchCatalog, resetCatalog } from '../../tools/catalog.js';
import { create } from '../../handlers/tasks.js';
import { taskStore } from '../../lib/taskStore.js';

describe('authoritative workflow argument schemas', () => {
  it('has a schema for every registered workflow, including dev and Effect workflows', () => {
    for (const type of workflowRegistry.keys()) expect(workflowArgumentSchema(type)).toBeDefined();
    expect(WORKFLOW_SCHEMAS['webhook.inject']).toBeDefined();
    expect(WORKFLOW_SCHEMAS['semantic.cron.replay']).toBeDefined();
    expect(() => registerWorkflow('missing.schema', vi.fn())).toThrow('no argument schema');
  });

  it('publishes authoritative types, defaults, and constraints in metadata and discovery', () => {
    resetCatalog();
    const full = searchCatalog('convergent.search', { domain: 'workflow', detail: 'full' }).results.find(r => r.name === 'workflow.convergent.search') as any;
    expect(full.schema.properties.queries).toMatchObject({ type: 'array', minItems: 2, maxItems: 5 });
    expect(full.schema.required).toContain('entity');
    expect(full.schema.required).toContain('queries');
    expect(full.schema.properties.count.default).toBe(25);
    for (const [type, meta] of workflowMetadata) {
      const authoritative = schemaParameters(workflowArgumentSchema(type));
      expect(meta.parameters.map(({ name, type, required, default: value, constraints }) => ({ name, type, required, value, constraints })))
        .toEqual(authoritative.map(({ name, type, required, default: value, constraints }) => ({ name, type, required, value, constraints })));
    }
    expect(inputJsonSchema(workflowArgumentSchema('semantic.cron')).properties.timeout.default).toBe(3_600_000);
  });

  it.each([
    ['convergent.search', { queries: ['one'], entity: { type: 'company' } }],
    ['convergent.search', { queries: ['one', 'two'], entity: { type: 'custom' } }],
    ['qd.winnow', { entity: { type: 'company' }, criteria: [{ description: 'x' }], enrichments: [{ description: 'x' }] }],
    ['qd.winnow', { query: 'q', entity: { type: 'company' }, criteria: [{ description: 'x' }], enrichments: [{ description: 'x', format: 'options' }] }],
    ['connect.enrich', { websetId: 'w', providers: ['x'], outputSchema: {}, batchSize: 0 }],
    ['echo.effect', { message: '' }],
    ['semantic.cron', { config: {} }],
    ['agentRuns.verifyItem', { item: { id: 2 } }],
  ])('rejects malformed %s before task creation or dispatch', async (type, args) => {
    const insertion = vi.spyOn(taskStore, 'create');
    const original = workflowRegistry.get(type)!;
    const dispatch = vi.fn().mockResolvedValue(null);
    workflowRegistry.set(type, dispatch);
    try {
      const result = await create({ type, args }, {} as any);
      expect(result.isError).toBe(true);
      expect(insertion).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      workflowRegistry.set(type, original);
      insertion.mockRestore();
    }
  });

  it('applies defaults equally to nested and flattened calls', async () => {
    const original = workflowRegistry.get('echo.effect')!;
    const dispatch = vi.fn().mockResolvedValue(null);
    workflowRegistry.set('echo.effect', dispatch);
    try {
      await create({ type: 'echo.effect', args: { message: 'nested' } }, {} as any);
      await create({ type: 'echo.effect', message: 'flat' }, {} as any);
      expect(dispatch.mock.calls.map(call => call[1])).toEqual([
        { message: 'nested', delayMs: 100 }, { message: 'flat', delayMs: 100 },
      ]);
    } finally { workflowRegistry.set('echo.effect', original); }
  });

  it('validates dev workflows before insertion when explicitly enabled', async () => {
    const prior = process.env.WEBSETS_ENABLE_DEV_WORKFLOWS;
    process.env.WEBSETS_ENABLE_DEV_WORKFLOWS = '1';
    const old = workflowRegistry.get('webhook.inject');
    const oldMeta = workflowMetadata.get('webhook.inject');
    const dispatch = vi.fn().mockResolvedValue(null);
    const insertion = vi.spyOn(taskStore, 'create');
    try {
      registerDevWorkflow('webhook.inject', dispatch);
      expect((await create({ type: 'webhook.inject', args: { event: {} } }, {} as any)).isError).toBe(true);
      expect(insertion).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      if (old) workflowRegistry.set('webhook.inject', old); else workflowRegistry.delete('webhook.inject');
      if (oldMeta) workflowMetadata.set('webhook.inject', oldMeta); else workflowMetadata.delete('webhook.inject');
      if (prior === undefined) delete process.env.WEBSETS_ENABLE_DEV_WORKFLOWS; else process.env.WEBSETS_ENABLE_DEV_WORKFLOWS = prior;
      insertion.mockRestore();
    }
  });
});
