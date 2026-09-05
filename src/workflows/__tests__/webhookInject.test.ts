import { afterEach, describe, expect, it, vi } from 'vitest';
import { create } from '../../handlers/tasks.js';
import { taskStore } from '../../lib/taskStore.js';
import { workflowRegistry, workflowMetadata } from '../types.js';
import { setEnrichmentLabelResolver, webhookEventBus } from '../../webhooks/eventBus.js';

vi.mock('../../store/db.js', () => ({
  upsertItem: vi.fn(), insertEvent: vi.fn(), normalizeDomain: (value: unknown) => String(value ?? ''),
  upsertCompany: vi.fn(), recordLensHit: vi.fn(), updateScore: vi.fn(),
}));
import { insertEvent } from '../../store/db.js';

afterEach(() => {
  setEnrichmentLabelResolver(null);
  vi.unstubAllEnvs();
  workflowRegistry.delete('webhook.inject');
  workflowMetadata.delete('webhook.inject');
});

describe('webhook injection confirmation', () => {
  it('does not complete the task before resolved metadata reaches persistence and subscribers', async () => {
    vi.stubEnv('WEBSETS_ENABLE_DEV_WORKFLOWS', '1');
    await import('../webhookInject.js');
    let resolveDefinitions!: (value: Map<string, string>) => void;
    setEnrichmentLabelResolver(() => new Promise(resolve => { resolveDefinitions = resolve; }));
    const received = vi.fn();
    const unsubscribe = webhookEventBus.subscribe(received);
    try {
      const response = await create({ type: 'webhook.inject', args: { event: {
        id: 'injected-event', type: 'webset.item.created',
        data: { id: 'item', websetId: 'ws', properties: {}, evaluations: [], enrichments: [] },
      } } }, {} as any);
      expect(response.isError).toBeUndefined();
      const { taskId } = JSON.parse(response.content[0].text);
      await Promise.resolve(); await Promise.resolve();
      expect(taskStore.get(taskId)?.status).toBe('pending');
      expect(insertEvent).not.toHaveBeenCalled(); expect(received).not.toHaveBeenCalled();
      resolveDefinitions(new Map());
      await vi.waitFor(() => expect(taskStore.get(taskId)?.status).toBe('completed'));
      expect(taskStore.get(taskId)?.result).toMatchObject({ injected: true, eventId: 'injected-event' });
      expect(insertEvent).toHaveBeenCalledOnce();
      expect(received).toHaveBeenCalledWith(expect.objectContaining({ id: 'injected-event', expectedEnrichmentIds: [] }));
    } finally { unsubscribe(); }
  });
});
