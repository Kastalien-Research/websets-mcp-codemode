// Run inside the built production image with --network none and temporary data.
// The child boots dist/index.js; only provider HTTP is replaced with fixed data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const timestamp = '2026-09-05T00:00:00Z';
const custom = { type: 'custom', description: 'Machine learning job postings' };
const item = (id, evaluations) => ({
  id, websetId: 'smoke-ws', createdAt: timestamp, updatedAt: timestamp,
  properties: { type: 'company', company: { name: id }, url: `https://${id}.example`, content: 'Full evidence' },
  evaluations: evaluations.map(satisfied => ({ criterion: 'criterion', satisfied, reasoning: 'Raw evidence' })),
  enrichments: [{ enrichmentId: 'enr', status: 'pending', result: null }],
});
const rows = [item('no', ['no']), item('unclear', ['unclear']), item('yes', ['yes']), item('mixed', ['yes', 'no']), item('empty', [])];
const webset = { id: 'smoke-ws', status: 'idle', dashboardUrl: 'https://websets.exa.ai/smoke-ws', searches: [], enrichments: [] };
const recall = { expected: { total: 80, confidence: 'low', bounds: { min: 50, max: 100 } }, reasoning: 'Provider estimate' };

if (process.env.WEBSETS_SMOKE_PROVIDER === '1') {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? input);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return nativeFetch(input, options);
    assert.equal(url.origin, 'https://api.exa.ai', `Unexpected outbound request: ${url.origin}`);
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    fs.appendFileSync(process.env.WEBSETS_SMOKE_RECEIPTS, JSON.stringify({ method, path: url.pathname, body }) + '\n');
    let response;
    if (url.pathname === '/websets/v0/websets' && method === 'POST') {
      assert.ok(body.search?.query);
      if (body.search.entity?.type === 'custom') assert.deepEqual(body.search.entity, custom);
      response = webset;
    } else if (url.pathname === '/websets/v0/websets/preview' && method === 'POST') {
      assert.deepEqual(body.search.entity, custom);
      response = { ...body, enrichments: [] };
    } else if (url.pathname === '/websets/v0/imports' && method === 'POST') {
      assert.deepEqual(body.csv, { identifier: 0 });
      assert.deepEqual(body.entity, custom);
      response = { id: 'smoke-import', status: 'pending', uploadUrl: 'https://upload.example/signed', uploadValidUntil: timestamp };
    } else if (url.pathname === '/websets/v0/websets/smoke-ws/searches' && method === 'POST') {
      assert.deepEqual(body.entity, custom);
      assert.equal(body.count, 50); assert.equal(body.recall, true);
      response = { id: 'smoke-search', websetId: 'smoke-ws', count: body.count, createdAt: timestamp, updatedAt: timestamp, recall };
    } else if (url.pathname === '/websets/v0/websets/smoke-ws' && method === 'GET') {
      response = { ...webset, ...(url.searchParams.has('expand') ? { items: rows } : {}) };
    } else if (url.pathname === '/websets/v0/websets/smoke-ws/items' && method === 'GET') {
      response = url.searchParams.get('cursor') === 'page2'
        ? { data: rows.slice(2), hasMore: false, nextCursor: null }
        : { data: rows.slice(0, 2), hasMore: true, nextCursor: 'page2' };
    } else if (url.pathname === '/websets/v0/websets/smoke-ws/items/no' && method === 'GET') {
      response = rows[0];
    } else {
      throw new Error(`Unexpected mocked provider operation: ${method} ${url.pathname}`);
    }
    return Response.json(response);
  };
} else {
  await smoke();
}

