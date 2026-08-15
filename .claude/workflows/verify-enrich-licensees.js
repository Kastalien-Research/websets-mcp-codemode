export const meta = {
  name: 'verify-enrich-licensees',
  description:
    'License-roster pipeline: 4 import-websets → wait idle → batched independent Exa verification of every webset enrichment + direct Exa enrichment of columns Websets never had → capped deep-research escalation → augmented CSV + gap report',
  whenToUse:
    'Verify and out-enrich the Websets enrichments running over the License-and-Rank CSVs. The CSV is the identity source of truth (name, license, address); Websets adds Specialization L1/L2, LinkedIn URL, Security Clearance — this workflow independently checks those via exa.search people-entities and adds current employer/title, education, and computed practice years. Pass {websetIds:[...]} (defaults to the four 2026-08-14 imports), {batchSize} (default 60), {maxDeep} (default 100 escalations), {pilotBatches} (run only N batches per webset first; 0 = all), {model}/{cheapModel}.',
  phases: [
    { title: 'Recon', detail: 'inspect real item/property shapes + enrichment columns per webset; map websets to CSV parts by sampling' },
    { title: 'Await', detail: 'script-driven waitUntilIdle poll loop per webset (imports + enrichments can take hours)' },
    { title: 'Ingest', detail: 'items.getAll ingest:true mirror to local store; window counts via store.query' },
    { title: 'Verify', detail: 'per (webset, offset) window: one code-driven exa.search evidence pass, one judge that grades webset columns + emits added columns, persisting as it goes' },
    { title: 'Escalate', detail: 'capped exa-research deep dives on flagged rows (clearance claims, identity conflicts)' },
    { title: 'Export', detail: 'script-owned verdicts CSV (cksum-verified) + deterministic python join onto the source CSVs + gap report' },
  ],
}

// --- Args --------------------------------------------------------------------
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = A ?? {}

// The four import-backed websets created 2026-08-14 over the License-and-Rank
// CSV parts. Override with {websetIds} to run against different ones.
const WEBSET_IDS = A.websetIds ?? [
  'webset_01m011xr1qqqpaftj8sf4azr4x',
  'webset_01m01227mkswxpy5rfdmkhds56',
  'webset_01m0126tyv5bfqt82gs0va28f4',
  'webset_01m0131b1z8byt1bb048wjv8sp',
]
const BATCH = Math.max(10, Math.min(A.batchSize ?? 60, 100))
const MAX_DEEP = A.maxDeep ?? 100
const PILOT = A.pilotBatches ?? 0 // 0 = no cap; N = first N windows per webset
const MODEL_REASONING = A.model ?? 'claude-sonnet-5'
const MODEL_CHEAP = A.cheapModel ?? 'claude-haiku-4-5-20251001'

const EXECUTE_TOOL =
  'the websets `execute` MCP tool (mcp__websets-codemode-local__execute — load it via ToolSearch with ' +
  '"select:mcp__websets-codemode-local__execute" if it is not already available), calling callOperation(...) inside it'

// --- Schemas -----------------------------------------------------------------
// Recon reports FACTS about live data shapes; the script threads them into
// later prompts so no downstream stage runs on guessed field names
// (verify-before-writing: the property layout of imported items is exactly the
// kind of thing that gets hallucinated).
const RECON_SCHEMA = {
  type: 'object',
  required: ['itemsColumns', 'propertyKeys', 'identityFields', 'websets'],
  properties: {
    itemsColumns: { type: 'array', items: { type: 'string' } },
    propertyKeys: { type: 'array', items: { type: 'string' } },
    // JS paths INSIDE the stored item row that yield each identity field, e.g.
    // "JSON.parse(row.properties_json).person.name" — reported from real rows.
    identityFields: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        licenseNumber: { type: 'string' },
      },
    },
    websets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['websetId', 'enrichmentColumns', 'csvPart'],
        properties: {
          websetId: { type: 'string' },
          enrichmentColumns: { type: 'array', items: { type: 'string' } },
          // Established by grepping sampled item names against the four CSVs,
          // not assumed from import counts.
          csvPart: { type: 'string' },
          sampleMatches: { type: 'number' },
        },
      },
    },
  },
}

