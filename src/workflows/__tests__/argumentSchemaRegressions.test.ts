import { describe, expect, it, vi } from 'vitest';
import '../index.js';
import { create } from '../../handlers/tasks.js';
import { taskStore } from '../../lib/taskStore.js';
import { workflowRegistry } from '../types.js';
import { workflowArgumentSchema } from '../schemas.js';
import * as templates from '../templates.js';

const config = {
  lenses: [{ id: 'hiring', source: { query: 'hiring' } }, { id: 'funding', source: { query: 'funding' } }],
  shapes: [{ lensId: 'hiring', conditions: [], logic: 'all' }, { lensId: 'funding', conditions: [], logic: 'all' }],
  join: { by: 'entity', minLensOverlap: 2 }, signal: { requires: { type: 'all' } },
};

async function completedTask(input: Record<string, unknown>, exa: any) {
  const result = await create(input, exa);
  expect(result.isError).toBeUndefined();
  const { taskId } = JSON.parse(result.content[0].text);
  await vi.waitFor(() => expect(taskStore.get(taskId)?.status).toBe('completed'));
  return taskStore.get(taskId)!;
}

describe('workflow schema review regressions', () => {
  it.each(['nested', 'flat'])('preserves enrichment metadata through %s args into the actual workflow provider call', async (style) => {
    const enrichments = [{ description: 'Owner email', format: 'email', metadata: { source: 'campaign-a' } }];
    const args = { query: 'companies', entity: { type: 'company' }, enrichments };
    const providerCreate = vi.fn().mockResolvedValue({ id: 'ws_metadata' });
    const exa = { websets: {
      create: providerCreate, get: vi.fn().mockResolvedValue({ id: 'ws_metadata', status: 'idle' }),
      items: { listAll: vi.fn().mockImplementation(async function* () {}) },
    } };
    await completedTask(style === 'nested' ? { type: 'lifecycle.harvest', args } : { type: 'lifecycle.harvest', ...args }, exa);
    expect(providerCreate).toHaveBeenCalledWith(expect.objectContaining({ enrichments }));
  });

  it('expands templates before URL, enum, lens-reference and existing-webset validation, once across actual dispatch', async () => {
    const expand = vi.spyOn(templates, 'expandTemplates');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exa = { websets: {
      get: vi.fn().mockImplementation(async (id) => ({ id, status: 'idle', enrichments: [] })),
      items: { listAll: vi.fn().mockImplementation(async function* () {}) },
    } };
    try {
      await completedTask({ type: 'semantic.cron', args: {
        config: { ...config,
          lenses: [{ id: '{{lens}}', source: { entity: { type: '{{entity}}' } } }, { id: 'funding', source: {} }],
          join: { by: '{{join}}', minLensOverlap: 2 }, webhookUrl: '{{url}}',
        },
        variables: { lens: 'hiring', entity: 'company', join: 'entity', url: 'https://example.com/hooks' },
        existingWebsets: { hiring: 'ws_hiring', funding: 'ws_funding' },
      } }, exa);
      expect(exa.websets.get).toHaveBeenCalledWith('ws_hiring');
      expect(exa.websets.get).toHaveBeenCalledWith('ws_funding');
      expect(expand).toHaveBeenCalledTimes(1);
    } finally { expand.mockRestore(); warn.mockRestore(); }
  });

  it.each([
    { variables: { lens: 'missing' }, patch: {} },
    { variables: { lens: 'hiring', join: 'invalid' }, patch: { join: { by: '{{join}}' } } },
    { variables: {}, patch: {} },
  ])('rejects invalid expanded config before task insertion', async ({ variables, patch }) => {
    const insertion = vi.spyOn(taskStore, 'create');
    const old = workflowRegistry.get('semantic.cron')!;
    const dispatch = vi.fn(); workflowRegistry.set('semantic.cron', dispatch);
    try {
      const result = await create({ type: 'semantic.cron', args: {
        config: { ...config, lenses: [{ id: '{{lens}}', source: { query: 'q' } }, config.lenses[1]], ...patch }, variables,
      } }, {} as any);
      expect(result.isError).toBe(true);
      expect(insertion).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    } finally { insertion.mockRestore(); workflowRegistry.set('semantic.cron', old); }
  });

  it('roundtrips temporal windows and per-entity witnesses through previousSnapshot and replay input', () => {
    const witnesses = [{ lensId: 'hiring', itemId: 'item-a', createdAt: '2026-09-05T00:00:00Z', timestampSource: 'provider item-creation time' }];
    const entity = { entity: 'Acme', url: 'https://example.com', presentInLenses: ['hiring'], lensCount: 1, shapes: { hiring: { funding: 'yes' } }, witnesses };
    const join = { type: 'temporal', entities: [entity], lensesWithEvidence: ['hiring'], windows: [{
      start: '2026-09-05T00:00:00Z', end: '2026-09-05T00:00:00Z', witnesses, entities: [entity], lensesWithEvidence: ['hiring'],
    }] };
    const snapshot = { evaluatedAt: '2026-09-05T00:00:00Z', lenses: {}, join, signal: { fired: false, satisfiedBy: [], rule: 'all', entities: [] } };
    const cron = workflowArgumentSchema('semantic.cron').parse({ config, previousSnapshot: snapshot });
    const replay = workflowArgumentSchema('semantic.cron.replay').parse({ snapshot });
    expect(JSON.parse(JSON.stringify(cron.previousSnapshot))).toEqual(snapshot);
    expect(JSON.parse(JSON.stringify(replay.snapshot))).toEqual(snapshot);
  });

  it('requires an object output schema for Connect while preserving arbitrary JSON Schema keywords', async () => {
    const args = { websetId: 'ws', providers: ['provider'] };
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false, $defs: { named: { type: 'string' } } };
    expect(workflowArgumentSchema('connect.enrich').parse({ ...args, outputSchema }).outputSchema).toEqual(outputSchema);
    const insertion = vi.spyOn(taskStore, 'create');
    try {
      expect((await create({ type: 'connect.enrich', args: { ...args, outputSchema: { type: 'array' } } }, {} as any)).isError).toBe(true);
      expect(insertion).not.toHaveBeenCalled();
    } finally { insertion.mockRestore(); }
  });
});

