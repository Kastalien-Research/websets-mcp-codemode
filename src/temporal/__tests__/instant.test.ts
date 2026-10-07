import { describe, it, expect } from 'vitest';
import { parseAsOf, snapshotWindowStart } from '../instant.js';

// Window start for this clock is 2026-05-07T12:00:00Z.
const now = new Date('2026-10-07T12:00:00Z');

describe('parseAsOf', () => {
  it('accepts a date as midnight UTC and date-times with an offset, normalized to UTC', () => {
    expect(parseAsOf('2026-08-01', now)).toEqual({ ok: true, asOf: '2026-08-01T00:00:00Z' });
    expect(parseAsOf('2026-08-01T02:30:00+02:00', now)).toEqual({ ok: true, asOf: '2026-08-01T00:30:00Z' });
    expect(parseAsOf('2026-08-01T00:00:00.250Z', now)).toEqual({ ok: true, asOf: '2026-08-01T00:00:00.250Z' });
  });

  it('rejects values that are not unambiguous ISO 8601 instants', () => {
    for (const value of ['yesterday', '', '08/01/2026', '2026-02-31', '2026-13-01', '2026-08-01T00:00:00']) {
      expect(parseAsOf(value, now).ok, value).toBe(false);
    }
  });

  it('rejects instants in the future', () => {
    const parsed = parseAsOf('2026-10-07T12:00:01Z', now);
    expect(parsed).toEqual({ ok: false, reason: '2026-10-07T12:00:01Z is in the future' });
  });

  it('rejects instants older than the window and names the earliest allowed', () => {
    expect(snapshotWindowStart(now).toISOString()).toBe('2026-05-07T12:00:00.000Z');
    expect(parseAsOf('2026-05-07', now)).toEqual({
      ok: false,
      reason: '2026-05-07T00:00:00Z is older than the 5-month Snapshot window (earliest: 2026-05-07T12:00:00Z)',
    });
    expect(parseAsOf('2026-05-08', now).ok).toBe(true);
  });
});
