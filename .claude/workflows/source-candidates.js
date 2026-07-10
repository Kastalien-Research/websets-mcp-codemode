export const meta = {
  name: 'source-candidates',
  description: 'Recruiter pipeline: role+candidate spec → Webset (100 results) → independent Exa verification of every claim → validated-candidates CSV',
  whenToUse:
    'Source candidates for a role from a job description plus a candidate spec (YOE, degree, free-form prose). Pass {role, candidate} to start fresh, or {websetId} to skip creation and verify/export an existing webset. Optional: {count} (default 100), {maxVerify}, {outputCsv}, {model} (reasoning-stage model, default claude-sonnet-5), {cheapModel} (mechanical-stage model, default claude-haiku-4-5-20251001).',
  phases: [
    { title: 'Compose', detail: 'role + candidate spec → search query, criteria (must-haves), enrichments (contact + nice-to-haves)' },
    { title: 'Populate', detail: 'websets.create → waitUntilIdle poll loop → items.getAll ingest → full item list from local store' },
    { title: 'Verify', detail: 'per candidate: independent Exa people-search verification of every criterion + enrichment claim' },
    { title: 'Persist', detail: 'store.annotate verification + judgment per candidate' },
    { title: 'Export', detail: 'build validated + rejected CSVs in-script, write files, synthesize report' },
  ],
}

// --- Args normalization (a named workflow's args can arrive as a JSON string) --
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = A ?? {}

const COUNT = A.count ?? 100
const MAX_VERIFY = A.maxVerify ?? COUNT

// outputCsv is interpolated into bash commands inside agent prompts. Quoting
// at the use sites is not enough on its own (a path containing `"` escapes a
// double-quoted string), so reject anything but a plain .csv path up front.
if (A.outputCsv && (!/^[A-Za-z0-9._/ -]+\.csv$/.test(A.outputCsv) || A.outputCsv.includes('..'))) {
  return { error: 'outputCsv must be a plain .csv path: letters, digits, dot, underscore, slash, space, hyphen only, no "..".' }
}

// Model tiering: reasoning-load-bearing stages (composing criteria, the
// skeptical verify-research pass that catches fabrication/inflation, and the
// cross-candidate report) stay on a frontier model; high-volume mechanical
// stages (polling, transcription, deterministic tool calls, file writes) run
// on a cheap model. A prior run defaulted every agent to the session's model,
// which happened to be Fable 5 for all ~220 calls — this pins the split
// explicitly so token cost doesn't silently track whatever model is active.
const MODEL_REASONING = A.model ?? 'claude-sonnet-5'
const MODEL_CHEAP = A.cheapModel ?? 'claude-haiku-4-5-20251001'

// The websets Code-Mode execute tool the agents drive. Load via ToolSearch if
// deferred; call operations with callOperation('<op>', {...}) inside it.
const EXECUTE_TOOL =
  'the websets `execute` MCP tool (mcp__websets-codemode-local__execute — load it via ToolSearch with ' +
  '"select:mcp__websets-codemode-local__execute" if it is not already available), calling callOperation(...) inside it'

// --- Schemas ----------------------------------------------------------------
const COMPOSE_SCHEMA = {
  type: 'object',
  required: ['searchQueries', 'criteria', 'enrichments'],
  properties: {
    searchQueries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 },
    criteria: { type: 'array', items: { type: 'string' } },
    enrichments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['description'],
        properties: {
          description: { type: 'string' },
          format: { type: 'string', enum: ['text', 'number', 'date', 'email', 'phone', 'url', 'options'] },
        },
      },
    },
  },
}

const CREATE_SCHEMA = {
  type: 'object',
  required: ['websetId'],
  properties: {
    websetId: { type: 'string' },
    searchesCreated: { type: 'number' },
  },
}

const POLL_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string' },
    found: { type: 'number' },
  },
}

const COLLECT_SCHEMA = {
  type: 'object',
  required: ['websetId', 'criteria', 'enrichmentColumns', 'items', 'truncated'],
  properties: {
    websetId: { type: 'string' },
    criteria: { type: 'array', items: { type: 'string' } },
    enrichmentColumns: { type: 'array', items: { type: 'string' } },
    truncated: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['itemId', 'name'],
        properties: {
          itemId: { type: 'string' },
          name: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['itemId', 'name', 'identityConfirmed', 'criteria', 'enrichments', 'include', 'confidence', 'notes'],
  properties: {
    itemId: { type: 'string' },
    name: { type: 'string' },
    url: { type: 'string' },
    identityConfirmed: { type: 'boolean' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'criterion', 'verdict'],
        properties: {
          index: { type: 'number' },
          criterion: { type: 'string' },
          verdict: { type: 'string', enum: ['Match', 'Miss', 'Unclear'] },
          websetSaid: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    enrichments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'description', 'verdict'],
        properties: {
          index: { type: 'number' },
          description: { type: 'string' },
          originalValue: { type: 'string' },
          verifiedValue: { type: 'string' },
          verdict: { type: 'string', enum: ['confirmed', 'corrected', 'disputed', 'unverifiable'] },
        },
      },
    },
    include: { type: 'boolean' },
    confidence: { type: 'number' },
    notes: { type: 'string' },
  },
}

