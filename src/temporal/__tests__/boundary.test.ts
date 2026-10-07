import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Exa } from 'exa-js';
import { guardSnapshots, PINNABLE_OPERATIONS } from '../boundary.js';
import { dispatchOperation } from '../../tools/operations.js';
import { closeDb, getDb } from '../../store/db.js';
import { storeSnapshotRecords } from '../records.js';

const AS_OF = '2026-08-01T00:00:00Z';
const LATER = '2026-08-02T00:00:00Z';
const EARLIER = '2026-07-01T00:00:00Z';

function fakeExa(body: Record<string, unknown> = { results: [] }) {
  const exa = {
    search: vi.fn(async () => body),
    getContents: vi.fn(async () => body),
    rawRequest: vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    answer: vi.fn(async () => ({ answer: 'live' })),
    websets: { list: vi.fn(async () => ({ data: [] })) },
  };
  return { exa, client: exa as unknown as Exa };
}

describe('guardSnapshots without a pinned instant', () => {
  it('passes requests without a snapshot through untouched', async () => {
    const { exa, client } = fakeExa({ results: [{ url: 'u' }] });
    const guarded = guardSnapshots(client);
    expect(await guarded.search('q', { numResults: 1 } as any)).toEqual({ results: [{ url: 'u' }] });
    expect(exa.search).toHaveBeenCalledWith('q', { numResults: 1 });
    await guarded.answer('q');
    await (guarded as any).websets.list();
    expect(exa.answer).toHaveBeenCalledOnce();
    expect(exa.websets.list).toHaveBeenCalledOnce();
  });

  it('rejects snapshotAsOf on members that cannot honor it', async () => {
    const { exa, client } = fakeExa();
    await expect(async () => (guardSnapshots(client) as any).answer('q', { snapshotAsOf: AS_OF }))
      .rejects.toThrow('TEMPORAL_BOUNDARY: snapshotAsOf is only supported by search and getContents, not answer.');
    expect(exa.answer).not.toHaveBeenCalled();
  });
});

describe('guardSnapshots pinned to an instant', () => {
  it('injects the instant into search contents, contents options and the /contents body', async () => {
    const { exa, client } = fakeExa();
    const pinned = guardSnapshots(client, AS_OF);
    await pinned.search('q', { contents: { highlights: true } } as any);
    await pinned.getContents(['https://example.com'], { text: true } as any);
    await (pinned as any).rawRequest('/contents', 'POST', { ids: ['https://example.com'] });
    expect(exa.search).toHaveBeenCalledWith('q', { contents: { highlights: true, snapshotAsOf: AS_OF } });
    expect(exa.getContents).toHaveBeenCalledWith(['https://example.com'], { text: true, snapshotAsOf: AS_OF });
    expect(exa.rawRequest).toHaveBeenCalledWith('/contents', 'POST', { ids: ['https://example.com'], snapshotAsOf: AS_OF }, undefined);
  });

  it('keeps an earlier per-call snapshot and refuses a later one without calling Exa', async () => {
    const { exa, client } = fakeExa();
    const pinned = guardSnapshots(client, AS_OF);
    await pinned.getContents(['u'], { snapshotAsOf: EARLIER } as any);
    expect(exa.getContents).toHaveBeenCalledWith(['u'], { snapshotAsOf: EARLIER });
    await expect(pinned.getContents(['u'], { snapshotAsOf: LATER } as any))
      .rejects.toThrow(`snapshotAsOf ${LATER} is later than this run's asOf ${AS_OF}`);
    expect(exa.getContents).toHaveBeenCalledOnce();
  });

  it('refuses every other client member', async () => {
    const { exa, client } = fakeExa();
    const pinned = guardSnapshots(client, AS_OF) as any;
    expect(() => pinned.answer('q')).toThrow(`TEMPORAL_BOUNDARY: exa.answer is not available in a run pinned to ${AS_OF}`);
    expect(() => pinned.websets.list()).toThrow('exa.websets.list is not available');
    await expect(pinned.rawRequest('/answer', 'POST', {})).rejects.toThrow('POST /answer is not available');
    expect(exa.answer).not.toHaveBeenCalled();
    expect(exa.websets.list).not.toHaveBeenCalled();
  });

  it('refuses options that reach the live web or are unsupported with a snapshot', async () => {
    const { exa, client } = fakeExa();
    const pinned = guardSnapshots(client, AS_OF);
    await expect(pinned.getContents(['u'], { livecrawl: 'always' } as any)).rejects.toThrow('livecrawl cannot be combined with a snapshot');
    await expect(pinned.search('q', { type: 'deep' } as any)).rejects.toThrow('search type "deep" cannot be combined with a snapshot');
    await expect(pinned.search('q', { category: 'news' } as any)).rejects.toThrow('category cannot be combined with a snapshot');
    expect(exa.search).not.toHaveBeenCalled();
    expect(exa.getContents).not.toHaveBeenCalled();
  });
});