const POLL_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: { status: { type: 'string' }, enriched: { type: 'number' } },
}

const COUNT_SCHEMA = {
  type: 'object',
  required: ['websetId', 'itemCount', 'truncated'],
  properties: {
    websetId: { type: 'string' },
    itemCount: { type: 'number' },
    truncated: { type: 'boolean' },
  },
}

// Judge output: one entry per item in the window, graded per webset column plus
// the added direct-Exa columns. `escalate` is a flag + reason, not a verdict —
// the SCRIPT decides which flagged rows actually get deep research (cap).
const JUDGE_SCHEMA = {
  type: 'object',
  required: ['websetId', 'offset', 'items'],
  properties: {
    websetId: { type: 'string' },
    offset: { type: 'number' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['itemId', 'name', 'identityConfirmed', 'columns', 'added'],
        properties: {
          itemId: { type: 'string' },
          name: { type: 'string' },
          identityConfirmed: { type: 'boolean' },
          columns: {
            type: 'array',
            items: {
              type: 'object',
              required: ['column', 'websetValue', 'verdict'],
              properties: {
                column: { type: 'string' },
                websetValue: { type: 'string' },
                exaValue: { type: 'string' },
                verdict: {
                  type: 'string',
                  enum: ['confirmed', 'corrected', 'disputed', 'unverifiable', 'filled', 'webset-empty'],
                },
              },
            },
          },
          added: {
            type: 'object',
            properties: {
              currentEmployer: { type: 'string' },
              currentTitle: { type: 'string' },
              education: { type: 'string' },
              linkedinUrl: { type: 'string' },
              location: { type: 'string' },
              yearsExperience: { type: 'string' },
            },
          },
          escalate: { type: 'boolean' },
          escalateReason: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
    persistedCount: { type: 'number' },
  },
}

const DEEP_SCHEMA = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['itemId', 'finding'],
        properties: {
          itemId: { type: 'string' },
          finding: { type: 'string' },
          clearanceVerdict: { type: 'string', enum: ['supported', 'unsupported', 'contradicted', 'n/a'] },
          persisted: { type: 'boolean' },
        },
      },
    },
  },
}

// Raw-measurement write schema (no self-graded booleans) — see
// no-self-graded-verification.md and the writePartVerified pattern in
// source-candidates.js, which this copies.
const WRITE_SCHEMA = {
  type: 'object',
  required: ['cksumCrc', 'bytes'],
  properties: { cksumCrc: { type: 'number' }, bytes: { type: 'number' } },
}

const JOIN_SCHEMA = {
  type: 'object',
  required: ['rowsIn', 'rowsOut', 'matched', 'unmatched'],
  properties: {
    rowsIn: { type: 'number' },
    rowsOut: { type: 'number' },
    matched: { type: 'number' },
    unmatched: { type: 'number' },
    outPath: { type: 'string' },
  },
}

// POSIX cksum in pure JS — identical implementation to source-candidates.js
// (validated against the cksum binary in tests/source-candidates.mock-test.cjs).
const CKSUM_TABLE = (() => {
  const t = new Array(256)
  for (let i = 0; i < 256; i++) {
    let c = (i << 24) >>> 0
    for (let j = 0; j < 8; j++) c = ((c & 0x80000000) ? ((c << 1) ^ 0x04c11db7) : (c << 1)) >>> 0
    t[i] = c
  }
  return t
})()
function cksumOf(s) {
  let crc = 0
  let n = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    const bytes =
      cp < 0x80 ? [cp]
      : cp < 0x800 ? [0xc0 | (cp >> 6), 0x80 | (cp & 63)]
      : cp < 0x10000 ? [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)]
      : [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)]
    for (const b of bytes) {
      crc = (((crc << 8) >>> 0) ^ CKSUM_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0
      n++
    }
  }
  let len = n
  while (len > 0) {
    crc = (((crc << 8) >>> 0) ^ CKSUM_TABLE[((crc >>> 24) ^ (len & 0xff)) & 0xff]) >>> 0
    len = Math.floor(len / 256)
  }
  return { crc: (~crc) >>> 0, bytes: n }
}

