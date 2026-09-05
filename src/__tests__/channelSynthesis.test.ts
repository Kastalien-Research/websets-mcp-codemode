import { describe, it, expect } from 'vitest';
import { decideItemReady, selectItemNotification, SYNTHETIC_ITEM_READY, type ChannelEvent } from '../channelSynthesis.js';

function event(evaluations: string[] = ['yes']): ChannelEvent {
  return {
    id: 'event', type: 'webset.item.enriched', expectedEnrichmentIds: ['enr'],
    payload: { data: { id: 'item', websetId: 'ws',
      evaluations: evaluations.map(satisfied => ({ criterion: 'test', satisfied })),
      enrichments: [{ enrichmentId: 'enr', status: 'completed', result: ['value'] }],
    } },
  };
}
function data(e: ChannelEvent): any { return e.payload.data; }

describe('item readiness', () => {
  it.each([['yes', 'yes'], ['yes', 'unclear'], ['unclear'], []])('allows complete enrichment with evaluations %j', (...values) => {
    expect(decideItemReady(event(values))).toEqual({ emit: true, syntheticType: SYNTHETIC_ITEM_READY });
  });
  it.each(['no', 'pending', 'invalid'])('does not emit ready with %s evaluation', value => {
    expect(decideItemReady(event(['yes', value])).emit).toBe(false);
  });
  it.each(['pending', 'failed', 'canceled', undefined])('does not emit ready with %s enrichment status', status => {
    const e = event(); data(e).enrichments[0].status = status;
    expect(decideItemReady(e)).toEqual({ emit: false, reason: 'incomplete_enrichments' });
  });
  it('requires every expected enrichment and rejects duplicate matches', () => {
    const e = event(); e.expectedEnrichmentIds!.push('other');
    expect(decideItemReady(e).emit).toBe(false);
    data(e).enrichments.push({ enrichmentId: 'other', status: 'completed' });
    expect(decideItemReady(e).emit).toBe(true);
    data(e).enrichments.push({ enrichmentId: 'other', status: 'completed' });
    expect(decideItemReady(e).emit).toBe(false);
  });
  it.each([null, undefined, ['enr', 'enr']])('does not infer completion from unknown/invalid definitions %j', expected => {
    const e = event(); e.expectedEnrichmentIds = expected;
    expect(decideItemReady(e)).toMatchObject({ emit: false, reason: 'unknown_definitions' });
  });
  it('allows a confirmed empty enrichment definition and explicit null results', () => {
    const e = event(); e.expectedEnrichmentIds = []; data(e).enrichments = null;
    expect(decideItemReady(e).emit).toBe(true);
  });
  it.each(['id', 'websetId', 'evaluations', 'enrichments'])('rejects an incomplete %s field', field => {
    const e = event(); delete data(e)[field];
    expect(decideItemReady(e)).toMatchObject({ emit: false, reason: 'invalid_item' });
  });
  it('rejects malformed evaluations or a missing payload', () => {
    const e = event(); data(e).evaluations = [{}];
    expect(decideItemReady(e).emit).toBe(false);
    e.payload = {}; expect(decideItemReady(e).emit).toBe(false);
  });
});

describe('notification selection after a quiet interval', () => {
  const policy = (types?: string[]) => (e: ChannelEvent, explicit: boolean) => types ? types.includes(e.type) : !explicit;
  it('uses a ready event by default and does not emit non-ready raw events by default', () => {
    const e = event(); const raw = new Map([[e.type, e]]);
    expect(selectItemNotification(e, raw, policy())?.type).toBe(SYNTHETIC_ITEM_READY);
    data(e).enrichments[0].status = 'pending';
    expect(selectItemNotification(e, raw, policy())).toBeUndefined();
  });
  it.each(['yes', 'no', 'unclear'])('preserves explicitly enabled raw events for %s rows even if non-ready', evaluation => {
    const e = event([evaluation]); e.expectedEnrichmentIds = null;
    const created = { ...e, type: 'webset.item.created' };
    const raw = new Map([[e.type, e], [created.type, created]]);
    expect(selectItemNotification(e, raw, policy([created.type]))).toBe(created);
    expect(selectItemNotification(e, raw, policy([e.type, created.type]))).toBe(e);
    expect(selectItemNotification(e, raw, policy([]))).toBeUndefined();
  });
});