const MARK_SCHEMA = {
  type: 'object',
  required: ['itemId', 'marked'],
  properties: { itemId: { type: 'string' }, marked: { type: 'boolean' } },
}

// Deliberately does NOT include a self-graded "written: true" boolean. Agents
// self-report raw measurements only; the script (not the agent) decides
// pass/fail by comparing them to the expected values it already computed —
// an LLM can misjudge or misreport its own success, but plain JS comparing
// two numbers can't be talked into a false positive. The measurement is a
// POSIX cksum CRC + byte count (not a line count): a line count passes any
// same-length substitution, while any content change at all flips the CRC.
const WRITE_SCHEMA = {
  type: 'object',
  required: ['cksumCrc', 'bytes'],
  properties: {
    cksumCrc: { type: 'number' },
    bytes: { type: 'number' },
  },
}

const ASSEMBLE_SCHEMA = {
  type: 'object',
  required: ['csvCrc', 'csvBytes', 'rejectedCrc', 'rejectedBytes'],
  properties: {
    csvCrc: { type: 'number' },
    csvBytes: { type: 'number' },
    rejectedCrc: { type: 'number' },
    rejectedBytes: { type: 'number' },
  },
}

// POSIX cksum (CRC-32, poly 0x04C11DB7, MSB-first, length appended, final
// complement) over the UTF-8 bytes of a string, in pure JS — this sandbox has
// no crypto or TextEncoder, and cksum is the strongest digest both this
// script and a stock shell can compute independently. The implementation is
// validated byte-for-byte against the real cksum binary in
// tests/source-candidates.mock-test.cjs.
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

// --- Phase 1: Compose (skipped when resuming an existing webset) -------------
let websetId = A.websetId ?? null
let composed = null

if (!websetId) {
  if (!A.role || !A.candidate) {
    return { error: 'Pass {role, candidate} to create a new webset, or {websetId} to resume an existing one.' }
  }
  phase('Compose')
  composed = await agent(
    `You are helping a recruiter source candidates. Translate the inputs below into an Exa Websets ` +
      `people-search definition. Do NOT call any tools — this is pure composition.\n\n` +
      `--- JOB DESCRIPTION ---\n${A.role}\n\n--- IDEAL CANDIDATE ---\n${A.candidate}\n\n` +
      `Produce:\n` +
      `1. searchQueries — 2 to 4 DIFFERENT dense natural-language sentences, each describing the person to ` +
      `find from a different angle (e.g. by research specialty, by tool/framework ecosystem, by publication ` +
      `profile, by adjacent role framing). All queries run against the same criteria on one webset; diverse ` +
      `angles multiply the candidate pool, so do not write four paraphrases of one sentence.\n` +
      `2. criteria — the MUST-HAVE requirements, each a single objective, independently checkable statement ` +
      `about the person. Every item is evaluated per candidate as Match/Unclear/Miss and ALL must hold, so ` +
      `each added criterion multiplies down the yield: default to 3-4 BROAD criteria (sourcing favors recall — ` +
      `a downstream verification stage independently grades niche fit per candidate anyway), and demote narrow ` +
      `specialty requirements and prestige tiers (specific sub-technique, venue rank, license currency) into ` +
      `enrichment columns UNLESS the candidate description demands strict precision. Do not put nice-to-haves ` +
      `here. Anything the search intent depends on MUST appear as a criterion or an enrichment, never only as ` +
      `a phrase in a query: the search silently optimizes around requirements (location especially) that are ` +
      `not explicitly evaluated. If the role specifies a location, make it a criterion — UNLESS the candidate ` +
      `description explicitly says to treat location as informational only, in which case record it as an ` +
      `enrichment instead. Phrase what you do keep as criteria in terms of checkable evidence (named work ` +
      `product, CURRENT/active license status — not a mention).\n` +
      `3. enrichments — informational columns. ALWAYS include: email address (format "email"), phone number ` +
      `(format "phone"), LinkedIn or professional profile URL (format "url"), current job title (text), ` +
      `current employer (text), location/city and state (text), years of professional experience (number), ` +
      `degree(s) and institution(s) (text). Add one enrichment for EACH niche requirement you demoted from ` +
      `criteria, plus role-specific nice-to-haves from the candidate description (certifications, domain ` +
      `experience, etc.), each phrased as a "find X for this person" description.`,
    { label: 'compose', phase: 'Compose', schema: COMPOSE_SCHEMA, model: MODEL_REASONING },
  )
  if (!composed) return { error: 'Compose stage failed — no search definition produced.' }
  log(`Composed ${composed.searchQueries.length} query angle(s), ${composed.criteria.length} criteria, ${composed.enrichments.length} enrichments — first angle: "${composed.searchQueries[0].slice(0, 90)}…"`)
}