describe('semantic validation before task insertion', () => {
  it.each([
    { signal: { requires: { type: 'combination', sufficient: [['hiring', 'missing']] } } },
    { signal: { requires: { type: 'combination', sufficient: [['hiring']] } } },
    { signal: { requires: { type: 'combination' } } },
    { signal: { requires: { type: 'threshold', min: 1 } } },
    { signal: { requires: { type: 'threshold', min: 3 } } },
    { join: { by: 'entity', minLensOverlap: 1 } },
    { join: { by: 'entity', minLensOverlap: 3 } },
    { lenses: [config.lenses[0]], shapes: [config.shapes[0]] },
    { join: { by: 'temporal', temporal: { days: -0.5 } } },
  ])('rejects deterministic semantic failure before insertion: %j', async (patch) => {
    const insertion = vi.spyOn(taskStore, 'create');
    const old = workflowRegistry.get('semantic.cron')!;
    const dispatch = vi.fn(); workflowRegistry.set('semantic.cron', dispatch);
    const provider = vi.fn();
    try {
      const result = await create({ type: 'semantic.cron', args: { config: { ...config, ...patch } } }, { websets: { create: provider } } as any);
      expect(result.isError).toBe(true);
      expect(insertion).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
    } finally { insertion.mockRestore(); workflowRegistry.set('semantic.cron', old); }
  });

  it('requires every existingWebsets mapping even when a source query exists', async () => {
    const insertion = vi.spyOn(taskStore, 'create');
    try {
      const result = await create({ type: 'semantic.cron', args: { config, existingWebsets: { hiring: 'ws_hiring' } } }, {} as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('existingWebsets must contain');
      expect(insertion).not.toHaveBeenCalled();
    } finally { insertion.mockRestore(); }
  });

  it.each([0, 0.5])('accepts temporal days %s through tasks.create', async days => {
    const original = workflowRegistry.get('semantic.cron')!;
    const dispatch = vi.fn().mockResolvedValue(null); workflowRegistry.set('semantic.cron', dispatch);
    try {
      const result = await create({ type: 'semantic.cron', args: { config: { ...config, join: { by: 'temporal', temporal: { days } } } } }, {} as any);
      expect(result.isError).toBeUndefined();
      expect(dispatch.mock.calls[0][1].config.join.temporal.days).toBe(days);
    } finally { workflowRegistry.set('semantic.cron', original); }
  });

  it('accepts seeded winnow without entity but rejects new collection without entity', async () => {
    const original = workflowRegistry.get('qd.winnow')!;
    const dispatch = vi.fn().mockResolvedValue(null); workflowRegistry.set('qd.winnow', dispatch);
    const insertion = vi.spyOn(taskStore, 'create');
    const common = { criteria: [{ description: 'qualified' }], enrichments: [{ description: 'owner' }] };
    try {
      expect((await create({ type: 'qd.winnow', args: { ...common, seedWebsetId: 'ws_seed' } }, {} as any)).isError).toBeUndefined();
      expect(dispatch.mock.calls[0][1].seedWebsetId).toBe('ws_seed');
      insertion.mockClear(); dispatch.mockClear();
      const critique = await create({ type: 'qd.winnow', args: { ...common, seedWebsetId: 'ws_seed', critique: true } }, {} as any);
      expect(critique.isError).toBe(true);
      expect(critique.content[0].text).toContain('entity is required when critique is true');
      expect(insertion).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
      expect((await create({ type: 'qd.winnow', args: { ...common, query: 'new collection' } }, {} as any)).isError).toBe(true);
      expect(insertion).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    } finally { insertion.mockRestore(); workflowRegistry.set('qd.winnow', original); }
  });
});