// --- Phase 1: Recon ----------------------------------------------------------
phase('Recon')

const recon = await agent(
  `Establish the REAL data shapes this pipeline will run on. Report only what you observe — never a guessed ` +
    `field name. All API access via ${EXECUTE_TOOL}.\n\n` +
    `Websets: ${JSON.stringify(WEBSET_IDS)}\n` +
    `Source CSVs: the four files in source-of-truth-csvs/ (header: PROFESSION,License Number,Name,...).\n\n` +
    `1. Mirror a few items so the store has rows to inspect: for EACH webset run ` +
    `callOperation('items.list', { websetId, limit: 5, ingest: true }).\n` +
    `2. callOperation('store.query', { sql: "SELECT * FROM items LIMIT 2" }) and PRAGMA table_info(items) — ` +
    `report itemsColumns (actual column names) and, from a real row, propertyKeys (top-level keys of the ` +
    `item's properties/JSON payload) and identityFields: for each of name/city/state/licenseNumber, the JS ` +
    `expression that extracts it from a store row (e.g. "JSON.parse(row.properties_json).person.name"). If a ` +
    `field simply is not present in the data, omit it.\n` +
    `3. For EACH webset: callOperation('websets.get', { websetId }) — report enrichmentColumns ` +
    `(enrichments[].description in order). Then take the 5 sampled item NAMES and, with your Bash tool, ` +
    `grep -ci each name against each of the four CSV files; csvPart = the filename with the most total hits, ` +
    `sampleMatches = that hit count. This mapping is used to join results back to the right source file, so ` +
    `report the grep numbers honestly — a 0/5 mapping is a reportable fact, not a failure to hide.\n\n` +
    `Return the RECON structure exactly.`,
  { label: 'recon', phase: 'Recon', schema: RECON_SCHEMA, model: MODEL_REASONING },
)
if (!recon || !recon.websets?.length) return { error: 'Recon failed — no shape report produced.' }
const nameExpr = recon.identityFields.name
const stateExpr = recon.identityFields.state
const licExpr = recon.identityFields.licenseNumber
log(`Recon: items columns [${recon.itemsColumns.join(', ')}]; identity via name=${nameExpr}${licExpr ? `, license=${licExpr}` : ''}`)
for (const w of recon.websets) log(`  ${w.websetId} → ${w.csvPart} (${w.sampleMatches ?? '?'} sample hits), ${w.enrichmentColumns.length} enrichment cols`)

// --- Phase 2: Await idle -----------------------------------------------------
// Same script-owned poll-loop shape as source-candidates Populate: no agent
// outlives a couple of tool calls; the SCRIPT owns the long wait.
phase('Await')
const MAX_POLLS = 200
for (const websetId of WEBSET_IDS) {
  let status = 'running'
  let polls = 0
  while (status !== 'idle' && polls < MAX_POLLS) {
    polls++
    const poll = await agent(
      `Poll #${polls} for webset ${websetId}. Make EXACTLY ONE call via ${EXECUTE_TOOL}, passing the execute ` +
        `tool's timeout parameter as 115000:\n` +
        `  callOperation('websets.waitUntilIdle', { id: '${websetId}', timeout: 100000, pollInterval: 10000 })\n` +
        `Report status ('idle' or 'running') and enriched = enrichments[].status counts if visible (else 0). ` +
        `A timeout/error just means "not idle yet" — report status 'running'. Return { status, enriched }.`,
      { label: `await:${websetId.slice(-6)}:${polls}`, phase: 'Await', schema: POLL_SCHEMA, effort: 'low', model: MODEL_CHEAP },
    )
    status = poll?.status ?? 'running'
    if (status !== 'idle' && polls % 10 === 0) log(`${websetId} still ${status} after ${polls} polls`)
  }
  log(`${websetId} ${status} after ${polls} poll(s)`)
  if (status !== 'idle') log(`Warning: ${websetId} not idle after ${polls} polls — verifying what exists so far`)
}

