import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the store to avoid SQLite in unit tests
vi.mock('../../store/db.js', () => ({
  upsertItem: vi.fn(),
  insertEvent: vi.fn(),
}));

import { webhookEventBus, createEvent } from '../eventBus.js';

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