describe('snapshot responses', () => {
  it('labels results without snapshotAt as provider-guaranteed and says discovery used current ranking', async () => {
    const { client } = fakeExa({ results: [{ url: 'a' }, { url: 'b' }] });
    const response = await guardSnapshots(client, AS_OF).search('q') as any;
    expect(response.temporal).toMatchObject({
      snapshotAsOf: AS_OF,
      verification: 'provider-guaranteed',
      verificationNote: "2 of 2 results did not report a crawl time (snapshotAt), so the bound rests on Exa's guarantee rather than a check by this server.",
      discovery: 'current-ranking',
    });
    expect(response.results).toEqual([{ url: 'a' }, { url: 'b' }]);
  });

  it('labels contents verified when every result reports an earlier crawl time, and lists pages not stored', async () => {
    const { client } = fakeExa({
      results: [{ url: 'a', snapshotAt: EARLIER }],
      statuses: [
        { id: 'a', status: 'success', source: 'cached' },
        { id: 'b', status: 'error', error: { tag: 'CONTENT_NOT_CACHED' } },
      ],
    });
    const response = await guardSnapshots(client, AS_OF).getContents(['a', 'b']) as any;
    expect(response.temporal.verification).toBe('verified');
    expect(response.temporal.discovery).toBeUndefined();
    expect(response.temporal.notStored).toEqual([{ id: 'b', reason: 'CONTENT_NOT_CACHED' }]);
  });

  it('turns a late crawl time or a live-sourced page into TEMPORAL_LEAK without echoing content', async () => {
    const late = guardSnapshots(fakeExa({ results: [{ url: 'a', snapshotAt: LATER, text: 'SECRET FUTURE TEXT' }] }).client, AS_OF);
    const error = await late.search('q').catch((err: Error) => err);
    expect(String(error)).toContain('TEMPORAL_LEAK');
    expect(String(error)).toContain(`a (snapshotAt ${LATER})`);
    expect(String(error)).not.toContain('SECRET FUTURE TEXT');

    const live = guardSnapshots(fakeExa({ results: [{ url: 'a' }], statuses: [{ id: 'a', status: 'success', source: 'live' }] }).client, AS_OF);
    await expect(live.getContents(['a'])).rejects.toThrow('a (served from live, not a stored version)');
  });
});

describe('dispatchOperation in a pinned run', () => {
  it('refuses non-pinnable operations before validation, naming what can run instead', async () => {
    const { exa, client } = fakeExa();
    const result = await dispatchOperation('websets.list', { bogus: true }, client, 'strict', { asOf: AS_OF });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: `Error in websets.list: TEMPORAL_BOUNDARY: websets.list cannot run in a run pinned to ${AS_OF}: it reaches live data that Exa Snapshot cannot bound to a past instant. Pinnable operations: ${[...PINNABLE_OPERATIONS].join(', ')}. To use websets.list, call it from an execute run without asOf.`,
    });
    expect(exa.websets.list).not.toHaveBeenCalled();
  });
});

describe('guardSnapshots with records', () => {
  beforeEach(() => {
    closeDb();
    getDb(':memory:');
  });
  afterEach(() => closeDb());

  it('replays an identical request from the record without calling Exa or spending', async () => {
    const { exa, client } = fakeExa({ results: [{ url: 'a', title: 'first fetch' }] });
    const records = storeSnapshotRecords(10);
    const pinned = guardSnapshots(client, AS_OF, records);
    const fresh = await pinned.search('q') as any;
    const replay = await pinned.search('q') as any;
    expect(exa.search).toHaveBeenCalledOnce();
    expect(records.spent()).toBe(1);
    expect(fresh.temporal.source).toBe('upstream');
    expect(replay.temporal).toMatchObject({ source: 'record', snapshotAsOf: AS_OF, verification: 'provider-guaranteed' });
    expect(replay.results).toEqual(fresh.results);
  });

  it('treats the same instant spelled differently as the same request, and another instant as new', async () => {
    const { exa, client } = fakeExa();
    const records = storeSnapshotRecords(10);
    const guarded = guardSnapshots(client, undefined, records);
    await guarded.getContents(['a'], { snapshotAsOf: '2026-08-01' } as any);
    await guarded.getContents(['a'], { snapshotAsOf: '2026-08-01T02:00:00+02:00' } as any);
    expect(exa.getContents).toHaveBeenCalledOnce();
    await guarded.getContents(['a'], { snapshotAsOf: '2026-08-01T00:00:01Z' } as any);
    expect(exa.getContents).toHaveBeenCalledTimes(2);
  });

  it('refuses new requests once the budget is spent, but keeps replaying', async () => {
    const { exa, client } = fakeExa();
    const pinned = guardSnapshots(client, AS_OF, storeSnapshotRecords(1));
    await pinned.search('first');
    await expect(pinned.search('second')).rejects.toThrow('TEMPORAL_BUDGET: the local Snapshot budget is spent (1 of 1 requests)');
    await expect(pinned.search('first')).resolves.toMatchObject({ temporal: { source: 'record' } });
    expect(exa.search).toHaveBeenCalledOnce();
  });

  it('charges a failed upstream request without recording it', async () => {
    const { exa, client } = fakeExa();
    exa.search.mockRejectedValueOnce(new Error('upstream 500'));
    const records = storeSnapshotRecords(10);
    await expect(guardSnapshots(client, AS_OF, records).search('q')).rejects.toThrow('upstream 500');
    expect(records.spent()).toBe(1);
    expect(records.recorded()).toBe(0);
  });
});

describe('exa.search with stream and a snapshot', () => {
  it('names stream as the conflicting parameter', async () => {
    const { exa, client } = fakeExa();
    const result = await dispatchOperation('exa.search', { query: 'q', stream: true }, client, 'strict', { asOf: AS_OF });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: 'Error in exa.search: TEMPORAL_BOUNDARY: stream cannot be combined with a snapshot: snapshot results arrive in one response. Drop stream: true.',
    });
    expect(exa.search).not.toHaveBeenCalled();
  });
});
