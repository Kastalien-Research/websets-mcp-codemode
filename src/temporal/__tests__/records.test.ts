import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDb, getDb } from '../../store/db.js';
import { DEFAULT_SNAPSHOT_BUDGET, snapshotBudget, snapshotRequestKey, storeSnapshotRecords } from '../records.js';

const AS_OF = '2026-08-01T00:00:00Z';

describe('storeSnapshotRecords', () => {
  beforeEach(() => {
    closeDb();
    getDb(':memory:');
  });
  afterEach(() => closeDb());

  it('replays exactly what was recorded, with when it was fetched', () => {
    const records = storeSnapshotRecords();
    const response = { requestId: 'r1', results: [{ url: 'https://example.com', text: 'v1' }] };
    records.record({ requestKey: 'k', endpoint: 'contents', snapshotAsOf: AS_OF, request: { urls: ['https://example.com'] }, response });
    const replayed = records.replay('k');
    expect(replayed?.response).toEqual(response);
    expect(Number.isNaN(Date.parse(replayed!.fetchedAt))).toBe(false);
    expect(records.replay('other')).toBeNull();
    expect(records.recorded()).toBe(1);
  });

  it('refuses to replay a record whose response no longer matches its hash', () => {
    const records = storeSnapshotRecords();
    records.record({ requestKey: 'k', endpoint: 'search', snapshotAsOf: AS_OF, request: {}, response: { results: [] } });
    getDb().prepare("UPDATE snapshot_requests SET response = '{\"results\":[{\"title\":\"edited\"}]}'").run();
    expect(() => records.replay('k')).toThrow('snapshot record k failed its integrity check');
  });

  it('counts spend independently of records', () => {
    const records = storeSnapshotRecords(5);
    records.spend({ requestKey: 'k', endpoint: 'search', snapshotAsOf: AS_OF });
    records.spend({ requestKey: 'k', endpoint: 'search', snapshotAsOf: AS_OF });
    expect(records.spent()).toBe(2);
    expect(records.recorded()).toBe(0);
    expect(records.budget).toBe(5);
  });
});

describe('snapshotRequestKey', () => {
  it('is the same for equal requests regardless of key order', () => {
    expect(snapshotRequestKey('search', { query: 'q', options: { numResults: 2, contents: { snapshotAsOf: AS_OF } } }))
      .toBe(snapshotRequestKey('search', { options: { contents: { snapshotAsOf: AS_OF }, numResults: 2 }, query: 'q' }));
  });

  it('differs by call, arguments and instant', () => {
    const base = snapshotRequestKey('search', { query: 'q', snapshotAsOf: AS_OF });
    expect(snapshotRequestKey('getContents', { query: 'q', snapshotAsOf: AS_OF })).not.toBe(base);
    expect(snapshotRequestKey('search', { query: 'r', snapshotAsOf: AS_OF })).not.toBe(base);
    expect(snapshotRequestKey('search', { query: 'q', snapshotAsOf: '2026-08-01T00:00:01Z' })).not.toBe(base);
  });
});

describe('snapshotBudget', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the pay-as-you-go allowance and accepts a non-negative integer override', () => {
    vi.stubEnv('SNAPSHOT_BUDGET', '');
    expect(snapshotBudget()).toBe(DEFAULT_SNAPSHOT_BUDGET);
    vi.stubEnv('SNAPSHOT_BUDGET', '25');
    expect(snapshotBudget()).toBe(25);
    vi.stubEnv('SNAPSHOT_BUDGET', 'lots');
    expect(snapshotBudget()).toBe(DEFAULT_SNAPSHOT_BUDGET);
  });
});