// --- Phase 2: Populate --------------------------------------------------------
phase('Populate')

if (!websetId) {
  // 2a — create only. The long population wait is script-driven (below): one
  // marathon polling agent reliably trips the harness's no-progress stall
  // detector (~2h populations killed a run on 2026-07-10), so no agent here is
  // allowed to outlive a couple of tool calls.
  const created = await agent(
    `Create an Exa Webset using ${EXECUTE_TOOL}. Create it — do NOT wait for it to populate.\n\n` +
      `1. Create it (PARAMETER FORMAT RULES: entity is an object, criteria/enrichments are arrays of objects):\n` +
      `   callOperation('websets.create', {\n` +
      `     title: ${JSON.stringify('source-candidates: ' + String(A.role).slice(0, 60))},\n` +
      `     searchQuery: ${JSON.stringify(composed.searchQueries[0])},\n` +
      `     searchCount: ${COUNT},\n` +
      `     entity: { type: 'person' },\n` +
      `     searchCriteria: ${JSON.stringify(composed.criteria.map((d) => ({ description: d })))},\n` +
      `     enrichments: ${JSON.stringify(composed.enrichments)}\n` +
      `   })\n` +
      `   Record the returned webset id.\n\n` +
      (composed.searchQueries.length > 1
        ? `1b. Add the remaining query angles as ADDITIONAL searches on the same webset — one call per query, ` +
          `all with behavior 'append' (never 'override' — it would discard prior results) and the SAME criteria:\n` +
          composed.searchQueries.slice(1).map((q) =>
            `   callOperation('searches.create', { websetId: '<websetId>', query: ${JSON.stringify(q)}, count: ${COUNT}, ` +
            `entity: { type: 'person' }, criteria: ${JSON.stringify(composed.criteria.map((d) => ({ description: d })))}, behavior: 'append' })\n`,
          ).join('') +
          `\n`
        : '') +
      `Then STOP — do not poll, do not wait. Return { websetId, searchesCreated: <total number of searches on ` +
      `the webset> }.`,
    { label: 'create', phase: 'Populate', schema: CREATE_SCHEMA, effort: 'low', model: MODEL_CHEAP },
  )
  if (!created || !created.websetId) return { error: 'Webset creation failed.', detail: created }
  websetId = created.websetId
  log(`Webset ${websetId} created with ${created.searchesCreated ?? composed.searchQueries.length} search(es) — waiting for population`)

  // 2b — script-driven wait: each poll is a fresh, single-purpose agent making
  // one waitUntilIdle call that blocks ~100s server-side. Population of several
  // 100-count searches can take 2h+, so the ceiling is generous.
  const MAX_POLLS = 150
  let status = 'running'
  let polls = 0
  let lastFound = 0
  while (status !== 'idle' && polls < MAX_POLLS) {
    polls++
    const poll = await agent(
      `Poll #${polls}. Make EXACTLY ONE call via ${EXECUTE_TOOL}, passing the execute tool's timeout parameter ` +
        `as 115000:\n` +
        `  callOperation('websets.waitUntilIdle', { id: '${websetId}', timeout: 100000, pollInterval: 5000 })\n` +
        `If it returns the webset, report its status ('idle' or 'running') and found = the SUM of ` +
        `searches[].progress.found. If the call errors or times out, that just means "not idle yet" — report ` +
        `status 'running' and found 0. Do not call anything else. Return { status, found }.`,
      { label: `poll:${polls}`, phase: 'Populate', schema: POLL_SCHEMA, effort: 'low', model: MODEL_CHEAP },
    )
    status = poll?.status ?? 'running'
    if (poll?.found) lastFound = poll.found
    if (status !== 'idle' && polls % 5 === 0) log(`Population poll ${polls}/${MAX_POLLS}: status=${status}, found≈${lastFound}`)
  }
  log(`Webset ${websetId} ${status} after ${polls} poll(s) — ~${lastFound} candidates found`)
  if (status !== 'idle') log(`Warning: webset still not idle after ${polls} polls — collecting what exists so far`)
}