// --- Phase 3: Ingest ---------------------------------------------------------
phase('Ingest')
const counts = await parallel(WEBSET_IDS.map((websetId) => () =>
  agent(
    `Mirror webset ${websetId} into the local store and report its size, via ${EXECUTE_TOOL}.\n` +
      `1. callOperation('items.getAll', { websetId: '${websetId}', ingest: true, maxItems: 6000 }) — record ` +
      `the response's truncated boolean.\n` +
      `2. callOperation('store.query', { sql: "SELECT COUNT(*) AS n FROM items WHERE webset_id = ?", params: ['${websetId}'] })\n` +
      `Return { websetId: '${websetId}', itemCount: n, truncated }. Raw numbers only.`,
    { label: `ingest:${websetId.slice(-6)}`, phase: 'Ingest', schema: COUNT_SCHEMA, effort: 'low', model: MODEL_CHEAP },
  ),
))
const websetCounts = counts.filter(Boolean)
if (websetCounts.length < WEBSET_IDS.length) {
  log(`Warning: ${WEBSET_IDS.length - websetCounts.length} webset(s) failed ingest and will be skipped`)
}
for (const c of websetCounts) {
  log(`${c.websetId}: ${c.itemCount} items${c.truncated ? ' (TRUNCATED at 6000 — investigate)' : ''}`)
}
const totalItems = websetCounts.reduce((s, c) => s + c.itemCount, 0)
if (totalItems === 0) return { error: 'No items in any webset — nothing to verify.', websetCounts }

// --- Phase 4: Verify (batched windows) --------------------------------------
// Window = (websetId, offset, BATCH). Item lists never pass through the script
// or a structured output — each gather agent pulls its own window from the
// store inside ONE execute call and loops exa.search there (Code Mode: the
// loop is code, not agent turns). ORDER BY id makes windows deterministic and
// therefore resumable.
phase('Verify')

const windows = []
for (const c of websetCounts) {
  const enrichCols = recon.websets.find((w) => w.websetId === c.websetId)?.enrichmentColumns ?? []
  let nWindows = Math.ceil(c.itemCount / BATCH)
  if (PILOT > 0) nWindows = Math.min(nWindows, PILOT)
  for (let i = 0; i < nWindows; i++) {
    windows.push({ websetId: c.websetId, offset: i * BATCH, enrichCols })
  }
}
log(`${windows.length} verification window(s) of ${BATCH} across ${websetCounts.length} webset(s)${PILOT ? ` (pilot: first ${PILOT} windows per webset)` : ''}`)

const identityExtract =
  `name via ${nameExpr}` +
  (stateExpr ? `, state via ${stateExpr}` : '') +
  (licExpr ? `, licenseNumber via ${licExpr}` : '')

