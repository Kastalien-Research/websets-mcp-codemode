import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Exa } from 'exa-js';
import { getAccountStatus, _resetStatusCache } from '../statusTool.js';

// --- Fixtures ---

function makeExa(overrides: {
  websetsList?: () => Promise<unknown>;
  monitorsList?: () => Promise<unknown>;
} = {}) {
  const list = vi.fn(overrides.websetsList ?? (async () => ({ data: [], hasMore: false })));
  const monitorsList = vi.fn(
    overrides.monitorsList ?? (async () => ({ data: [] })),
  );
  const mock = {
    websets: { list, monitors: { list: monitorsList } },
  };
  return { exa: mock as unknown as Exa, mock };
}

const never = () => new Promise<never>(() => {});

const FAST_TIMEOUT = 20;

describe('getAccountStatus degraded signal', () => {
  beforeEach(() => {
    _resetStatusCache();
  });

  it('reports healthy when both live calls succeed', async () => {
    const { exa } = makeExa({
      websetsList: async () => ({
        data: [{ id: 'ws_1', status: 'idle', search: { query: 'robots' } }],
        hasMore: false,
      }),
      monitorsList: async () => ({ data: [{ status: 'active' }, { status: 'paused' }] }),
    });

    const status = await getAccountStatus(exa, 'safe');

    expect(status.degraded).toBe(false);
    expect(status.errors).toEqual([]);
    expect(status.websets).not.toBeNull();
    expect(status.websets?.count).toBe(1);
    expect(status.monitors).not.toBeNull();
    expect(status.monitors?.active).toBe(1);
  });

  it('distinguishes a real empty account from failure (count 0, not degraded)', async () => {
    const { exa } = makeExa({
      websetsList: async () => ({ data: [], hasMore: false }),
      monitorsList: async () => ({ data: [] }),
    });

    const status = await getAccountStatus(exa, 'safe');

    expect(status.degraded).toBe(false);
    expect(status.errors).toEqual([]);
    expect(status.websets).not.toBeNull();
    expect(status.websets?.count).toBe(0);
    expect(status.monitors?.active).toBe(0);
  });

  it('marks both sections null and degraded when both calls time out', async () => {
    const { exa } = makeExa({ websetsList: never, monitorsList: never });

    const status = await getAccountStatus(exa, 'safe', { timeoutMs: FAST_TIMEOUT });

    expect(status.degraded).toBe(true);
    expect(status.websets).toBeNull();
    expect(status.monitors).toBeNull();
    expect(status.errors).toHaveLength(2);
    expect(status.errors.some(e => e.startsWith('websets:'))).toBe(true);
    expect(status.errors.some(e => e.startsWith('monitors:'))).toBe(true);
    // in-memory task data is still present even when Exa is unavailable
    expect(status.tasks).toBeDefined();
    expect(Array.isArray(status.tasks.active)).toBe(true);
  });

  it('isolates per-call failures (websets ok, monitors times out)', async () => {
    const { exa } = makeExa({
      websetsList: async () => ({ data: [{ id: 'ws_1', status: 'idle' }], hasMore: false }),
      monitorsList: never,
    });

    const status = await getAccountStatus(exa, 'safe', { timeoutMs: FAST_TIMEOUT });

    expect(status.degraded).toBe(true);
    expect(status.websets).not.toBeNull();
    expect(status.websets?.count).toBe(1);
    expect(status.monitors).toBeNull();
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0]).toMatch(/^monitors:/);
  });

  it('sanitizes thrown (non-timeout) errors without leaking the raw payload', async () => {
    const secret = 'exa_sk_live_should_never_appear';
    const { exa } = makeExa({
      websetsList: async () => {
        throw new Error(`401 Unauthorized key=${secret}`);
      },
    });

    const status = await getAccountStatus(exa, 'safe', { timeoutMs: FAST_TIMEOUT });

    expect(status.degraded).toBe(true);
    expect(status.websets).toBeNull();
    expect(status.errors).toHaveLength(1);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(secret);
  });

  it('caches healthy results but not degraded results', async () => {
    // healthy: second call served from cache, mock not re-invoked
    const healthy = makeExa();
    await getAccountStatus(healthy.exa, 'safe');
    await getAccountStatus(healthy.exa, 'safe');
    expect(healthy.mock.websets.list).toHaveBeenCalledTimes(1);

    _resetStatusCache();

    // degraded: not cached, mock re-invoked on the next call
    const degraded = makeExa({ websetsList: never });
    const first = await getAccountStatus(degraded.exa, 'safe', { timeoutMs: FAST_TIMEOUT });
    expect(first.degraded).toBe(true);
    await getAccountStatus(degraded.exa, 'safe', { timeoutMs: FAST_TIMEOUT });
    expect(degraded.mock.websets.list).toHaveBeenCalledTimes(2);
  });
});
