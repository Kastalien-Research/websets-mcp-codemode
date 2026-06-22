import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the store to avoid SQLite in unit tests. Item events also run the
// receiver-rule path (processWebhookItem), which touches these db helpers — mock
// them too so the rule path runs cleanly instead of throwing a caught error.
vi.mock('../../store/db.js', () => ({
  upsertItem: vi.fn(),
  insertEvent: vi.fn(),
  normalizeDomain: (x: unknown) => String(x ?? ''),
  upsertCompany: vi.fn(),
  recordLensHit: vi.fn(),
  updateScore: vi.fn(),
}));

import { upsertItem } from '../../store/db.js';
import { webhookEventBus, createEvent, primeEnrichmentLabels } from '../eventBus.js';

describe('WebhookEventBus', () => {
  it('delivers events to subscribers', () => {
    const received: unknown[] = [];
    const unsub = webhookEventBus.subscribe((e) => received.push(e));

    const event = createEvent({
      type: 'webset.item.created',
      data: { id: 'item_1' },
    });
    webhookEventBus.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
    unsub();
  });

  it('supports multiple subscribers', () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsub1 = webhookEventBus.subscribe((e) => a.push(e));
    const unsub2 = webhookEventBus.subscribe((e) => b.push(e));

    webhookEventBus.publish(createEvent({ type: 'test' }));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    unsub1();
    unsub2();
  });

  it('unsubscribe stops delivery', () => {
    const received: unknown[] = [];
    const unsub = webhookEventBus.subscribe((e) => received.push(e));
    unsub();

    webhookEventBus.publish(createEvent({ type: 'test' }));
    expect(received).toHaveLength(0);
  });

  it('subscriber errors do not affect other subscribers', () => {
    const received: unknown[] = [];
    const unsub1 = webhookEventBus.subscribe(() => { throw new Error('boom'); });
    const unsub2 = webhookEventBus.subscribe((e) => received.push(e));

    webhookEventBus.publish(createEvent({ type: 'test' }));
    expect(received).toHaveLength(1);
    unsub1();
    unsub2();
  });

  it('tracks subscriber count', () => {
    const before = webhookEventBus.subscriberCount;
    const unsub = webhookEventBus.subscribe(() => {});
    expect(webhookEventBus.subscriberCount).toBe(before + 1);
    unsub();
    expect(webhookEventBus.subscriberCount).toBe(before);
  });
});

describe('item upsert on publish (Feature 2 — store reflects ingested items)', () => {
  it('upserts the item with mapped fields on webset.item.enriched', () => {
    const event = createEvent({
      type: 'webset.item.enriched',
      data: {
        id: 'witem_map', websetId: 'ws_map',
        properties: { person: { name: 'Ada Lovelace' }, url: 'https://ada', type: 'person' },
        enrichments: [{ status: 'completed', enrichmentId: 'wenrich_1', result: ['v1'] }],
        evaluations: [{ criterion: 'real', satisfied: 'yes' }],
      },
    });
    webhookEventBus.publish(event);
    const arg = (upsertItem as unknown as { mock: { calls: any[][] } }).mock.calls.at(-1)![0];
    expect(arg.id).toBe('witem_map');
    expect(arg.websetId).toBe('ws_map');
    expect(arg.name).toBe('Ada Lovelace');
    expect(arg.url).toBe('https://ada');
    expect(arg.entityType).toBe('person');
    expect(arg.evaluations).toEqual([{ criterion: 'real', satisfied: 'yes' }]);
  });
});

describe('enrichment label map (AgX v2)', () => {
  it('labels enrichments with the human description (not enrichmentId) when the map is warm', () => {
    primeEnrichmentLabels('ws_lbl', new Map([['wenrich_1', 'Latest funding']]));
    const event = createEvent({
      type: 'webset.item.enriched',
      data: {
        id: 'witem_lbl', websetId: 'ws_lbl',
        properties: { company: { name: 'Acme' } },
        enrichments: [{ status: 'completed', enrichmentId: 'wenrich_1', result: ['Series B'] }],
      },
    });
    const received: any[] = [];
    const unsub = webhookEventBus.subscribe((e) => received.push(e));
    webhookEventBus.publish(event);
    unsub();

    // (a) payload enriched IN PLACE → the SSE-delivered event carries the label
    const broadcastEnrich = (received.at(-1).payload.data as any).enrichments[0];
    expect(broadcastEnrich.description).toBe('Latest funding');

    // (b) the store upsert is keyed by the human label, not the enrichmentId
    const arg = (upsertItem as unknown as { mock: { calls: any[][] } }).mock.calls.at(-1)![0];
    expect(arg.enrichments).toEqual({ 'Latest funding': 'Series B' });
  });

  it('falls back to enrichmentId when the label map is cold', () => {
    const event = createEvent({
      type: 'webset.item.enriched',
      data: {
        id: 'witem_cold', websetId: 'ws_cold_unknown',
        properties: { company: { name: 'Beta' } },
        enrichments: [{ status: 'completed', enrichmentId: 'wenrich_9', result: ['x'] }],
      },
    });
    webhookEventBus.publish(event);
    const arg = (upsertItem as unknown as { mock: { calls: any[][] } }).mock.calls.at(-1)![0];
    expect(arg.enrichments).toEqual({ wenrich_9: 'x' });
  });
});

describe('createEvent', () => {
  it('extracts id and type from payload', () => {
    const event = createEvent({
      id: 'evt_123',
      type: 'webset.item.enriched',
      data: {},
    });
    expect(event.id).toBe('evt_123');
    expect(event.type).toBe('webset.item.enriched');
    expect(event.receivedAt).toBeTruthy();
  });

  it('generates id when not provided', () => {
    const event = createEvent({ type: 'test' });
    expect(event.id).toBeTruthy();
    expect(event.id).not.toBe('test');
  });
});
