// Mock harness for .claude/workflows/source-jobs.js — no agents, no Exa.
// The script's sandbox programs are executed for real against a fake
// callOperation backed by a temp SQLite file (via the sqlite3 CLI), so the
// normalize code, the dedupe/tiering SQL and the export all run end to end.
// Run from repo root:
//   node .claude/workflows/tests/source-jobs.mock-test.cjs
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const { spawnSync } = require('child_process')

const SRC = fs.readFileSync('.claude/workflows/source-jobs.js', 'utf8').replace('export const meta', 'const meta')
const AsyncFunction = async function () {}.constructor

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-jobs-'))
const DB = path.join(tmp, 'store.db')
function sqlite(args, input) {
  const r = spawnSync('sqlite3', args, { input, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`)
  return r.stdout
}
sqlite([DB], `CREATE TABLE items (id TEXT PRIMARY KEY, webset_id TEXT NOT NULL, name TEXT, url TEXT);
CREATE TABLE annotations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES items(id), type TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), source TEXT DEFAULT 'claude');`)
const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
const bind = (sql, params = []) => { let i = 0; return sql.replace(/\?/g, () => lit(params[i++])) }

// --- Fake Exa: two websets with overlapping postings ---------------------------
let ENRICH = null // filled from the dry run: [{description, key}]
const websets = {}
let websetSeq = 0
const FIXTURES = {
  fde: [
    { t: 'Forward Deployed Engineer', c: 'Acme AI', u: 'https://jobs.acme.ai/fde/', lo: '200000', hi: '260,000', y: '3', f: 'Posting explicitly welcomes former founders', fin: 'Not required' }, // A, 90
    { t: 'Forward Deployed Engineer', c: 'Lowpay Inc', u: 'https://lowpay.com/jobs/1', lo: '120000', hi: '150000', y: '2', f: 'No founder signal found', fin: 'Not required' }, // C below floor
    { t: 'Deployed Engineer', c: 'Senior Co', u: 'https://senior.co/jobs/9', lo: '220000', hi: '300000', y: '8', f: 'No founder signal found', fin: 'Not required' }, // C too senior
    { t: 'FDE, Markets', c: 'Hedge LP', u: 'https://hedge.example/fde', lo: '185', hi: '195', y: '4', f: 'Company is known to employ former founders', fin: 'Required' }, // B floor_only: 20+30+10-15 = 45
    { t: 'Forward Deployed\nEngineer II', c: 'Multi "Quote", Co', u: 'https://multi.example/careers?gh_jid=1', lo: null, hi: null, y: null, f: 'No founder signal found', fin: 'Not required' }, // B unknowns: 25
    { t: 'Other Role', c: 'Multi "Quote", Co', u: 'https://multi.example/careers?gh_jid=2', lo: '210000', hi: '240000', y: '0', f: 'No founder signal found', fin: 'Not required' }, // B (below_range yoe): 55
  ],
  'applied-ai': [
    { t: 'forward deployed engineer', c: 'ACME AI', u: 'https://boards.greenhouse.io/acme/jobs/77', lo: '200000', hi: '260000', y: '3', f: 'No founder signal found', fin: 'Not required' }, // dup of Acme by company+title (lower score → dropped)
    { t: 'Applied AI Engineer', c: 'Beta Labs', u: 'https://beta.example/jobs/ai', lo: '320000', hi: '400000', y: '5', f: 'No founder signal found', fin: 'Not required' }, // A above_range, 70
    { t: 'Applied AI Engineer (NYC)', c: 'Beta Labs', u: 'https://BETA.example/jobs/ai/', lo: '320000', hi: '400000', y: '5', f: 'No founder signal found', fin: 'Not required' }, // dup of previous by URL
  ],
}
function makeItems(websetId, shardKey) {
  const enrichIds = websets[websetId].enrichments
  return FIXTURES[shardKey].map((f, i) => {
    const val = { title: f.t, company: f.c, salaryMin: f.lo, salaryMax: f.hi, yoeMin: f.y, arrangement: 'Hybrid', sector: 'Other', financeReq: f.fin, founderSignal: f.f, founderEvidence: 'none' }
    return {
      id: `witem_${shardKey}_${i}`, name: `raw name ${i}`, url: f.u,
      enrichments: enrichIds.map((e) => ({ enrichmentId: e.id, description: null, format: 'text', result: val[e.key] == null ? null : [val[e.key]] })),
    }
  })
}
const opLog = []
async function callOperation(op, a = {}) {
  opLog.push(op)
  if (op === 'websets.get') {
    const ws = websets[a.id] ?? Object.values(websets).find((w) => w.externalId === a.id)
    if (!ws) throw new Error('not found')
    return ws
  }
  if (op === 'websets.create') {
    assert.ok(a.searchCriteria.every((c) => typeof c.description === 'string'), 'criteria are objects')
    assert.strictEqual(a.entity, undefined, 'entity is left to auto-detection')
    const id = `webset_${String(++websetSeq).padStart(4, '0')}`
    websets[id] = {
      id, status: 'running', externalId: a.externalId, exclude: a.exclude ?? [], searches: [{ progress: { found: 3 } }],
      // Shuffled order + an unrelated column: the id→key mapping must go by description.
      enrichments: [{ id: `wenrich_${id}_x`, description: 'unrelated column' },
        ...a.enrichments.map((e, i) => ({ id: `wenrich_${id}_${i}`, description: e.description, key: ENRICH.find((x) => x.description === e.description).key })).reverse()],
    }
    return websets[id]
  }
  if (op === 'websets.waitUntilIdle') { websets[a.id].status = 'idle'; return websets[a.id] }
  if (op === 'items.getAll') {
    const shardKey = Object.keys(FIXTURES).find((k) => websets[a.websetId].externalId.endsWith('-' + k))
    const items = makeItems(a.websetId, shardKey)
    sqlite([DB], items.map((it) => `INSERT OR REPLACE INTO items (id, webset_id, name, url) VALUES (${lit(it.id)}, ${lit(a.websetId)}, ${lit(it.name)}, ${lit(it.url)});`).join('\n'))
    return { data: items, total: items.length + 1, included: items.length, excluded: 1, truncated: false, ingested: items.length }
  }
  if (op === 'store.annotate') {
    sqlite([DB], `PRAGMA foreign_keys=ON; INSERT INTO annotations (item_id, type, value, source) VALUES (${lit(a.itemId)}, ${lit(a.type)}, ${lit(a.value)}, ${lit(a.source)});`)
    return { annotationId: 1 }
  }
  if (op === 'store.query') {
    assert.ok(a.sql.trim().toUpperCase().startsWith('SELECT'), 'store.query only accepts SELECT')
    const out = sqlite(['-json', DB], bind(a.sql, a.params) + ';')
    const rows = out.trim() ? JSON.parse(out) : []
    return { rows, count: rows.length }
  }
  if (op === 'exa.getContents') return { results: [{ url: a.urls[0], text: `page for ${a.urls[0]}` }] }
  throw new Error(`unmocked operation ${op}`)
}
const runSandbox = (code) => new AsyncFunction('callOperation', code)(callOperation)

// --- Workflow runner with a courier-faithful agent mock -------------------------
function extract(prompt, tag) {
  const m = new RegExp(`<<<${tag}\\n([\\s\\S]*?)\\n?${tag}(?:\\n|$)`).exec(prompt)
  return m ? m[1] : null
}
function realCksum(file) {
  const [crc, bytes] = spawnSync('cksum', [file], { encoding: 'utf8' }).stdout.trim().split(/\s+/).map(Number)
  return { crc, bytes }
}
async function runWorkflow(args, hooks = {}) {
  const calls = []
  const logs = []
  const agent = async (prompt, o = {}) => {
    const label = o.label ?? '(none)'
    calls.push(label)
    if (hooks.agent) { const r = await hooks.agent(label, prompt); if (r !== undefined) return r }
    if (label.startsWith('plan-gaps')) return { shards: hooks.planned ?? [] }
    if (label.startsWith('verify:')) {
      const rows = await runSandbox(extract(prompt, 'CODE'))
      if (rows.length === 0) return { written: 0, itemIds: [] }
      const checks = rows.map((r) => ({ itemId: r.itemId, live: !/hedge/.test(r.url), pageSalaryMin: r.listed.salaryMin, pageSalaryMax: r.listed.salaryMax, pageYoeMin: r.listed.yoeMin, note: 'multi\nline "note", ok' }))
      const writeCode = prompt.split('<<<CODE\n')[2].split('\nCODE')[0].replace(/\[\/\* FILL IN[^\]]*\]/, JSON.stringify(checks))
      return runSandbox(writeCode)
    }
    if (label.startsWith('write-sql')) {
      const file = /content to "([^"]+)"/.exec(prompt)[1]
      fs.writeFileSync(path.join(tmp, path.basename(file)), prompt.split('<<<SQL\n')[1].split('SQL\n\n')[0])
      const c = realCksum(path.join(tmp, path.basename(file)))
      return { cksumCrc: c.crc, bytes: c.bytes }
    }
    if (label.startsWith('export-csv')) {
      const sqlFile = path.join(tmp, path.basename(/< "([^"]+\.sql)"/.exec(prompt)[1]))
      const csvFile = path.join(tmp, 'out.csv')
      const r = spawnSync('sqlite3', ['-readonly', '-header', '-csv', DB], { input: fs.readFileSync(sqlFile, 'utf8'), encoding: 'utf8' })
      fs.writeFileSync(csvFile, r.stdout)
      const c = realCksum(csvFile)
      return { exitCode: r.status, lines: r.stdout.split('\n').length - 1, cksumCrc: c.crc, bytes: c.bytes, stderr: r.stderr }
    }
    return runSandbox(extract(prompt, 'CODE')) // create / poll / normalize / census couriers
  }
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t().catch((e) => { logs.push(`THROWN: ${e.stack}`); return null })))
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', SRC)
  const result = await fn(args, agent, parallel, null, () => {}, (m) => logs.push(m), { total: null })
  return { result, calls, logs }
}

;(async () => {
  // 1. Dry run: no agents, exposes the plan.
  const dry = await runWorkflow({ dryRun: true, runTag: 'mock' })
  assert.strictEqual(dry.calls.length, 0, 'dry run spawns no agents')
  assert.strictEqual(dry.result.shards.length, 10)
  assert.strictEqual(dry.result.createParams.searchCount, 100)
  assert.strictEqual(dry.result.createParams.searchCriteria.length, 4)
  assert.match(dry.result.createParams.searchCriteria[3].description, /\$180,000/)
  for (const s of Object.values(dry.result.sql)) assert.ok(s.trim().toUpperCase().startsWith('SELECT'))
  const keysLine = /const KEYS = (\{.*\});/.exec(dry.result.code.normalize)[1]
  ENRICH = Object.entries(JSON.parse(keysLine)).map(([description, key]) => ({ description, key }))
  assert.strictEqual(ENRICH.length, 10)

  // 2. Bad args are refused before any agent runs.
  assert.ok((await runWorkflow({ runTag: "x'; DROP" })).result.error)
  assert.ok((await runWorkflow({ outputCsv: 'a"b.csv' })).result.error)

  // 3. Full run: two seed shards in separate waves, planner returns nothing.
  const shards = [
    { key: 'fde', label: 'FDE', query: 'q1', roleCriterion: 'c1' },
    { key: 'applied-ai', label: 'Applied', query: 'q2', roleCriterion: 'c2' },
  ]
  const run = await runWorkflow({ runTag: 'mock', shards, waveSize: 1, target: 50, verifyTop: 3, minGain: 1 })
  const r = run.result
  const thrown = run.logs.filter((l) => l.startsWith('THROWN'))
  assert.deepStrictEqual(thrown, [], thrown.join('\n'))
  assert.strictEqual(r.error, undefined)
  assert.strictEqual(r.shards.length, 2)
  assert.deepStrictEqual(r.shards.map((s) => s.written), [6, 3])
  // Wave 2's webset excludes wave 1's.
  assert.deepStrictEqual(websets.webset_0002.exclude, [{ source: 'webset', id: 'webset_0001' }])
  assert.deepStrictEqual(websets.webset_0001.exclude, [])
  // 9 rows → 7 unique (company+title dup, URL dup).
  assert.strictEqual(r.census.rawRows, 9)
  assert.strictEqual(r.census.uniqueJobs, 7)
  assert.strictEqual(r.stopReason, 'gap planner proposed nothing new')
  assert.ok(run.calls.some((c) => c.startsWith('plan-gaps')), 'planner consulted once seeds ran out')
  assert.strictEqual(r.census.checked, 3)
  assert.strictEqual(r.census.uncheckedTop, 0)
  assert.strictEqual(r.csvWritten, true)
  assert.strictEqual(r.csvRows, 7)

  // CSV content: parse with sqlite's own CSV importer to survive quotes/commas.
  const csv = fs.readFileSync(path.join(tmp, 'out.csv'), 'utf8')
  assert.strictEqual(csv.split('\n').length - 1, 8, 'no embedded newlines: one line per row + header')
  const back = JSON.parse(sqlite(['-json', ':memory:'], `.import --csv ${path.join(tmp, 'out.csv')} t\nSELECT * FROM t ORDER BY cast(rank AS integer);`))
  const by = Object.fromEntries(back.map((x) => [x.item_id, x]))
  assert.deepStrictEqual(back.map((x) => x.item_id).slice(0, 2), ['witem_fde_0', 'witem_applied-ai_1'], 'tier A first, by score')
  assert.strictEqual(by.witem_fde_0.tier, 'A'); assert.strictEqual(by.witem_fde_0.score, '90')
  assert.strictEqual(by.witem_fde_0.salary_max, '260000', 'comma-formatted number parsed')
  assert.strictEqual(by.witem_fde_0.posting_status, 'live'); assert.strictEqual(by.witem_fde_0.pay_check, 'confirmed')
  assert.strictEqual(by['witem_applied-ai_1'].pay_fit, 'above_range'); assert.strictEqual(by['witem_applied-ai_1'].tier, 'A')
  assert.strictEqual(by.witem_fde_1.tier, 'C'); assert.strictEqual(by.witem_fde_1.pay_fit, 'below_floor')
  assert.strictEqual(by.witem_fde_2.tier, 'C'); assert.strictEqual(by.witem_fde_2.yoe_fit, 'too_senior')
  assert.strictEqual(by.witem_fde_3.salary_min, '185000', '"185" read as 185k')
  assert.strictEqual(by.witem_fde_3.score, '45')
  assert.strictEqual(by.witem_fde_4.title, 'Forward Deployed Engineer II', 'newline collapsed')
  assert.strictEqual(by.witem_fde_4.company, 'Multi "Quote", Co')
  assert.strictEqual(by.witem_fde_4.pay_fit, 'unknown'); assert.strictEqual(by.witem_fde_4.tier, 'B')
  assert.ok(by.witem_fde_5, 'same careers page, different ?gh_jid → kept as a separate job')
  assert.strictEqual(by['witem_applied-ai_0'], undefined, 'cross-board duplicate dropped')
  assert.strictEqual(by['witem_applied-ai_2'], undefined, 'URL duplicate dropped')
  // Top 3 by rank were checked: fde_0 (90), applied-ai_1 (70), then fde_5 (55).
  assert.strictEqual(by.witem_fde_5.posting_status, 'live')
  assert.strictEqual(by.witem_fde_3.posting_status, 'unchecked')

  // 4. Re-run of the same tag reuses websets (no second create) and re-normalizing does not double-count.
  const before = websetSeq
  const again = await runWorkflow({ runTag: 'mock', shards, waveSize: 2, target: 5, verifyTop: 7 })
  assert.strictEqual(websetSeq, before, 'externalId lookup reused both websets')
  assert.strictEqual(again.result.census.rawRows, 9)
  assert.strictEqual(again.result.stopReason, 'target reached')
  // verifyTop 7 covers all 5 qualified rows; the hedge posting is found closed → tier C.
  assert.strictEqual(again.result.census.uncheckedTop, 0)
  assert.strictEqual(again.result.census.tierC, 3)
  assert.strictEqual(again.result.csvRows, 7)

  // 5. A corrupted export (short CSV) is caught by the script, not waved through.
  const bad = await runWorkflow({ runTag: 'mock', shards, waveSize: 2, target: 5, verifyTop: 0 }, {
    agent: (label) => (label.startsWith('export-csv') ? { exitCode: 0, lines: 5, cksumCrc: 1, bytes: 1, stderr: '' } : undefined),
  })
  assert.strictEqual(bad.result.csvWritten, false)
  assert.strictEqual(bad.result.csvRows, null)

  // 6. A dead create does not sink the run.
  const partial = await runWorkflow({ runTag: 'mock', shards, waveSize: 2, target: 5, verifyTop: 0 }, {
    agent: (label) => (label.startsWith('create:fde') ? { error: 'boom' } : undefined),
  })
  assert.strictEqual(partial.result.shards[0].websetId, null)
  assert.strictEqual(partial.result.shards[1].written, 3)

  // 7. The queue: never more than `concurrency` shards between create and normalize.
  const three = [...shards, { key: 'third', label: 'Third', query: 'q3', roleCriterion: 'c3' }]
  FIXTURES.third = [{ t: 'Product Engineer', c: 'Gamma', u: 'https://gamma.example/pe', lo: '210000', hi: '250000', y: '3', f: 'No founder signal found', fin: 'Not required' }]
  const gauge = (state) => (label) => {
    if (label.startsWith('create:')) { state.inflight++; state.max = Math.max(state.max, state.inflight); state.order.push(label) }
    if (label.startsWith('normalize:')) state.inflight--
    return undefined
  }
  for (const c of [1, 2, 3]) {
    const st = { inflight: 0, max: 0, order: [] }
    const g = await runWorkflow({ runTag: `q${c}`, shards: three, concurrency: c, target: 500, verifyTop: 0, minGain: 0 }, { agent: gauge(st) })
    assert.strictEqual(st.max, c, `concurrency ${c}: peak in-flight shards`)
    assert.strictEqual(g.result.shards.length, 3)
    assert.strictEqual(g.result.census.rawRows, 10)
  }

  // 8. A concurrency refusal while another shard is populating: requeue, lower the ceiling, finish later.
  let refused = 0
  const lim = await runWorkflow({ runTag: 'lim', shards: three, concurrency: 3, target: 500, verifyTop: 0, minGain: 0 }, {
    agent: (label) => (label === 'create:applied-ai' && refused++ === 0
      ? { error: 'Error in websets.create: 429 Too Many Requests — concurrent search limit reached' } : undefined),
  })
  assert.deepStrictEqual(lim.result.shards.map((x) => x.shard).sort(), ['applied-ai', 'fde', 'third'])
  assert.ok(lim.result.shards.every((x) => x.websetId && x.normalized), 'refused shard still ran')
  assert.ok(lim.result.concurrency.final < 3, 'ceiling lowered after the refusal')
  assert.ok(lim.calls.includes('create:applied-ai:try2'), 'retry uses a fresh label')
  assert.strictEqual(lim.result.concurrency.backoffs, 0, 'no sleep needed while own shards are in flight')
  const limWs = Object.values(websets).find((w) => w.externalId === 'source-jobs-lim-applied-ai')
  assert.ok(limWs.exclude.length >= 1, 'requeued shard excludes what finished meanwhile')

  // 9. Refused with nothing in flight: back off (sleep courier), then retry; persistent refusal gives up cleanly.
  let n9 = 0
  const solo = await runWorkflow({ runTag: 'solo', shards: [shards[0]], concurrency: 1, target: 500, verifyTop: 0 }, {
    agent: (label) => (label.startsWith('create:fde') && n9++ < 2 ? { error: 'rate limit exceeded' } : label.startsWith('backoff:') ? { waitedSeconds: 90 } : undefined),
  })
  assert.strictEqual(solo.result.concurrency.backoffs, 2)
  assert.strictEqual(solo.result.shards[0].written, 6)
  const never = await runWorkflow({ runTag: 'never', shards: [shards[0]], concurrency: 1, maxRefusals: 2, verifyTop: 0 }, {
    agent: (label) => (label.startsWith('create:') ? { error: 'HTTP 429' } : label.startsWith('backoff:') ? { waitedSeconds: 90 } : undefined),
  })
  assert.match(never.result.shards[0].error, /limit-refused 3x/)
  assert.strictEqual(never.result.note, 'No postings collected — nothing to verify or export.')

  // 10. Out of credits: stop admitting at once, keep what finished, do not burn the shard budget.
  const broke = await runWorkflow({ runTag: 'broke', shards: three, concurrency: 1, target: 500, verifyTop: 0, minGain: 0 }, {
    agent: (label) => (label.startsWith('create:') && !label.startsWith('create:fde')
      ? { error: 'Error in websets.create: Forbidden. You have run out of credits. Please top up to create a new search.' } : undefined),
  })
  assert.match(broke.result.stopReason, /^account error/)
  assert.strictEqual(broke.result.shards.length, 1, 'failed shards are not recorded as run')
  assert.strictEqual(broke.calls.filter((c) => c.startsWith('create:')).length, 2, 'one refusal is enough')
  assert.ok(!broke.calls.some((c) => c.startsWith('plan-gaps')), 'planner not consulted')
  assert.strictEqual(broke.result.csvRows, 6, 'finished shard still exported')

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('source-jobs mock test: all assertions passed')
})().catch((e) => { console.error(e); process.exit(1) })
