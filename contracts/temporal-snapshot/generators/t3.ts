// Produces fixtures/t3-status.json, the artifact criterion C8 shows a fresh
// model: real `status` output against an in-memory store seeded with
// FIXTURE_CONSTANTS.t3.used spent requests, on a clock fixed so the window
// starts at FIXTURE_CONSTANTS.t3.windowFrom.
//
// usage: npx tsx contracts/temporal-snapshot/generators/t3.ts

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_CONSTANTS } from '../contract.js';
import { recordingClient } from '../harness/recording-client.js';
import { closeDb, getDb } from '../../../src/store/db.js';
import { storeSnapshotRecords } from '../../../src/temporal/records.js';
import { getAccountStatus, _resetStatusCache } from '../../../src/tools/statusTool.js';

const { used, budget, windowFrom } = FIXTURE_CONSTANTS.t3;
closeDb();
getDb(':memory:');
const records = storeSnapshotRecords(budget);
for (let i = 0; i < used; i++) {
  records.spend({ requestKey: `k${i}`, endpoint: i % 2 ? 'contents' : 'search', snapshotAsOf: '2026-08-01T00:00:00Z' });
  if (i % 3 === 0) {
    records.record({ requestKey: `k${i}`, endpoint: 'search', snapshotAsOf: '2026-08-01T00:00:00Z', request: { i }, response: { results: [] } });
  }
}

_resetStatusCache();
const empty = recordingClient(path => (path.startsWith('websets') ? { data: [], hasMore: false } : {})).client;
const status = await getAccountStatus(empty, 'strict', {
  now: new Date(`${windowFrom.replace('-05-', '-10-')}T00:00:00Z`),
  snapshotRecords: records,
});
const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
writeFileSync(join(fixtures, 't3-status.json'), `${JSON.stringify(status, null, 2)}\n`);
console.log(`wrote fixtures/t3-status.json (snapshot: ${JSON.stringify(status.snapshot)})`);
process.exit(0);
