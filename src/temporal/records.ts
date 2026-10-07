import { createHash } from 'node:crypto';
import {
  countSnapshotRecords,
  countSnapshotSpend,
  getSnapshotRecord,
  insertSnapshotRecord,
  insertSnapshotSpend,
} from '../store/db.js';

/** Pay-as-you-go Exa Snapshot allows 100 requests before a sales conversation. */
export const DEFAULT_SNAPSHOT_BUDGET = 100;

/**
 * Where the client guard records snapshot requests, replays identical ones,
 * and counts spend. Exa returns no crawl time, so only an identical request at
 * the identical instant can be answered from a record.
 */
export interface SnapshotRecords {
  readonly budget: number;
  spent(): number;
  recorded(): number;
  replay(requestKey: string): { response: unknown; fetchedAt: string } | null;
  record(entry: { requestKey: string; endpoint: string; snapshotAsOf: string; request: unknown; response: unknown }): void;
  spend(entry: { requestKey: string; endpoint: string; snapshotAsOf: string }): void;
}

export function snapshotBudget(): number {
  const configured = Number(process.env.SNAPSHOT_BUDGET);
  return process.env.SNAPSHOT_BUDGET && Number.isInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_SNAPSHOT_BUDGET;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** JSON with object keys sorted, so equal requests serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]]))
      : v);
}

export function snapshotRequestKey(call: string, request: unknown): string {
  return sha256(`${call}\n${canonicalJson(request)}`);
}

/** SnapshotRecords backed by the local SQLite store. */
export function storeSnapshotRecords(budget: number = snapshotBudget()): SnapshotRecords {
  return {
    budget,
    spent: countSnapshotSpend,
    recorded: countSnapshotRecords,
    replay(requestKey) {
      const row = getSnapshotRecord(requestKey);
      if (!row) return null;
      if (sha256(row.response) !== row.response_hash) {
        throw new Error(`snapshot record ${requestKey} failed its integrity check (stored hash does not match the response)`);
      }
      return { response: JSON.parse(row.response), fetchedAt: row.fetched_at };
    },
    record({ requestKey, endpoint, snapshotAsOf, request, response }) {
      const text = JSON.stringify(response);
      insertSnapshotRecord({
        request_key: requestKey,
        endpoint,
        snapshot_as_of: snapshotAsOf,
        request: canonicalJson(request),
        response: text,
        response_hash: sha256(text),
        fetched_at: new Date().toISOString(),
      });
    },
    spend({ requestKey, endpoint, snapshotAsOf }) {
      insertSnapshotSpend({ requestKey, endpoint, snapshotAsOf });
    },
  };
}
