import { describe, it, expect } from 'vitest';
import { decideItemReady, SYNTHETIC_ITEM_READY, type ChannelEvent } from '../channelSynthesis.js';

// Build a minimal item event payload shaped like what the bridge actually
// sees from /webhooks/exa (data.evaluations[].satisfied).
function evt(satisfied: Array<'yes' | 'no' | 'unclear'> | null): ChannelEvent {
  return {
    id: 'event_test',
    type: 'webset.item.enriched',
    payload: {
      data: {
        id: 'witem_test',
        websetId: 'webset_test',
        evaluations: satisfied === null
          ? undefined
          : satisfied.map(s => ({ criterion: 'test', satisfied: s, reasoning: '' })),
      },
    },
  };
}

describe('decideItemReady (permissive criteria filter)', () => {
  it('emits webset.item.ready when every evaluation is yes', () => {
    const result = decideItemReady(evt(['yes', 'yes', 'yes']));
    expect(result.emit).toBe(true);
    if (result.emit) expect(result.syntheticType).toBe(SYNTHETIC_ITEM_READY);
  });

  it('emits when evaluations mix yes and unclear (permissive)', () => {
    const result = decideItemReady(evt(['yes', 'unclear', 'yes']));
    expect(result.emit).toBe(true);
  });

  it('emits when every evaluation is unclear', () => {
    const result = decideItemReady(evt(['unclear', 'unclear']));
    expect(result.emit).toBe(true);
  });

  it('drops the item when ANY evaluation is no', () => {
    const result = decideItemReady(evt(['yes', 'no', 'yes']));
    expect(result.emit).toBe(false);
  });

  it('drops the item when every evaluation is no', () => {
    const result = decideItemReady(evt(['no', 'no']));
    expect(result.emit).toBe(false);
  });

  it('drops the item when a single no is mixed with unclear', () => {
    const result = decideItemReady(evt(['unclear', 'no']));
    expect(result.emit).toBe(false);
  });

  it('emits when evaluations is missing (no criteria on the webset)', () => {
    const result = decideItemReady(evt(null));
    expect(result.emit).toBe(true);
  });

  it('emits when evaluations is an empty array', () => {
    const result = decideItemReady(evt([]));
    expect(result.emit).toBe(true);
  });

  it('tolerates evaluations with missing satisfied field (treats as not-no)', () => {
    const event: ChannelEvent = {
      id: 'event_test',
      type: 'webset.item.enriched',
      payload: {
        data: {
          id: 'witem_test',
          evaluations: [
            { criterion: 'a', satisfied: 'yes', reasoning: '' },
            { criterion: 'b', reasoning: 'pending' }, // no satisfied field
          ],
        },
      },
    };
    const result = decideItemReady(event);
    expect(result.emit).toBe(true);
  });

  it('tolerates payload.data being missing entirely', () => {
    const event: ChannelEvent = {
      id: 'event_test',
      type: 'webset.item.enriched',
      payload: {},
    };
    const result = decideItemReady(event);
    expect(result.emit).toBe(true);
  });

  it('synthetic type constant is webset.item.ready', () => {
    expect(SYNTHETIC_ITEM_READY).toBe('webset.item.ready');
  });
});
