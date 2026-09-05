import { afterEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ notification: vi.fn().mockResolvedValue(undefined), connect: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({ Server: class {
  connect = bridge.connect;
  notification = bridge.notification;
} }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('node:fs', () => ({
  readFileSync: (path: string) => JSON.stringify(path.endsWith('channel-config.json') ? {
    default: { enabled: true },
    websets: {
      readyOnly: { events: ['webset.item.ready'] },
      disabled: { enabled: false, events: ['webset.item.created', 'webset.item.enriched'] },
      createdOnly: { events: ['webset.item.created'] },
      enrichedOnly: { events: ['webset.item.enriched'] },
    },
  } : {}),
  watchFile: vi.fn(), unwatchFile: vi.fn(),
}));

let initialExitListeners: Array<(...args: any[]) => void> = [];
afterEach(() => {
  for (const listener of process.listeners('exit')) {
    if (!initialExitListeners.includes(listener)) process.removeListener('exit', listener);
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('actual channel SSE-to-MCP routing', () => {
  it('requires explicit raw opt-in for invalid IDs, respects disabled websets, and still coalesces valid IDs', async () => {
    initialExitListeners = process.listeners('exit');
    vi.useFakeTimers();
    vi.stubEnv('WEBSETS_CHANNEL_CONFIG', '/offline/channel-config.json');
    vi.stubEnv('CHANNEL_ITEM_COALESCE_MS', '20');
    const events: Array<Record<string, unknown>> = [];
    const expectedImmediate: string[] = [];
    for (const type of ['webset.item.created', 'webset.item.enriched']) {
      for (const websetId of ['default', 'readyOnly', 'disabled', 'createdOnly', 'enrichedOnly']) {
        for (const id of [undefined, null, '', '   ', 0, 42, {}, []]) {
          const eventId = `event-${events.length}`;
          events.push({ id: eventId, type, payload: { data: { id, websetId } } });
          if ((websetId === 'createdOnly' && type === 'webset.item.created')
            || (websetId === 'enrichedOnly' && type === 'webset.item.enriched')) expectedImmediate.push(eventId);
        }
      }
    }
    events.push({ id: 'valid-item', type: 'webset.item.created', payload: { data: { id: 'item-1', websetId: 'createdOnly' } } });
    // Feed the actual bridge a mocked SSE frame. A pending second read keeps the
    // stream open without a reconnect loop, sockets, or provider requests.
    const reader = { read: vi.fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')) })
      .mockImplementation(() => new Promise(() => {})) };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => reader } });
    vi.stubGlobal('fetch', fetchMock);
    await import('../channel.js');
    await vi.advanceTimersByTimeAsync(0);
    expect(reader.read).toHaveBeenCalledTimes(2); // Every frame was routed.
    const deliveredIds = () => bridge.notification.mock.calls.map(([notification]) => notification.params.meta.event_id);
    expect(deliveredIds()).toEqual(expectedImmediate);
    expect(bridge.connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20);
    expect(deliveredIds()).toEqual([...expectedImmediate, 'valid-item']);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