// Collect the FULL item set. items.getAll's response drops items whose built-in
// evaluations all failed, so mirror everything into the local store (ingest:true)
// and read the complete set back via store.query — failed-eval items still get
// verified and land in the rejected CSV with reasons instead of silently vanishing.
const collected = await agent(
  `Collect every item of webset "${websetId}" plus its column definitions, using ${EXECUTE_TOOL}.\n\n` +
    `1. callOperation('items.getAll', { websetId: '${websetId}', ingest: true, maxItems: ${COUNT * 5} }) — ` +
    `ingest:true mirrors EVERY raw item into the local store. Ignore the returned list (it is only the ` +
    `passing subset), but record the response's \`truncated\` boolean — it means the webset holds more items ` +
    `than maxItems and ingestion stopped early.\n` +
    `2. callOperation('websets.get', { websetId: '${websetId}' }) — collect the enrichment descriptions ` +
    `(enrichments[].description, in order) and the search criteria descriptions.\n` +
    `3. callOperation('store.query', { sql: "SELECT id, name, url FROM items WHERE webset_id = ?", params: ['${websetId}'] }) ` +
    `— this is the complete set including items whose evaluations failed.\n\n` +
    `Return websetId, truncated (the boolean from step 1), criteria (array of criterion description strings — ` +
    `if the webset object does not expose them, take the distinct evaluation criterion strings from one item's ` +
    `evaluations via items.list), enrichmentColumns (array of enrichment description strings), and items as ` +
    `[{itemId, name, url}] for every row store.query returned. Do not fabricate or drop any.`,
  { label: 'collect', phase: 'Populate', schema: COLLECT_SCHEMA, model: MODEL_REASONING },
)
if (!collected || !Array.isArray(collected.items)) return { error: 'Item collection failed.', websetId }
if (collected.truncated) {
  log(`Warning: items.getAll hit its maxItems cap (${COUNT * 5}) — the webset holds more items than were ingested; candidates beyond the cap are not in this run`)
}

// Dedupe by person — the same entity often appears 2-3× as separate witem_ ids.
const seen = new Set()
const candidates = []
for (const it of collected.items) {
  const key = (it.url || it.name || it.itemId).toLowerCase().replace(/\/+$/, '')
  if (seen.has(key)) continue
  seen.add(key)
  candidates.push(it)
}
const dropped = collected.items.length - candidates.length
const toVerify = candidates.slice(0, MAX_VERIFY)
if (candidates.length > MAX_VERIFY) log(`Capping verification at ${MAX_VERIFY} of ${candidates.length} candidates (maxVerify)`)
log(`Collected ${collected.items.length} items → ${candidates.length} unique candidates${dropped ? ` (${dropped} duplicates merged)` : ''}; verifying ${toVerify.length}`)
if (toVerify.length === 0) {
  return {
    websetId,
    found: collected.items.length,
    uniqueCandidates: candidates.length,
    verified: 0,
    note: 'No candidates to verify (webset produced no items, or maxVerify is 0).',
  }
}

// Canonical column definitions — the emit stage maps verdicts onto these by
// index, so CSV cells can't be lost to an agent rephrasing a criterion.
// websets.get does not reliably expose search criteria, so prefer what this
// run composed itself (that IS what websets.create was given); on a
// {websetId} resume there is no composed spec, and an empty criteria list
// would silently drop every must-have column from the CSV — treat it as fatal.
const criteriaCols = (collected.criteria?.length ? collected.criteria : composed?.criteria) ?? []
const enrichCols =
  (collected.enrichmentColumns?.length
    ? collected.enrichmentColumns
    : composed?.enrichments?.map((e) => e.description)) ?? []
if (criteriaCols.length === 0) {
  return {
    error: 'No criteria recovered (websets.get omitted them and the collect fallback returned none) — aborting rather than exporting a CSV with no criterion columns.',
    websetId,
  }
}
if (enrichCols.length === 0) log('Warning: no enrichment columns recovered — CSV will carry criteria and notes only')
const canonicalLists =
  `CANONICAL CRITERIA (report one entry per line, index = the number shown, criterion = the text VERBATIM):\n` +
  criteriaCols.map((c, i) => `${i}. ${c}`).join('\n') +
  `\n\nCANONICAL ENRICHMENT COLUMNS (same rule: index + description verbatim):\n` +
  enrichCols.map((e, i) => `${i}. ${e}`).join('\n')