async function smoke() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = fs.mkdtempSync('/app/data/correctness-smoke-');
  const receiptsFile = path.join(dir, 'provider.jsonl');
  fs.writeFileSync(receiptsFile, '');
  const receipts = () => fs.readFileSync(receiptsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const child = spawn(process.execPath, ['--import', import.meta.url, path.join(root, 'dist/index.js')], {
    cwd: root,
    env: {
      ...process.env, EXA_API_KEY: 'offline-smoke-only', PORT: '7860',
      WEBSETS_DB_PATH: path.join(dir, 'store.db'), NOTEBOOKS_DIR: path.join(dir, 'notebooks'),
      WEBSETS_SMOKE_PROVIDER: '1', WEBSETS_SMOKE_RECEIPTS: receiptsFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const client = new Client({ name: 'offline-correctness-smoke', version: '1.0.0' });
  let connected = false;
  const checks = [];
  const mark = name => { checks.push(name); console.log(`PASS ${name}`); };
  const execute = async code => {
    const response = await client.callTool({ name: 'execute', arguments: { code } });
    assert.ok(!response.isError, response.content?.[0]?.text);
    return JSON.parse(response.content[0].text).result;
  };
  const operation = (name, args) => execute(`return await callOperation(${JSON.stringify(name)}, ${JSON.stringify(args)});`);
  const expectRejected = async (name, args) => {
    const before = receipts().length;
    const response = await client.callTool({ name: 'execute', arguments: { code: `return await callOperation(${JSON.stringify(name)}, ${JSON.stringify(args)});` } });
    assert.equal(response.isError, true, response.content?.[0]?.text);
    assert.equal(receipts().length, before, 'Validation must reject before provider dispatch');
  };
  try {
    const deadline = Date.now() + 15_000;
    while (true) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
      try {
        const health = await fetch('http://127.0.0.1:7860/health');
        assert.equal((await health.json()).status, 'ok');
        break;
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:7860/mcp')));
    connected = true;
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['execute', 'search', 'status']);
    mark('production boot, HTTP health, and MCP initialize/listTools');

    const description = tools.find(tool => tool.name === 'execute').description;
    const example = description.split('Example:\n')[1].split('\nPARAMETER FORMAT RULES')[0];
    const exampleResult = await execute(example);
    assert.deepEqual(exampleResult.data.map(row => row.id), ['yes', 'mixed', 'empty']);
    const firstCreate = receipts().find(row => row.method === 'POST');
    assert.equal(firstCreate.body.search.count, 10);
    mark('published execute example and pagination through a fully filtered page');

    const discovery = await client.callTool({ name: 'search', arguments: { query: 'notebook', domain: 'notebook', detail: 'full', limit: 20 } });
    assert.ok(!discovery.isError);
    assert.ok(discovery.content[0].text.includes('retrievalBalance'));
    assert.ok(!discovery.content[0].text.includes('"type": "unknown"'));
    const resource = await client.readResource({ uri: 'workflow://thesis.investigate' });
    assert.ok(resource.contents[0].text.includes('retrievalScore'));
    const tasksBefore = await operation('tasks.list', {});
    await expectRejected('tasks.create', { type: 'thesis.investigate', args: {} });
    assert.deepEqual(await operation('tasks.list', {}), tasksBefore);
    await expectRejected('websets.create', { searchQuery: 'jobs', entity: { type: 'custom' } });
    mark('schema discovery, workflow resource, and pre-dispatch validation');

    await operation('websets.create', { searchQuery: 'jobs', searchCount: 50, entity: custom });
    await operation('websets.preview', { query: 'jobs', entity: custom });
    const search = await operation('searches.create', { websetId: 'smoke-ws', query: 'jobs', count: 50, entity: custom, recall: true });
    assert.deepEqual(search.recall, recall);
    assert.equal(search.count, 50); assert.equal(search.websetId, 'smoke-ws'); assert.equal(search.createdAt, timestamp);
    const imported = await operation('imports.create', { format: 'csv', entity: custom, count: 2, size: 50, csv: { identifier: 0 } });
    assert.equal(imported.uploadUrl, 'https://upload.example/signed'); assert.equal(imported.uploadValidUntil, timestamp);
    const expanded = await operation('websets.get', { id: 'smoke-ws', expand: ['items'] });
    assert.equal(expanded.dashboardUrl, webset.dashboardUrl); assert.deepEqual(expanded.items, rows);
    mark('custom entities across four operations, CSV receipt, recall, and raw expansion');

    for (const [evaluationPolicy, ids] of [['any', ['yes', 'mixed', 'empty']], ['all', ['yes', 'empty']], ['none', rows.map(row => row.id)]]) {
      const result = await operation('items.getAll', { websetId: 'smoke-ws', evaluationPolicy });
      assert.deepEqual(result.data.map(row => row.id), ids);
      assert.equal(result.total, 5); assert.equal(result.included, ids.length); assert.equal(result.excluded, 5 - ids.length);
      assert.equal(result.data[0].websetId, 'smoke-ws'); assert.equal(result.data[0].enrichments[0].status, 'pending');
    }
    assert.deepEqual(await operation('items.get', { websetId: 'smoke-ws', itemId: 'no' }), rows[0]);
    mark('evaluation policies, compact status/freshness, and full single-item evidence');

    await operation('notebook.create', { thesis: 'A smoke-test claim', slug: 'smoke' });
    await operation('notebook.appendRun', { slug: 'smoke', run: { verdict: 'supported', confidence: 0.6 } });
    const retrieval = { kind: 'retrieval', retrievalBalance: 'mixed', retrievalScore: 0, thesisQueryDomains: 3, antithesisQueryDomains: 3, thesisQueryShare: 0.5 };
    await operation('notebook.appendRun', { slug: 'smoke', run: retrieval });
    const notebook = await operation('notebook.get', { slug: 'smoke' });
    assert.equal(notebook.runs.length, 2); assert.equal(notebook.runs[0].verdict, 'supported');
    assert.equal(notebook.runs[1].kind, 'retrieval'); assert.ok(!('verdict' in notebook.runs[1]));
    const index = (await operation('notebook.list', {})).notebooks[0];
    assert.equal(index.latest_run_kind, 'retrieval'); assert.equal(index.latest_verdict, null); assert.equal(index.latest_confidence, null);
    mark('SQLite native module, tagged notebook history, and latest-index clearing');
    console.log(JSON.stringify({ ok: true, checks: checks.length, mockedProviderCalls: receipts().length, externalNetwork: 'disabled by docker --network none' }));
  } catch (err) {
    console.error(output);
    throw err;
  } finally {
    if (connected) await client.close().catch(() => {});
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', resolve);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