const judged = await pipeline(
  windows,

  // Stage A — evidence gathering: mechanical code the prompt fully specifies,
  // so it runs on the cheap model. Output is free-form JSON text for the judge.
  (w) =>
    agent(
      `Gather verification evidence for webset ${w.websetId}, window offset ${w.offset}, size ${BATCH}. ` +
        `Use ${EXECUTE_TOOL}; write ONE code block that does all of this and return its output as your final ` +
        `message (raw JSON text, no commentary):\n\n` +
        `1. const rows = await callOperation('store.query', { sql: "SELECT * FROM items WHERE webset_id = ? ` +
        `ORDER BY id LIMIT ${BATCH} OFFSET ${w.offset}", params: ['${w.websetId}'] })\n` +
        `2. For each row extract identity (${identityExtract}) and the webset's enrichment values for the ` +
        `columns ${JSON.stringify(w.enrichCols)} (from the row's enrichments/properties payload — inspect the ` +
        `row shape, the recon phase confirmed the store carries them).\n` +
        `3. For each person: const ev = await callOperation('exa.search', { query: '<name> professional ` +
        `engineer <city or state if known>', category: 'people', numResults: 2 }). From each result keep: ` +
        `url, title, entities[0].properties.location, .workHistory (company, title, from, to — current = ` +
        `to:null), .educationHistory (degree, institution), and the first 400 chars of text. Batch politely: ` +
        `if a call throws, wait ~2s and retry once; if it throws again record {error} for that person and ` +
        `continue.\n` +
        `4. Emit one JSON object: { websetId, offset, people: [{ itemId, name, state, licenseNumber, ` +
        `websetValues: {<column>: <value>}, evidence: [<kept result fields>] }] } — include EVERY row from ` +
        `step 1, even ones with no evidence.\n` +
        `Split into a few execute calls if one would exceed the 120s execute timeout (e.g. 20 people per call).`,
      { label: `gather:${w.websetId.slice(-6)}@${w.offset}`, phase: 'Verify', effort: 'low', model: MODEL_CHEAP },
    ),

  // Stage B — judge + persist. Reasoning model: identity matching and
  // specialization inference are the genuinely fuzzy calls. Persisting its own
  // verdicts is mechanical bookkeeping, not self-grading — the graded artifact
  // is the WEBSET's enrichment (a different actor), and the script separately
  // recomputes aggregate honesty checks below.
  (evidence, w) => {
    if (!evidence) return null
    return agent(
      `You are an independent verification judge for a licensed-engineer roster. Below is a window of people ` +
        `with (a) the values the Exa Webset enrichment produced ("websetValues") and (b) independent ` +
        `exa.search people-entity evidence. The state licensing CSV is ground truth for identity — never ` +
        `"correct" a name or license number.\n\n` +
        `For EACH person, grade each webset column in ${JSON.stringify(w.enrichCols)}:\n` +
        `- identityConfirmed: does the evidence profile match THIS person (name + geography + engineering ` +
        `discipline coherence)? Same-name collisions are common — when the evidence person's location and ` +
        `history don't line up, identityConfirmed=false and treat evidence as absent.\n` +
        `- verdict per column: confirmed (webset value matches evidence), corrected (evidence contradicts — ` +
        `give exaValue), disputed (evidence conflicts internally), unverifiable (no usable evidence), ` +
        `filled (webset empty but evidence provides a value — give exaValue), webset-empty (both empty).\n` +
        `- Specialization L1/L2: infer from current title + work history (e.g. "Substation Design Engineer" ` +
        `→ L1 Electrical). Grade the WEBSET's value against your inference; when the webset is plausible but ` +
        `broader/narrower than the evidence, that is confirmed, not corrected — only contradiction corrects.\n` +
        `- Security Clearance: absence of evidence for a clearance is NOT contradiction — an evidence-free ` +
        `"None" is confirmed by default; a webset claim of an ACTIVE clearance level with no supporting ` +
        `evidence is escalate-worthy, not correctable here.\n` +
        `- added: currentEmployer, currentTitle, education (highest degree + institution), linkedinUrl (the ` +
        `evidence result url when it is a profile), location, yearsExperience (compute from workHistory ` +
        `dates when possible — as a string, e.g. "23"). Omit fields with no evidence.\n` +
        `- escalate=true ONLY for: webset claims clearance above None (any identity), or identity conflicts ` +
        `on a person whose webset row carries substantive values. escalateReason one clause.\n\n` +
        `Then persist: via ${EXECUTE_TOOL}, ONE execute call that loops your items and for each calls ` +
        `callOperation('store.annotate', { itemId, type: 'verification', value: JSON.stringify({ columns, ` +
        `added, identityConfirmed, notes }), source: 'verify-enrich-licensees' }). Count successful calls ` +
        `and report it as persistedCount (raw count — if some fail, report the true number).\n\n` +
        `Return the JUDGE structure with EXACTLY one items[] entry per person in the evidence (same itemIds, ` +
        `none added, none dropped), websetId='${w.websetId}', offset=${w.offset}.\n\n` +
        `--- EVIDENCE ---\n${typeof evidence === 'string' ? evidence.slice(0, 60000) : JSON.stringify(evidence).slice(0, 60000)}`,
      { label: `judge:${w.websetId.slice(-6)}@${w.offset}`, phase: 'Verify', schema: JUDGE_SCHEMA, model: MODEL_REASONING },
    )
  },
)