// --- Phases 3+4: Verify → emit verdict → persist, pipelined per candidate ------
// Research and structured emission are separate stages on purpose: a research-busy
// agent reliably fails to call StructuredOutput, while a no-tools summarizer never
// does (lesson inherited from sweep-webset).
// Wrapped in a function so candidates whose chain died (null from research or
// verdict emission) can be re-run once with fresh agents; retry labels differ
// so a resumed run's cache cannot replay the original failure.
const runVerification = (items, retryTag = '') => pipeline(
  items,

  // Stage A — independent verification research (free-form prose, no schema).
  (item) =>
    agent(
      `You are an independent verification judge for a recruiting pipeline. Candidate: "${item.name}" ` +
        `(item "${item.itemId}", webset "${websetId}"${item.url ? `, profile ${item.url}` : ''}).\n\n` +
        `All data access goes through ${EXECUTE_TOOL}.\n\n` +
        `1. Fetch the claims: callOperation('items.get', { websetId: '${websetId}', itemId: '${item.itemId}' }). ` +
        `The evaluations array holds the criterion claims (criterion + the webset's own satisfied value); the ` +
        `enrichments array holds informational claims keyed by enrichmentId — map ids to descriptions via ` +
        `callOperation('websets.get', { websetId: '${websetId}' }).\n` +
        `2. Establish identity: callOperation('exa.search', { query: '<name> <current employer/title>', ` +
        `category: 'people', numResults: 3 }). Results carry structured entities[].properties with full ` +
        `workHistory (dates + companies), educationHistory (degrees + institutions), and location — plus the ` +
        `profile text (licenses, certifications). Confirm you found the SAME person (name + employer + school ` +
        `must line up) before trusting anything.\n` +
        `3. Verify EVERY claim independently:\n` +
        `   - Years of experience: COMPUTE from workHistory dates; do not accept the enrichment number. Note ` +
        `whether the criterion means total working years or years in the relevant discipline.\n` +
        `   - Degrees: check educationHistory (degree names, institutions, dates).\n` +
        `   - Current title/employer/location: workHistory entry with to:null and the profile location.\n` +
        `   - Licenses/certifications (PE etc.): the profile text plus a targeted general exa.search ` +
        `(e.g. state license lookups, NCEES). Deep search when needed: callOperation('exa.search', { query, ` +
        `type: 'deep', numResults: 5 }).\n` +
        `   - Contact info (email/phone): verify plausibility (domain matches employer, format), mark ` +
        `unverifiable if no independent source exists.\n` +
        `   - Source URL: callOperation('exa.getContents', { urls: ['${item.url || '<item url>'}'] }) to ` +
        `confirm it is live and describes this person.\n` +
        `4. DO NOT trust the webset's own evaluations — they pass obviously wrong candidates in practice. ` +
        `Explicitly screen for the deception patterns catalogued in the /verify-item skill (empirically ` +
        `validated on prior 100+ candidate runs) — check for EACH of these, not just "does a source exist":\n` +
        `   - Liked/reposted content laundered into authorship: confirm the actual byline/commit history names ` +
        `THIS person before crediting a paper, repo, or achievement — a mention on their activity feed is not ` +
        `evidence they made it.\n` +
        `   - Circular self-report: the candidate's own About-section restating a claim is not independent ` +
        `corroboration — it means Unclear/unverifiable, not Match/confirmed.\n` +
        `   - Name-collision misattribution: a credential may belong to a different same-named person — cross-` +
        `check employer, institution, AND timeframe together before crediting it.\n` +
        `   - Tier/magnitude inflation: compute experience from dates rather than accepting a claimed total ` +
        `(padding with school years is common); check whether a "top venue" claim is actually a preprint, ` +
        `workshop paper, or minor-contributor credit; check whether an "OSS contribution" is a zero-commit fork.\n` +
        `   - Fabricated identifiers: a specific-looking arXiv ID, repo name, or degree can be invented — ` +
        `resolve it and confirm it actually points to this person's claimed work, don't accept specificity as ` +
        `proof.\n\n` +
        `Write your findings as prose: per criterion your verdict (Match/Miss/Unclear) with evidence, per ` +
        `enrichment whether the value is confirmed/corrected (give the corrected value)/disputed/unverifiable, ` +
        `whether identity was confirmed, and an overall recommendation. Be skeptical — missing corroboration ` +
        `means Unclear, not Match.`,
      { label: `verify:${item.name}${retryTag}`, phase: 'Verify', model: MODEL_REASONING },
    ),

  // Stage B — convert prose into the structured verdict (no tools, no research).
  (writeup, item) => {
    if (!writeup) return null
    return agent(
      `Convert the verification writeup below into a structured verdict for candidate "${item.name}" ` +
        `(itemId "${item.itemId}"). Do NOT do further research — only transcribe what is present.\n` +
        `Set itemId="${item.itemId}", name="${item.name}"${item.url ? `, url="${item.url}"` : ''}.\n\n` +
        `${canonicalLists}\n\n` +
        `criteria: EXACTLY one entry per canonical criterion above, with its index number, the criterion text ` +
        `copied verbatim, verdict ∈ {Match, Miss, Unclear} (your INDEPENDENT verdict, not the webset's), ` +
        `websetSaid = ONLY the webset's own satisfied value for that criterion (Match/Miss/Unclear — no ` +
        `commentary), and evidence = one short clause. If the writeup does not cover a criterion, verdict is ` +
        `Unclear. enrichments: EXACTLY one entry per canonical enrichment column, with its index, description ` +
        `verbatim, originalValue, verifiedValue (corrected value if corrected, else the confirmed value), and ` +
        `verdict ∈ {confirmed, corrected, disputed, unverifiable}. include = identity confirmed AND no ` +
        `criterion is Miss. confidence ∈ [0,1] — low when identity or key claims lack corroboration. notes = ` +
        `one or two sentences a recruiter would want (discrepancies, standout signals).\n\n` +
        `--- WRITEUP ---\n${writeup}`,
      { label: `verdict:${item.name}${retryTag}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'low', model: MODEL_CHEAP },
    ).then((v) => {
      if (!v) return null
      // include is recomputed here deterministically — the transcription
      // agent's own include boolean is advisory only (an agent asserting a
      // conclusion about its own output is the no-self-graded-verification
      // failure mode; the inputs to the rule sit right next to it in the same
      // object). Policy: identity confirmed AND no must-have criterion is
      // Miss. Unclear deliberately does NOT reject — sourcing favors recall,
      // Unclear means "no independent corroboration found", not "disproven",
      // and every criterion verdict is a visible per-candidate CSV column.
      const include = !!v.identityConfirmed && !(v.criteria ?? []).some((c) => c.verdict === 'Miss')
      return { ...v, include }
    })
  },

  // Stage C — persist to the local store (deterministic, isolated so a research-busy
  // agent can't strand a candidate without a judgment).
  (verdict, item) => {
    if (!verdict) return null
    const judgment = JSON.stringify({
      verdict: verdict.include ? 'validated' : 'rejected',
      confidence: verdict.confidence,
      identityConfirmed: verdict.identityConfirmed,
    })
    return agent(
      `Make EXACTLY TWO tool calls and nothing else, both via ${EXECUTE_TOOL} (one execute call containing both operations is fine):\n` +
        `  callOperation('store.annotate', { itemId: '${item.itemId}', type: 'verification', value: ${JSON.stringify(JSON.stringify({ criteria: verdict.criteria, enrichments: verdict.enrichments, notes: verdict.notes }))}, source: 'source-candidates' })\n` +
        `  callOperation('store.annotate', { itemId: '${item.itemId}', type: 'judgment', value: ${JSON.stringify(judgment)}, source: 'source-candidates' })\n` +
        `If annotate fails with a missing-item error, first mirror it: callOperation('store.syncItem', { id: '${item.itemId}', websetId: '${websetId}', name: ${JSON.stringify(item.name)} }) and retry. ` +
        `Return { itemId: '${item.itemId}', marked: true }.`,
      { label: `persist:${item.name}${retryTag}`, phase: 'Persist', schema: MARK_SCHEMA, effort: 'low', model: MODEL_CHEAP },
    ).then((m) => ({ ...verdict, marked: !!(m && m.marked) }))
  },
)

let verdicts = (await runVerification(toVerify)).filter(Boolean)

// A dropped candidate (research or verdict stage died → null) must not just
// vanish from both CSVs: retry the drops once with fresh agents, then surface
// anything still missing in the return value instead of silently omitting it.
const firstPassIds = new Set(verdicts.map((v) => v.itemId))
const droppedFirstPass = toVerify.filter((it) => !firstPassIds.has(it.itemId))
if (droppedFirstPass.length > 0) {
  log(`${droppedFirstPass.length} candidate(s) produced no verdict — retrying once with fresh agents`)
  verdicts = verdicts.concat((await runVerification(droppedFirstPass, ':retry')).filter(Boolean))
}
const verdictIds = new Set(verdicts.map((v) => v.itemId))
const unverified = toVerify
  .filter((it) => !verdictIds.has(it.itemId))
  .map(({ itemId, name }) => ({ itemId, name }))
if (unverified.length > 0) {
  log(`Warning: ${unverified.length} candidate(s) still unverified after retry (in neither CSV): ${unverified.map((u) => u.name).join(', ')}`)
}

const validated = verdicts.filter((v) => v.include)
const rejected = verdicts.filter((v) => !v.include)
log(`Verified ${verdicts.length}/${toVerify.length}: ${validated.length} validated, ${rejected.length} rejected`)

// --- Phase 5: Export (barrier — the CSV genuinely needs every row) ------------
phase('Export')

function esc(v) {
  let s = (v === null || v === undefined) ? '' : String(v)
  s = s.replace(/\r?\n/g, ' ').trim()
  if (s.length > 500) s = s.slice(0, 497) + '...'
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
function pick(list, idx, text, keyField) {
  if (!Array.isArray(list)) return null
  const byIdx = list.find((e) => e.index === idx)
  if (byIdx) return byIdx
  const t = (text ?? '').toLowerCase()
  return list.find((e) => (e[keyField] ?? '').toLowerCase() === t)
    ?? list.find((e) => (e[keyField] ?? '').toLowerCase().includes(t.slice(0, 40)))
    ?? null
}
// The webset's satisfied values arrive as yes/no/unclear; verdicts as Match/Miss/Unclear.
const VERDICT_NORM = { yes: 'match', no: 'miss', match: 'match', miss: 'miss', unclear: 'unclear' }
function toRow(v, withReason) {
  const cells = [esc(v.name), esc(v.url), esc(v.identityConfirmed ? 'yes' : 'NO'), esc(v.confidence)]
  criteriaCols.forEach((c, i) => {
    const m = pick(v.criteria, i, c, 'criterion')
    if (!m) return cells.push('')
    const w = VERDICT_NORM[String(m.websetSaid ?? '').toLowerCase()]
    const disagree = w && w !== m.verdict.toLowerCase()
    cells.push(esc(m.verdict + (disagree ? ` (webset said: ${m.websetSaid})` : '')))
  })
  enrichCols.forEach((e, i) => {
    const m = pick(v.enrichments, i, e, 'description')
    cells.push(esc(m ? (m.verifiedValue ?? m.originalValue ?? '') + (m.verdict === 'confirmed' ? '' : ` [${m.verdict}]`) : ''))
  })
  cells.push(esc(v.notes))
  if (withReason) {
    const misses = (v.criteria ?? []).filter((c) => c.verdict === 'Miss').map((c) => c.criterion)
    cells.push(esc(!v.identityConfirmed ? 'identity not confirmed' : misses.join('; ') || 'low confidence'))
  }
  return cells.join(',')
}

const header = ['Name', 'Profile URL', 'Identity confirmed', 'Confidence',
  ...criteriaCols.map((c) => `Criterion: ${c}`), ...enrichCols, 'Notes']

const csvPath = A.outputCsv ?? `exports/candidates-${websetId}.csv`
const rejectedPath = csvPath.replace(/\.csv$/, '') + '-rejected.csv'

// Chunked export: no single agent prompt carries the whole file. Part-writers
// each get ≤ CSV_BATCH rows (written in parallel), then one agent concatenates
// the parts in lexicographic order.
const CSV_BATCH = 20
const partsDir = `exports/.parts-${websetId}`
function toParts(prefix, headerLine, rows) {
  const batches = []
  for (let i = 0; i < rows.length; i += CSV_BATCH) batches.push(rows.slice(i, i + CSV_BATCH))
  if (batches.length === 0) batches.push([])
  return batches.map((batch, i) => ({
    path: `${partsDir}/${prefix}-${String(i).padStart(3, '0')}.csv`,
    content: (i === 0 ? headerLine + '\n' : '') + batch.map((r) => r + '\n').join(''),
  }))
}
const headerLine = header.map(esc).join(',')
const rejHeaderLine = [...header, 'Rejection reason'].map(esc).join(',')
const vParts = toParts('v', headerLine, validated.map((v) => toRow(v, false)))
const rParts = toParts('r', rejHeaderLine, rejected.map((v) => toRow(v, true)))
const parts = [...vParts, ...rParts]

// A dry run of this pipeline (2026-07-10) had a write agent silently replace
// 4/100 candidate rows with a stray "</content>" line — same expected
// row/line count, corrupted content, invisible to a naive count check. The
// agent's own self-graded "written: true" is NOT trusted as the pass/fail
// signal (an unreliable transcriber is not a reliable self-grader either).
// Agents report raw measurements only; THIS SCRIPT compares them to the
// expected values and drives a bounded retry with a fresh agent call per
// failing part — the same script-owns-the-loop pattern as the Populate poll
// loop above, for the same reason (don't let one agent self-manage a
// checkable multi-step process).
const MAX_WRITE_ATTEMPTS = 3

async function writePartVerified(p) {
  const expected = cksumOf(p.content)
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const r = await agent(
      `Using your Write tool, write EXACTLY the following content to "${p.path}" (relative to the current ` +
        `project directory, creating parent directories as needed; overwrite if it already exists). Do not ` +
        `reformat, reorder, or summarize — preserve every line verbatim. The <<<PART/PART markers delimit the ` +
        `content and are not part of the file.\n\n<<<PART\n${p.content}PART\n\n` +
        `Then, with your Bash tool, run \`cksum "${p.path}"\`. Report the first number it printed as cksumCrc ` +
        `and the second as bytes — do not interpret, round, or editorialize about whether they look right, ` +
        `just report the raw numbers.`,
      { label: `write:${p.path.split('/').pop()}${attempt > 1 ? `:retry${attempt}` : ''}`, phase: 'Export', schema: WRITE_SCHEMA, model: MODEL_REASONING },
    )
    const ok = !!r && r.cksumCrc === expected.crc && r.bytes === expected.bytes
    if (ok) return { path: p.path, ok: true, attempts: attempt }
    log(`Write check failed for ${p.path} (attempt ${attempt}/${MAX_WRITE_ATTEMPTS}): got crc=${r?.cksumCrc}, bytes=${r?.bytes}, expected crc=${expected.crc}, bytes=${expected.bytes}`)
  }
  return { path: p.path, ok: false, attempts: MAX_WRITE_ATTEMPTS }
}

const partResults = await parallel(parts.map((p) => () => writePartVerified(p)))
const failedParts = partResults.filter((r) => !r.ok)
if (failedParts.length > 0) {
  // The export is the deliverable — do not return real-looking csv paths over
  // stale or partial files. Verification work is already persisted in the
  // store, so a resume of this run only redoes the export.
  return {
    error: `CSV export failed verification: ${parts.length - failedParts.length}/${parts.length} parts passed after ${MAX_WRITE_ATTEMPTS} attempts each`,
    websetId,
    verified: verdicts.length,
    validated: validated.length,
    rejected: rejected.length,
    persisted: verdicts.filter((v) => v.marked).length,
    partsDir,
    failedParts: failedParts.map((r) => r.path),
  }
}

const [assembled, report] = await parallel([
  () => {
    return agent(
      `Assemble the final CSVs from part files using your Bash tool. Run exactly:\n` +
        `  cat "${partsDir}"/v-*.csv > "${csvPath}"\n` +
        `  cat "${partsDir}"/r-*.csv > "${rejectedPath}"\n` +
        `(shell glob order is lexicographic, which is the correct part order). Then run ` +
        `\`cksum "${csvPath}" "${rejectedPath}"\`. Report ${csvPath}'s line as csvCrc (first number) and ` +
        `csvBytes (second number), and ${rejectedPath}'s line as rejectedCrc and rejectedBytes — raw ` +
        `numbers only, no interpretation. Then remove the parts directory with \`trash "${partsDir}"\` if the trash ` +
        `command exists — otherwise leave it in place; do NOT use rm -rf.`,
      { label: 'assemble-csv', phase: 'Export', schema: ASSEMBLE_SCHEMA, model: MODEL_REASONING },
    )
  },
  () =>
    agent(
      `Write a concise sourcing report for a recruiter. Webset ${websetId}: ${verdicts.length} candidates ` +
        `verified, ${validated.length} validated, ${rejected.length} rejected. For the validated group, rank the ` +
        `top candidates by confidence and note anything a recruiter should double-check. Call out patterns in the ` +
        `rejections (which claims the webset most often got wrong — that is feedback for tightening future ` +
        `criteria). Verdicts:\n\n` +
        JSON.stringify(verdicts.map((v) => ({ name: v.name, include: v.include, confidence: v.confidence, notes: v.notes })), null, 2),
      { label: 'report', phase: 'Export', model: MODEL_REASONING },
    ),
])

// csvWritten is a script-side assertion, not an agent's self-report: every
// part passed its individual cksum check (enforced by the early return
// above) AND each assembled file's CRC + byte count equal what the script
// itself computed over the concatenated part contents — exact content
// equality, not a count heuristic.
const expectedCsv = cksumOf(vParts.map((p) => p.content).join(''))
const expectedRej = cksumOf(rParts.map((p) => p.content).join(''))
const csvWritten =
  !!assembled &&
  assembled.csvCrc === expectedCsv.crc && assembled.csvBytes === expectedCsv.bytes &&
  assembled.rejectedCrc === expectedRej.crc && assembled.rejectedBytes === expectedRej.bytes
if (!csvWritten) {
  log(`CSV assembly did not pass verification (assembled=${JSON.stringify(assembled)}, expected csv crc=${expectedCsv.crc}/${expectedCsv.bytes}B, rejected crc=${expectedRej.crc}/${expectedRej.bytes}B) — check ${partsDir} manually`)
}

return {
  websetId,
  found: collected.items.length,
  ingestTruncated: !!collected.truncated,
  uniqueCandidates: candidates.length,
  verified: verdicts.length,
  validated: validated.length,
  rejected: rejected.length,
  unverified,
  persisted: verdicts.filter((v) => v.marked).length,
  csvPath,
  rejectedPath,
  csvWritten,
  report,
}
