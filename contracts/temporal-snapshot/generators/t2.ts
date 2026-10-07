// Produces fixtures/t2-pinned-response.json, the artifact criterion C7 shows a
// fresh model: the real pinned `execute` output for a search, replaying the
// recorded live /search response (fixtures/t2-live-probe-search.json) instead
// of spending another Snapshot request.
//
// usage: npx tsx contracts/temporal-snapshot/generators/t2.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_CONSTANTS } from '../contract.js';
import { recordingClient } from '../harness/recording-client.js';
import { runExecute } from '../../../src/tools/executeTool.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const recorded = JSON.parse(readFileSync(join(fixtures, 't2-live-probe-search.json'), 'utf8'));
const rec = recordingClient(path => (path === 'search' ? recorded : { results: [] }));

const result = await runExecute({
  asOf: FIXTURE_CONSTANTS.t2.asOf,
  code: "return await callOperation('exa.search', { query: 'latest stable Python release notes', numResults: 2, contents: { highlights: true } });",
}, rec.client);

if (result.isError) throw new Error(`pinned execute failed: ${JSON.stringify(result.content)}`);
const text = (result.content[0] as { text: string }).text;
writeFileSync(join(fixtures, 't2-pinned-response.json'), `${text}\n`);
console.log(`wrote fixtures/t2-pinned-response.json (${rec.calls.length} replayed call)`);
process.exit(0);