const goodWindows = judged.filter(Boolean)
const failedWindows = windows.length - goodWindows.length
if (failedWindows > 0) log(`Warning: ${failedWindows}/${windows.length} window(s) produced no judgment (their items remain unverified in the store — resumable)`)

// Script-side integrity check on the judge output (deterministic, not
// self-graded): every window must return itemIds unique within itself, and
// persistedCount should equal items.length — a shortfall is logged loudly.
let allItems = []
let persistShortfall = 0
for (const wj of goodWindows) {
  const ids = new Set(wj.items.map((i) => i.itemId))
  if (ids.size !== wj.items.length) log(`Warning: duplicate itemIds in window ${wj.websetId}@${wj.offset}`)
  if ((wj.persistedCount ?? 0) < wj.items.length) persistShortfall += wj.items.length - (wj.persistedCount ?? 0)
  for (const it of wj.items) allItems.push({ ...it, websetId: wj.websetId })
}
if (persistShortfall > 0) log(`Warning: ${persistShortfall} annotation(s) reported unpersisted — export reads from script memory so rows are not lost, but the store is incomplete`)
log(`Judged ${allItems.length} people across ${goodWindows.length} window(s)`)

// --- Phase 5: Escalate (capped) ----------------------------------------------
phase('Escalate')
const flagged = allItems.filter((i) => i.escalate)
const deepTargets = flagged.slice(0, MAX_DEEP)
if (flagged.length > MAX_DEEP) log(`${flagged.length} flagged, deep-diving first ${MAX_DEEP} (maxDeep)`)
const PER_DEEP_AGENT = 5
const deepGroups = []
for (let i = 0; i < deepTargets.length; i += PER_DEEP_AGENT) deepGroups.push(deepTargets.slice(i, i + PER_DEEP_AGENT))
log(`Escalating ${deepTargets.length} of ${flagged.length} flagged item(s) in ${deepGroups.length} group(s)`)

const deepResults = (await parallel(deepGroups.map((group, gi) => () =>
  agent(
    `Deep-verify these flagged licensed engineers via ${EXECUTE_TOOL}. For each, the cheap pass could not ` +
      `resolve the question in escalateReason.\n\n` +
      group.map((t) => `- itemId ${t.itemId}: ${t.name} — ${t.escalateReason ?? 'flagged'}`).join('\n') +
      `\n\nFor each person: run callOperation('research.create', { instructions: '<a precise verification ` +
      `question about this specific person — e.g. does <name>, a PE in <state>, hold or reference an active ` +
      `security clearance; cite sources>', model: 'exa-research' }) then ` +
      `callOperation('research.pollUntilFinished', { researchId, timeoutMs: 240000 }). If research is ` +
      `unavailable or times out, fall back to callOperation('exa.search', { query, type: 'deep', ` +
      `numResults: 5 }) and reason over the results. Sequential, one person at a time.\n` +
      `Then persist each finding: callOperation('store.annotate', { itemId, type: 'deep-research', value: ` +
      `JSON.stringify({ finding, clearanceVerdict }), source: 'verify-enrich-licensees' }).\n` +
      `Return results[] with one entry per person: finding (2-3 sentences, cite what was found), ` +
      `clearanceVerdict ∈ {supported, unsupported, contradicted, n/a}, persisted (true only if the annotate ` +
      `call succeeded — report honestly).`,
    { label: `deep:${gi}`, phase: 'Escalate', schema: DEEP_SCHEMA, model: MODEL_REASONING },
  ),
))).filter(Boolean).flatMap((r) => r.results ?? [])
const deepById = new Map(deepResults.map((r) => [r.itemId, r]))
log(`Deep research finished for ${deepResults.length}/${deepTargets.length} escalated item(s)`)

