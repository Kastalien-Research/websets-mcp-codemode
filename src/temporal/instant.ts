import { z } from 'zod';

/** Exa Snapshot serves stored versions from a rolling window of this many months. */
export const SNAPSHOT_WINDOW_MONTHS = 5;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export type ParsedAsOf = { ok: true; asOf: string } | { ok: false; reason: string };

/** Earliest instant Snapshot can be pinned to at `now`. */
export function snapshotWindowStart(now: Date = new Date()): Date {
  const start = new Date(now);
  start.setUTCMonth(start.getUTCMonth() - SNAPSHOT_WINDOW_MONTHS);
  return start;
}

/** ISO 8601 in UTC, without milliseconds when they are zero. */
export function formatInstant(date: Date): string {
  return date.toISOString().replace('.000Z', 'Z');
}

/**
 * Parses a Snapshot instant: an ISO 8601 date (midnight UTC) or a date-time
 * with an explicit offset. Rejects anything ambiguous, in the future, or older
 * than the Snapshot window, and returns the instant normalized to UTC.
 */
export function parseAsOf(value: string, now: Date = new Date()): ParsedAsOf {
  let date: Date;
  if (DATE_ONLY.test(value)) {
    date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      return { ok: false, reason: `"${value}" is not a calendar date` };
    }
  } else if (DATE_TIME.test(value)) {
    date = new Date(value);
    if (Number.isNaN(date.getTime())) return { ok: false, reason: `"${value}" is not a valid date-time` };
  } else {
    return {
      ok: false,
      reason: `"${value}" is not an ISO 8601 date (2026-06-01) or date-time with a timezone (2026-06-01T00:00:00Z)`,
    };
  }

  if (date.getTime() > now.getTime()) {
    return { ok: false, reason: `${formatInstant(date)} is in the future` };
  }
  const start = snapshotWindowStart(now);
  if (date.getTime() < start.getTime()) {
    return {
      ok: false,
      reason: `${formatInstant(date)} is older than the ${SNAPSHOT_WINDOW_MONTHS}-month Snapshot window (earliest: ${formatInstant(start)})`,
    };
  }
  return { ok: true, asOf: formatInstant(date) };
}

/** Zod schema for a Snapshot instant, checked against the current clock. */
export const snapshotInstant = z.string().superRefine((value, ctx) => {
  const parsed = parseAsOf(value);
  if (!parsed.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.reason });
});