// --- Phase 6: Export ---------------------------------------------------------
phase('Export')

// 6a — script-owned verdicts CSV, cksum-verified part by part. Every byte of
// this file comes from script memory, so the script knows the expected CRC.
function esc(v) {
  let s = (v === null || v === undefined) ? '' : String(v)
  s = s.replace(/\r?\n/g, ' ').trim()
  if (s.length > 400) s = s.slice(0, 397) + '...'
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
const allCols = [...new Set(goodWindows.flatMap((wj) => (recon.websets.find((w) => w.websetId === wj.websetId)?.enrichmentColumns ?? [])))]
const header = [
  'websetId', 'itemId', 'name', 'licenseNumber', 'identityConfirmed',
  ...allCols.flatMap((c) => [`${c} [webset]`, `${c} [verdict]`, `${c} [exa]`]),
  'Exa: current employer', 'Exa: current title', 'Exa: education', 'Exa: LinkedIn', 'Exa: location', 'Exa: years experience',
  'Deep-research verdict', 'Notes',
].map(esc).join(',')

function toRow(it) {
  const colByName = new Map((it.columns ?? []).map((c) => [c.column, c]))
  const deep = deepById.get(it.itemId)
  return [
    esc(it.websetId), esc(it.itemId), esc(it.name), esc(it.licenseNumber ?? ''),
    esc(it.identityConfirmed ? 'yes' : 'NO'),
    ...allCols.flatMap((c) => {
      const m = colByName.get(c)
      return m ? [esc(m.websetValue), esc(m.verdict), esc(m.exaValue ?? '')] : ['', '', '']
    }),
    esc(it.added?.currentEmployer), esc(it.added?.currentTitle), esc(it.added?.education),
    esc(it.added?.linkedinUrl), esc(it.added?.location), esc(it.added?.yearsExperience),
    esc(deep ? `${deep.clearanceVerdict}: ${deep.finding}` : ''),
    esc(it.notes),
  ].join(',')
}

const ROWS_PER_PART = 400
const partsDir = 'exports/.parts-verify-enrich'
const verdictsPath = A.outputCsv ?? 'exports/licensees-verified.csv'
const rows = allItems.map(toRow)
const parts = []
for (let i = 0; i < Math.max(1, Math.ceil(rows.length / ROWS_PER_PART)); i++) {
  parts.push({
    path: `${partsDir}/p-${String(i).padStart(3, '0')}.csv`,
    content: (i === 0 ? header + '\n' : '') + rows.slice(i * ROWS_PER_PART, (i + 1) * ROWS_PER_PART).map((r) => r + '\n').join(''),
  })
}

const MAX_WRITE_ATTEMPTS = 3
async function writePartVerified(p) {
  const expected = cksumOf(p.content)
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const r = await agent(
      `Using your Write tool, write EXACTLY the following content to "${p.path}" (relative to the project ` +
        `directory, creating parent directories as needed; overwrite if present). Preserve every line ` +
        `verbatim; the <<<PART/PART markers delimit the content and are not part of the file.\n\n<<<PART\n` +
        `${p.content}PART\n\nThen run \`cksum "${p.path}"\` with your Bash tool and report the first number ` +
        `as cksumCrc and the second as bytes — raw numbers, no interpretation.`,
      { label: `write:${p.path.split('/').pop()}${attempt > 1 ? `:retry${attempt}` : ''}`, phase: 'Export', schema: WRITE_SCHEMA, model: MODEL_CHEAP },
    )
    if (!!r && r.cksumCrc === expected.crc && r.bytes === expected.bytes) return { path: p.path, ok: true }
    log(`Write check failed for ${p.path} (attempt ${attempt}): got ${r?.cksumCrc}/${r?.bytes}, expected ${expected.crc}/${expected.bytes}`)
  }
  return { path: p.path, ok: false }
}
const partResults = await parallel(parts.map((p) => () => writePartVerified(p)))
const failedParts = partResults.filter((r) => !r.ok)
if (failedParts.length > 0) {
  return {
    error: `Verdicts CSV export failed cksum verification for ${failedParts.length}/${parts.length} parts`,
    judged: allItems.length,
    partsDir,
    failedParts: failedParts.map((r) => r.path),
  }
}

const expectedFull = cksumOf(parts.map((p) => p.content).join(''))
const assembled = await agent(
  `Assemble with your Bash tool: cat "${partsDir}"/p-*.csv > "${verdictsPath}" (glob order is correct). ` +
    `Then run \`cksum "${verdictsPath}"\` and report the two numbers as cksumCrc and bytes.`,
  { label: 'assemble', phase: 'Export', schema: WRITE_SCHEMA, effort: 'low', model: MODEL_CHEAP },
)
const verdictsCsvVerified = !!assembled && assembled.cksumCrc === expectedFull.crc && assembled.bytes === expectedFull.bytes
if (!verdictsCsvVerified) log(`Verdicts CSV assembly failed verification — parts remain in ${partsDir}`)

// 6b — deterministic join onto the source CSVs. This file mixes script-known
// verdict columns with source-CSV columns the script never saw, so full-file
// cksum verification is impossible; instead the join runs as a WRITTEN python
// script (auditable, deterministic) that reports raw row counts, and THIS
// script asserts them against the counts it already knows.
const joined = await agent(
  `Write and run a python3 join script with your Write and Bash tools.\n` +
    `Input A: "${verdictsPath}" (just-written verdicts CSV; key column licenseNumber, fallback key name ` +
    `uppercased).\nInput B: the four CSVs in source-of-truth-csvs/ (key "License Number", "Name").\n` +
    `Output: "exports/licensees-augmented.csv" = every source row (all original columns) + every verdicts ` +
    `column for the matched row (empty when unmatched). Left join on licenseNumber when both sides have it, ` +
    `else exact uppercased name; never drop or duplicate a source row.\n` +
    `The python script must print exactly four numbers labeled rowsIn (source data rows), rowsOut (output ` +
    `data rows), matched, unmatched. Report those numbers verbatim plus outPath. Do not assess success.`,
  { label: 'join', phase: 'Export', schema: JOIN_SCHEMA, model: MODEL_REASONING },
)
const joinVerified = !!joined && joined.rowsIn === joined.rowsOut && joined.matched + joined.unmatched === joined.rowsOut
if (!joinVerified) log(`Join integrity check failed: ${JSON.stringify(joined)}`)

// 6c — gap report, computed deterministically by the script (not an agent's
// impression): per column, how often the webset was right, wrong, or beaten.
const gap = {}
for (const it of allItems) {
  for (const c of it.columns ?? []) {
    const g = (gap[c.column] ??= { confirmed: 0, corrected: 0, disputed: 0, unverifiable: 0, filled: 0, 'webset-empty': 0 })
    if (g[c.verdict] !== undefined) g[c.verdict]++
  }
}
const identityFailures = allItems.filter((i) => !i.identityConfirmed).length

return {
  websets: websetCounts,
  windows: { total: windows.length, judged: goodWindows.length, failed: failedWindows },
  people: allItems.length,
  identityFailures,
  escalated: { flagged: flagged.length, deepDived: deepResults.length },
  gapAnalysis: gap,
  persistShortfall,
  verdictsCsv: { path: verdictsPath, verified: verdictsCsvVerified },
  augmentedCsv: { path: joined?.outPath ?? 'exports/licensees-augmented.csv', join: joined, verified: joinVerified },
  pilot: PILOT || undefined,
}
