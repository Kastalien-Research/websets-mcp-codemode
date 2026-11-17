export const meta = {
  name: 'source-jobs',
  description: 'Job sourcing: fan a role family out across many 100-item Websets (one per title/sector shard, each excluding the earlier ones) → normalize into the local store → SQL dedupe/score/tier → liveness spot-check → ranked CSV',
  whenToUse:
    'Build a 100-500 row list of open job postings when one Webset caps at 100 items. Defaults target NYC customer-facing engineering roles (Forward Deployed / Applied AI / MTS / Product Engineer, plus finance). Args (all optional): {runTag} names the run and makes it idempotent (re-running a tag reuses its websets), {target} qualified unique jobs to stop at (default 300), {maxShards} (12), {concurrency} websets populating at once (2; lowered automatically if Exa refuses a create for rate/concurrency reasons), {perShard} (100), {verifyTop} postings to liveness-check (50), {location}, {payFloor, payMin, payMax}, {yoeMin, yoeMax}, {shards:[{key,label,query,roleCriterion}]} to replace the seed shards, {outputCsv}, {dbPath}, {model}, {cheapModel}, {dryRun:true} to print the plan without spending anything.',
  phases: [
    { title: 'Plan', detail: 'seed shards (title cluster × sector); a gap planner proposes more when yield falls short' },
    { title: 'Populate', detail: 'bounded queue: at most {concurrency} shards at once; each = websets.create (excluding finished websets) → script-driven poll → normalize rows into the store' },
    { title: 'Census', detail: 'SQL dedupe + tiering across all shards; drives the queue: admit another shard, or stop' },
    { title: 'Verify', detail: 'live-crawl the top-ranked postings: still open? posted pay/YOE match?' },
    { title: 'Export', detail: 'sqlite3 → ranked CSV, row count asserted against the census' },
  ],
}

// --- Args -------------------------------------------------------------------
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = A ?? {}

const int = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' && v !== undefined ? Math.floor(Number(v)) : d)

const TAG = A.runTag ?? 'nyc-customer-eng'
if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(TAG)) {
  return { error: 'runTag must be 1-40 chars of lowercase letters, digits and hyphens (it is embedded in SQL, file names and webset externalIds).' }
}
const TARGET = int(A.target, 300)
const MAX_SHARDS = int(A.maxShards, 12)
const CONCURRENCY = Math.max(1, int(A.concurrency ?? A.waveSize, 2))
const MAX_REFUSALS = int(A.maxRefusals, 6)
const PER_SHARD = Math.max(1, int(A.perShard, 100))
const VERIFY_TOP = Math.max(0, int(A.verifyTop, 50))
const MAX_POLLS = int(A.maxPolls, 30) // poll agents per shard; each waits up to POLL_CALLS × ~100s
const POLL_CALLS = 5
const MIN_GAIN = int(A.minGain, 10)
const LOCATION = A.location ?? 'New York City'
const PAY_FLOOR = int(A.payFloor, 180000)
const PAY_MIN = int(A.payMin, 200000)
const PAY_MAX = int(A.payMax, 300000)
const YOE_MIN = int(A.yoeMin, 2)
const YOE_MAX = int(A.yoeMax, 5)
const MODEL_CHEAP = A.cheapModel ?? 'claude-haiku-5-5'
const MODEL_REASONING = A.model // undefined → inherit the session model

const CSV_PATH = A.outputCsv ?? `exports/jobs-${TAG}.csv`
const DB_PATH = A.dbPath ?? 'data/websets.db'
for (const [name, p, ext] of [['outputCsv', CSV_PATH, 'csv'], ['dbPath', DB_PATH, 'db']]) {
  // Both are interpolated into shell commands inside agent prompts.
  if (!new RegExp(`^[A-Za-z0-9._/-]+\\.${ext}$`).test(p) || p.includes('..')) {
    return { error: `${name} must be a plain .${ext} path: letters, digits, dot, underscore, slash, hyphen only, no "..".` }
  }
}
const SQL_PATH = CSV_PATH.replace(/\.csv$/, '') + '.sql'
const SRC = `source-jobs:${TAG}`
const usd = (n) => '$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const EXECUTE_TOOL =
  'the websets `execute` MCP tool (mcp__websets-codemode-local__execute — load it via ToolSearch with ' +
  '"select:mcp__websets-codemode-local__execute" if it is not already available)'

// --- Shards: one Webset each -------------------------------------------------
// A Webset holds ≤100 items on this plan, so breadth comes from running many of
// them over DIFFERENT slices of the same role family. Slices are title clusters
// and sector lenses, so overlap between them is low to begin with; each shard
// also passes every already-finished webset as an `exclude` source, so Exa
// spends its 100 slots on postings the run does not have yet.
const SEED_SHARDS = [
  {
    key: 'fde',
    label: 'Forward Deployed Engineer',
    query: 'Forward Deployed Engineer job postings (also titled Forward Deployed Software Engineer, FDSE, Forward Deployed AI Engineer, Deployed Engineer)',
    roleCriterion: 'The job title is Forward Deployed Engineer or a close variant (Forward Deployed Software Engineer, FDSE, Forward Deployed AI Engineer, Deployed Engineer): an engineer who writes production code while embedded with customers.',
  },
  {
    key: 'applied-ai',
    label: 'Applied AI Engineer',
    query: 'Applied AI Engineer job postings (also titled AI Engineer, Applied AI, Applied ML Engineer, AI Solutions Engineer) for engineers who build and ship LLM-powered products directly with customers',
    roleCriterion: 'The job title is Applied AI Engineer or a close variant (AI Engineer, Applied ML Engineer, Applied AI Software Engineer, AI Solutions Engineer), and the role is hands-on software engineering that builds and ships AI/LLM applications for customers or end users (not pure research, not data labeling).',
  },
  {
    key: 'mts',
    label: 'Member of Technical Staff',
    query: 'Member of Technical Staff job postings at AI labs and AI-native startups, for generalist software engineers who own projects end to end',
    roleCriterion: 'The job title is Member of Technical Staff (MTS) or Technical Staff, and the role is a software or AI engineering position with broad individual ownership (not a hardware, chip-design, or pure research-scientist role).',
  },
  {
    key: 'product-eng',
    label: 'Product Engineer',
    query: 'Product Engineer job postings at startups, for full-stack engineers who talk to users, decide what to build, and ship it end to end',
    roleCriterion: 'The job title is Product Engineer or a close variant (Full-Stack Product Engineer, Software Engineer - Product), and the posting describes owning features end to end including direct contact with users or customers.',
  },
  {
    key: 'founding',
    label: 'Founding / early engineer',
    query: 'Founding Engineer and early-stage generalist software engineer job postings at venture-backed startups, where the engineer owns product areas end to end and works directly with customers',
    roleCriterion: 'The role is a Founding Engineer or early-team generalist software engineer at a startup, and the posting describes end-to-end ownership that includes working directly with customers or users.',
  },
  {
    key: 'solutions',
    label: 'Solutions / deployment engineering (code-writing)',
    query: 'Solutions Engineer, Customer Engineer, Implementation Engineer, Deployment Strategist and Agent Engineer job postings at software and AI companies, for engineers who write production code to deploy the product for specific customers',
    roleCriterion: 'The role is a customer-facing engineering position (Solutions Engineer, Solutions Architect, Customer Engineer, Implementation Engineer, Deployment Strategist, Agent Engineer, or similar) whose core work is writing and shipping code or integrations for customers, not primarily sales demos or ticket-based support.',
  },
  {
    key: 'fin-fintech',
    label: 'Finance: fintech and financial infrastructure',
    query: 'Forward Deployed Engineer, Applied AI Engineer, Product Engineer and Member of Technical Staff job postings at fintech companies and financial-infrastructure startups (payments, banking, lending, insurance, accounting, AI for financial services)',
    roleCriterion: 'The hiring company is a fintech or sells software to financial institutions, and the role is a software or AI engineering position that works closely with customers or the business and owns its work end to end.',
  },
  {
    key: 'fin-buyside',
    label: 'Finance: hedge funds, trading firms, asset managers, banks',
    query: 'Software engineer and AI engineer job postings at hedge funds, proprietary trading firms, asset managers and investment banks where the engineer sits with the business: forward deployed, desk-aligned, front-office, or applied AI engineering teams building tools directly for investors and traders',
    roleCriterion: 'The hiring company is a hedge fund, trading firm, asset manager, or bank, and the role is a software or AI engineering position embedded with or directly serving the firm\'s investment, trading, or business teams (forward deployed, desk-aligned, front-office, or applied AI), not back-office IT.',
  },
  {
    key: 'founder-friendly',
    label: 'Postings that court ex-founders',
    query: 'Software engineering job postings that explicitly welcome former founders or ex-entrepreneurs ("former founders encouraged to apply", "founder mentality", "we hire ex-founders") for customer-facing, high-ownership engineering roles',
    roleCriterion: 'The posting is for a software or AI engineering role AND its text explicitly welcomes former founders, ex-entrepreneurs, or people who have started a company.',
  },
  {
    key: 'gtm-eng',
    label: 'Customer-adjacent generalists',
    query: 'Job postings for software engineers on customer-adjacent teams: Software Engineer - Customer Engineering, Software Engineer - Deployments, Technical Deployment Lead, AI Deployment Engineer, GTM Engineer, Field Engineer, at AI and enterprise software companies',
    roleCriterion: 'The role is a code-writing software engineering position on a customer-adjacent team (customer engineering, deployments, field engineering, go-to-market engineering) with direct customer contact and ownership of delivery end to end.',
  },
]

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,29}$/
function cleanShards(list, taken) {
  const out = []
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s.query !== 'string' || typeof s.roleCriterion !== 'string') continue
    const key = String(s.key ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)
    if (!KEY_RE.test(key) || taken.has(key)) continue
    taken.add(key)
    out.push({ key, label: String(s.label ?? key).slice(0, 80), query: s.query.trim(), roleCriterion: s.roleCriterion.trim() })
  }
  return out
}
const takenKeys = new Set()
const queue = cleanShards(A.shards ?? SEED_SHARDS, takenKeys)
if (queue.length === 0) return { error: 'No valid shards: each needs {key, query, roleCriterion}.' }

// --- Webset definition shared by every shard ----------------------------------
// Criteria gate what may occupy one of a webset's 100 slots, so they carry the
// hard filters (open posting, location, role family, pay floor). Years of
// experience and the softer preferences are enrichments: postings word them too
// inconsistently to gate on, and the tiering below is deterministic SQL.
function criteriaFor(shard) {
  return [
    'Is a job posting for one specific role that is currently open for applications (not a general careers page, a job-board search results page, a staffing-agency repost, or an expired listing).',
    `The role is based in ${LOCATION} (on-site or hybrid there, or the posting lists ${LOCATION} as one of its office locations). Fully remote roles with no ${LOCATION} office do not count.`,
    shard.roleCriterion,
    `States an annual base salary or base salary range in USD whose upper bound is at least ${usd(PAY_FLOOR)}.`,
  ].map((description) => ({ description }))
}

const F_EXPLICIT = 'Posting explicitly welcomes former founders'
const F_STAFF = 'Company is known to employ former founders'
const F_NONE = 'No founder signal found'
const FIN_REQUIRED = 'Required'
const opts = (...labels) => labels.map((label) => ({ label }))

// key → column in the normalized row. Descriptions are matched verbatim against
// websets.get to map each webset's own enrichment ids back onto these keys.
const ENRICHMENTS = [
  { key: 'title', format: 'text', description: 'Exact job title as written in the posting' },
  { key: 'company', format: 'text', description: 'Name of the company that is hiring for this role' },
  { key: 'salaryMin', format: 'number', description: 'Lower bound of the posted annual base salary range in USD, as a plain number such as 180000 (base salary only, excluding equity and bonus)' },
  { key: 'salaryMax', format: 'number', description: 'Upper bound of the posted annual base salary range in USD, as a plain number such as 250000 (base salary only, excluding equity and bonus)' },
  { key: 'yoeMin', format: 'number', description: 'Minimum years of professional experience the posting requires, as a plain number (0 if the posting states no minimum)' },
  { key: 'arrangement', format: 'options', description: 'Work arrangement for this role', options: opts('On-site', 'Hybrid', 'Remote') },
  { key: 'sector', format: 'options', description: 'Industry sector of the hiring company', options: opts('AI lab or AI-native startup', 'Fintech or financial infrastructure', 'Hedge fund, trading firm, or asset manager', 'Bank or large financial institution', 'Other software or technology', 'Other') },
  { key: 'financeReq', format: 'options', description: 'Whether the posting requires prior finance-industry experience', options: opts(FIN_REQUIRED, 'Preferred but not required', 'Not required') },
  { key: 'founderSignal', format: 'options', description: 'Founder-friendliness: does the posting explicitly welcome former founders or ex-entrepreneurs, or is the hiring company publicly known to employ former startup founders on its team (beyond its own founders)?', options: opts(F_EXPLICIT, F_STAFF, F_NONE) },
  { key: 'founderEvidence', format: 'text', description: 'One sentence of evidence for the founder-friendliness answer, naming its source (posting text, careers page, team bios, press), or "none"' },
]
const NUMERIC_KEYS = ['salaryMin', 'salaryMax', 'yoeMin']
const SALARY_KEYS = ['salaryMin', 'salaryMax']

function createParams(shard, excludeIds) {
  const p = {
    title: `source-jobs:${TAG}:${shard.key}`,
    externalId: `source-jobs-${TAG}-${shard.key}`,
    searchQuery: `${shard.query}, based in ${LOCATION}, currently open, with a posted base salary range reaching at least ${usd(PAY_FLOOR)}.`,
    searchCount: PER_SHARD,
    searchCriteria: criteriaFor(shard),
    // No `entity`: the server's entity schema rejects the description a custom
    // entity needs, and Exa auto-detects "Job Posting" from the query.
    enrichments: ENRICHMENTS.map(({ description, format, options }) => (options ? { description, format, options } : { description, format })),
  }
  if (excludeIds.length) p.exclude = excludeIds.map((id) => ({ source: 'webset', id }))
  return p
}

// --- SQL: every number this run reports comes from these queries -------------
// Rows never pass through an agent. Each shard's items are normalized inside
// the server sandbox into `job_row` annotations; dedupe, scoring and tiering
// happen here, and the CSV is written by sqlite3 itself. store.query only
// accepts statements that start with SELECT, so these nest instead of using WITH.
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
const latest = (alias, type) =>
  `${alias}.type = '${type}' AND ${alias}.source = ${q(SRC)} AND ${alias}.id = ` +
  `(SELECT max(z.id) FROM annotations z WHERE z.item_id = ${alias}.item_id AND z.type = '${type}' AND z.source = ${q(SRC)})`
const jx = (alias, k) => `json_extract(${alias}.value, '$.${k}')`

const ROWS_SQL = `SELECT a.item_id AS item_id,
  ${jx('a', 'shard')} AS shard, ${jx('a', 'websetId')} AS webset_id, ${jx('a', 'url')} AS url,
  coalesce(nullif(${jx('a', 'title')}, ''), ${jx('a', 'name')}) AS title, ${jx('a', 'company')} AS company,
  nullif(${jx('a', 'salaryMin')}, 0) AS salary_min, nullif(${jx('a', 'salaryMax')}, 0) AS salary_max,
  ${jx('a', 'yoeMin')} AS yoe_min, ${jx('a', 'arrangement')} AS arrangement, ${jx('a', 'sector')} AS sector,
  ${jx('a', 'financeReq')} AS finance_req, ${jx('a', 'founderSignal')} AS founder_signal,
  ${jx('a', 'founderEvidence')} AS founder_evidence,
  c.id AS chk_id, ${jx('c', 'live')} AS chk_live, ${jx('c', 'pageSalaryMin')} AS page_min,
  ${jx('c', 'pageSalaryMax')} AS page_max, ${jx('c', 'note')} AS chk_note
FROM annotations a
LEFT JOIN annotations c ON c.item_id = a.item_id AND ${latest('c', 'job_check')}
WHERE ${latest('a', 'job_row')}`

const KEYED_SQL = `SELECT r.*,
  coalesce(r.salary_max, r.salary_min) AS pay_hi, coalesce(r.salary_min, r.salary_max) AS pay_lo,
  lower(rtrim(r.url, '/')) AS url_key,
  CASE WHEN trim(coalesce(r.company, '')) <> '' AND trim(coalesce(r.title, '')) <> ''
       THEN lower(trim(r.company)) || '|' || lower(trim(r.title)) ELSE lower(rtrim(r.url, '/')) END AS ct_key
FROM (${ROWS_SQL}) r`

const FIT_SQL = `SELECT k.*,
  CASE WHEN k.pay_hi IS NULL THEN 'unknown' WHEN k.pay_hi < ${PAY_FLOOR} THEN 'below_floor'
       WHEN k.pay_lo > ${PAY_MAX} THEN 'above_range'
       WHEN k.pay_hi >= ${PAY_MIN} THEN 'in_range' ELSE 'floor_only' END AS pay_fit,
  CASE WHEN k.yoe_min IS NULL THEN 'unknown' WHEN k.yoe_min > ${YOE_MAX} THEN 'too_senior'
       WHEN k.yoe_min >= ${YOE_MIN} THEN 'in_range' ELSE 'below_range' END AS yoe_fit,
  CASE WHEN k.chk_id IS NULL THEN 'unchecked' WHEN k.chk_live = 1 THEN 'live'
       WHEN k.chk_live = 0 THEN 'closed' ELSE 'unclear' END AS posting_status,
  CASE WHEN k.chk_id IS NULL OR k.page_max IS NULL THEN ''
       WHEN abs(k.page_max - k.pay_hi) <= 0.05 * k.pay_hi
        AND abs(coalesce(k.page_min, k.page_max) - k.pay_lo) <= 0.05 * k.pay_lo THEN 'confirmed'
       ELSE 'mismatch: page says ' || cast(coalesce(k.page_min, k.page_max) AS integer) || '-' || cast(k.page_max AS integer) END AS pay_check
FROM (${KEYED_SQL}) k`

// Tier A: pay overlaps the desired band AND the YOE ask is in range.
// Tier B: clears the pay floor and is not too senior, but something is unknown or only floor-level.
// Tier C: disqualified (below floor, wants more experience than YOE_MAX, or found closed) — kept, at the bottom.
const SCORED_SQL = `SELECT f.*,
  (CASE f.pay_fit WHEN 'in_range' THEN 40 WHEN 'above_range' THEN 40 WHEN 'floor_only' THEN 20 WHEN 'unknown' THEN 10 ELSE 0 END)
  + (CASE f.yoe_fit WHEN 'in_range' THEN 30 WHEN 'below_range' THEN 15 WHEN 'unknown' THEN 15 ELSE 0 END)
  + (CASE f.founder_signal WHEN ${q(F_EXPLICIT)} THEN 20 WHEN ${q(F_STAFF)} THEN 10 ELSE 0 END)
  - (CASE WHEN f.finance_req = ${q(FIN_REQUIRED)} THEN 15 ELSE 0 END) AS score,
  CASE WHEN f.pay_fit = 'below_floor' OR f.yoe_fit = 'too_senior' THEN 'C'
       WHEN f.pay_fit IN ('in_range', 'above_range') AND f.yoe_fit = 'in_range' THEN 'A' ELSE 'B' END AS base_tier
FROM (${FIT_SQL}) f`

// Two dedupe passes: same company+title (one job cross-posted on several boards), then same URL.
const DEDUPED_SQL = `SELECT u.*, CASE WHEN u.chk_live = 0 THEN 'C' ELSE u.base_tier END AS tier FROM (
  SELECT t.*, row_number() OVER (PARTITION BY t.url_key ORDER BY t.score DESC, t.item_id) AS rn_url FROM (
    SELECT s.*, row_number() OVER (PARTITION BY s.ct_key ORDER BY s.score DESC, s.item_id) AS rn_ct FROM (${SCORED_SQL}) s
  ) t WHERE t.rn_ct = 1
) u WHERE u.rn_url = 1`

// The verify queue: best postings first, in an order that does not depend on check results.
const TOP_SQL = `SELECT d.* FROM (${DEDUPED_SQL}) d WHERE d.base_tier IN ('A', 'B') ORDER BY d.base_tier, d.score DESC, d.item_id LIMIT ${VERIFY_TOP}`

const CENSUS_SQL = `SELECT count(*) AS uniqueJobs,
  coalesce(sum(d.tier = 'A'), 0) AS tierA, coalesce(sum(d.tier = 'B'), 0) AS tierB, coalesce(sum(d.tier = 'C'), 0) AS tierC,
  coalesce(sum(d.chk_id IS NOT NULL), 0) AS checked,
  (SELECT count(*) FROM annotations a WHERE ${latest('a', 'job_row')}) AS rawRows,
  (SELECT count(*) FROM (${TOP_SQL}) x WHERE x.chk_id IS NULL) AS uncheckedTop
FROM (${DEDUPED_SQL}) d`
const BY_SHARD_SQL = `SELECT d.shard AS shard, count(*) AS uniqueJobs, coalesce(sum(d.tier IN ('A', 'B')), 0) AS qualified FROM (${DEDUPED_SQL}) d GROUP BY d.shard ORDER BY d.shard`

const EXPORT_SQL = `SELECT row_number() OVER (ORDER BY d.tier, d.score DESC, d.company, d.item_id) AS rank,
  d.tier, d.score, d.title, d.company, d.url, d.salary_min, d.salary_max, d.pay_fit, d.yoe_min, d.yoe_fit,
  d.arrangement, d.sector, d.finance_req, d.founder_signal, d.founder_evidence,
  d.posting_status, d.pay_check, d.chk_note AS check_note, d.shard, d.webset_id, d.item_id
FROM (${DEDUPED_SQL}) d ORDER BY d.tier, d.score DESC, d.company, d.item_id;\n`

// --- Sandbox programs ---------------------------------------------------------
// Agents are couriers: each one runs a program written here, unchanged, and
// reports what it returned. String.raw keeps regex backslashes intact.
const js = (v) => JSON.stringify(v)

const createCode = (shard, excludeIds) => String.raw`const params = ${js(createParams(shard, excludeIds))};
let ws = null;
try { ws = await callOperation('websets.get', { id: params.externalId }); } catch (e) { ws = null; }
const reused = !!(ws && ws.id);
if (!reused) ws = await callOperation('websets.create', params);
return { websetId: ws.id, reused };`

const pollCode = (websetId) => String.raw`const id = ${js(websetId)};
let ws;
try { ws = await callOperation('websets.waitUntilIdle', { id, timeout: 100000, pollInterval: 5000 }); }
catch (e) { ws = await callOperation('websets.get', { id }); }
const found = (ws.searches || []).reduce((n, s) => n + ((s.progress && s.progress.found) || 0), 0);
return { status: String(ws.status), found };`

const normalizeCode = (shard, websetId) => String.raw`const websetId = ${js(websetId)};
const KEYS = ${js(Object.fromEntries(ENRICHMENTS.map((e) => [e.description, e.key])))};
const NUMERIC = ${js(NUMERIC_KEYS)};
const SALARY = ${js(SALARY_KEYS)};
const ws = await callOperation('websets.get', { id: websetId });
const idToKey = {};
for (const e of (ws.enrichments || [])) { if (KEYS[e.description]) idToKey[e.id] = KEYS[e.description]; }
const all = await callOperation('items.getAll', { websetId, ingest: true, maxItems: 1000 });
const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 400);
const num = (v, salary) => {
  const m = String(v == null ? '' : v).replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  if (salary && n > 0 && n < 1000) n = n * 1000;
  return n;
};
const items = all.data || [];
let written = 0, failed = 0;
for (const it of items) {
  const row = { shard: ${js(shard.key)}, websetId, url: clean(it.url), name: clean(it.name) };
  for (const e of (it.enrichments || [])) {
    const k = idToKey[e.enrichmentId];
    if (!k) continue;
    const v = Array.isArray(e.result) ? e.result[0] : e.result;
    row[k] = NUMERIC.includes(k) ? num(v, SALARY.includes(k)) : clean(v);
  }
  try {
    await callOperation('store.annotate', { itemId: it.id, type: 'job_row', value: JSON.stringify(row), source: ${js(SRC)} });
    written++;
  } catch (e) { failed++; }
}
return { total: typeof all.total === 'number' ? all.total : items.length, passing: items.length, truncated: all.truncated ? 1 : 0, mappedColumns: Object.keys(idToKey).length, written, failed };`

const censusCode = String.raw`const c = await callOperation('store.query', { sql: ${js(CENSUS_SQL)} });
const s = await callOperation('store.query', { sql: ${js(BY_SHARD_SQL)} });
return Object.assign({}, c.rows[0], { byShard: s.rows });`

const VERIFY_BATCH = 5
const verifyFetchCode = (where) => String.raw`const sel = await callOperation('store.query', { sql: ${js(`SELECT x.item_id, x.url, x.title, x.company, x.salary_min, x.salary_max, x.yoe_min FROM (${TOP_SQL}) x ${where}`)} });
const out = [];
await Promise.all(sel.rows.map(async (r) => {
  let text = null, fetchError = null;
  try {
    const res = await callOperation('exa.getContents', { urls: [r.url], text: { maxCharacters: 6000 }, livecrawl: 'preferred' });
    const page = (res.results || [])[0];
    text = page && page.text ? String(page.text).slice(0, 6000) : null;
    if (!text) fetchError = JSON.stringify(res.statuses || res).slice(0, 300);
  } catch (e) { fetchError = String(e && e.message || e).slice(0, 300); }
  out.push({ itemId: r.item_id, url: r.url, listed: { title: r.title, company: r.company, salaryMin: r.salary_min, salaryMax: r.salary_max, yoeMin: r.yoe_min }, pageText: text, fetchError });
}));
return out;`

const verifyWriteCode = String.raw`const CHECKS = [/* FILL IN: one { itemId, live, pageSalaryMin, pageSalaryMax, pageYoeMin, note } per posting */];
const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 300);
const n = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const written = [];
for (const c of CHECKS) {
  const has = await callOperation('store.query', { sql: "SELECT count(*) AS n FROM annotations WHERE item_id = ? AND type = 'job_row' AND source = ?", params: [String(c.itemId), ${js(SRC)}] });
  if (!has.rows[0].n) continue;
  const value = { live: c.live === true ? true : c.live === false ? false : null, pageSalaryMin: n(c.pageSalaryMin), pageSalaryMax: n(c.pageSalaryMax), pageYoeMin: n(c.pageYoeMin), note: clean(c.note) };
  await callOperation('store.annotate', { itemId: String(c.itemId), type: 'job_check', value: JSON.stringify(value), source: ${js(SRC)} });
  written.push(String(c.itemId));
}
return { written: written.length, itemIds: written };`

// POSIX cksum over UTF-8 bytes (same implementation as source-candidates.js,
// validated there against the real binary) — lets this script know what
// `cksum` must print for a file it asked an agent to write.
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

if (A.dryRun) {
  return {
    dryRun: true,
    runTag: TAG,
    target: TARGET,
    maxShards: MAX_SHARDS,
    concurrency: CONCURRENCY,
    shards: queue.map((s) => ({ key: s.key, label: s.label })),
    createParams: createParams(queue[0], []),
    sql: { census: CENSUS_SQL, byShard: BY_SHARD_SQL, export: EXPORT_SQL },
    code: {
      create: createCode(queue[0], []),
      poll: pollCode('webset_example'),
      normalize: normalizeCode(queue[0], 'webset_example'),
      census: censusCode,
      verifyFetch: verifyFetchCode(`LIMIT ${VERIFY_BATCH} OFFSET 0`),
      verifyWrite: verifyWriteCode,
    },
    csvPath: CSV_PATH,
  }
}

// --- Agent plumbing -----------------------------------------------------------
// Schemas hold measurements only and nothing is `required`: an agent whose call
// failed reports `error` instead of inventing numbers, and the script decides
// what counts as success.
const num = { type: 'number' }
const str = { type: 'string' }
const schemaOf = (properties) => ({ type: 'object', properties: { ...properties, error: str } })
const CREATE_SCHEMA = schemaOf({ websetId: str, reused: { type: 'boolean' } })
const POLL_SCHEMA = schemaOf({ status: str, found: num })
const NORMALIZE_SCHEMA = schemaOf({ total: num, passing: num, truncated: num, mappedColumns: num, written: num, failed: num })
const CENSUS_SCHEMA = schemaOf({
  uniqueJobs: num, tierA: num, tierB: num, tierC: num, checked: num, rawRows: num, uncheckedTop: num,
  byShard: { type: 'array', items: { type: 'object', properties: { shard: str, uniqueJobs: num, qualified: num } } },
})
const VERIFY_SCHEMA = schemaOf({ written: num, itemIds: { type: 'array', items: str } })
const WRITE_SCHEMA = schemaOf({ cksumCrc: num, bytes: num })
const EXPORT_SCHEMA = schemaOf({ exitCode: num, lines: num, cksumCrc: num, bytes: num, stderr: str })
const PLAN_SCHEMA = {
  type: 'object',
  required: ['shards'],
  properties: {
    shards: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'label', 'query', 'roleCriterion'],
        properties: { key: str, label: str, query: str, roleCriterion: str },
      },
    },
  },
}

const runCode = (code, { label, phase: ph, schema, timeout = 60000, repeatUntilIdle = 0 }) =>
  agent(
    `Run the JavaScript below VERBATIM through ${EXECUTE_TOOL}: pass it unchanged as the tool's \`code\` argument, ` +
      `with the tool's \`timeout\` argument set to ${timeout}. Do not edit, shorten, or "fix" the code, and make no ` +
      `other tool calls. The tool answers with JSON whose \`result\` field is the code's return value: report that ` +
      `object's fields exactly as returned — raw values, no interpretation. If the call fails, repeat the identical ` +
      `call once; if it fails again, report only \`error\` with the error text. ` +
      (repeatUntilIdle > 1
        ? `This code waits on a long-running job: while the returned \`status\` is not "idle", make the identical call ` +
          `again, up to ${repeatUntilIdle} calls in total, then report the LAST call's result. `
        : '') +
      `The <<<CODE/CODE markers delimit the ` +
      `code and are not part of it.\n\n<<<CODE\n${code}\nCODE`,
    { label, phase: ph, schema, effort: 'low', model: MODEL_CHEAP },
  )

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const WEBSET_ID_RE = /^webset_[A-Za-z0-9]+$/
const LIMIT_RE = /\b429\b|rate.?limit|too many|concurren|quota|limit (reached|exceeded)|exceeded .*limit/i
const createTries = new Map()
const SLEEP_SCHEMA = schemaOf({ waitedSeconds: num })
// The sandbox caps each setTimeout at 5s, so a ~90s wait is 18 short ones.
const sleepCode = String.raw`for (let i = 0; i < 18; i++) await new Promise((r) => setTimeout(r, 5000));
return { waitedSeconds: 90 };`

async function takeCensus(tag) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const c = await runCode(censusCode, { label: `census:${tag}${attempt > 1 ? ':retry' : ''}`, phase: 'Census', schema: CENSUS_SCHEMA })
    if (c && ['uniqueJobs', 'tierA', 'tierB', 'tierC', 'checked', 'rawRows', 'uncheckedTop'].every((k) => isNum(c[k]))) {
      return { ...c, qualified: c.tierA + c.tierB, byShard: Array.isArray(c.byShard) ? c.byShard : [] }
    }
    log(`Census ${tag} attempt ${attempt} returned no usable counts${c?.error ? `: ${String(c.error).slice(0, 200)}` : ''}`)
  }
  return null
}

// --- Populate: one shard = create → poll (script-driven) → normalize ----------
async function runShard(shard, excludeIds) {
  const tries = (createTries.get(shard.key) ?? 0)
  let created = null
  for (let attempt = 1; attempt <= 2 && !(created && WEBSET_ID_RE.test(created.websetId ?? '')); attempt++) {
    createTries.set(shard.key, tries + attempt)
    created = await runCode(createCode(shard, excludeIds), {
      // The label counts every attempt across requeues, so a resumed run never
      // replays an earlier refusal from cache.
      label: `create:${shard.key}${tries + attempt > 1 ? `:try${tries + attempt}` : ''}`, phase: 'Populate', schema: CREATE_SCHEMA,
    })
    // A rate/concurrency refusal is the scheduler's business, not a failure to retry into.
    if (created?.error && LIMIT_RE.test(String(created.error))) {
      return { shard: shard.key, label: shard.label, websetId: null, limited: true, error: String(created.error).slice(0, 300) }
    }
  }
  if (!created || !WEBSET_ID_RE.test(created.websetId ?? '')) {
    log(`Shard ${shard.key}: webset creation failed${created?.error ? ` — ${String(created.error).slice(0, 300)}` : ''}`)
    return { shard: shard.key, label: shard.label, websetId: null, error: created?.error ?? 'create failed' }
  }
  const websetId = created.websetId
  log(`Shard ${shard.key}: webset ${websetId} ${created.reused ? 'reused from an earlier run of this tag' : `created (excluding ${excludeIds.length} finished webset(s))`}`)

  // Each poll agent blocks ~100s server-side per call and makes at most
  // POLL_CALLS of them (~9 min), then a fresh agent takes over. Measured on a
  // live run: a 5-item webset with these enrichments took ~15 minutes, so 100
  // items can run well past an hour. One agent per call cost ~55k tokens of
  // pure overhead each; one agent for the whole wait trips the harness's stall
  // detector. The script still owns the loop and the give-up decision.
  let status = 'running'
  let polls = 0
  let found = 0
  while (status !== 'idle' && polls < MAX_POLLS) {
    polls++
    const p = await runCode(pollCode(websetId), { label: `poll:${shard.key}:${polls}`, phase: 'Populate', schema: POLL_SCHEMA, timeout: 120000, repeatUntilIdle: POLL_CALLS })
    if (p?.status) status = p.status
    if (isNum(p?.found)) found = p.found
    if (status !== 'idle' && polls % 2 === 0) log(`Shard ${shard.key}: still ${status} after ~${polls * POLL_CALLS * 2} min, found≈${found}`)
  }
  if (status !== 'idle') log(`Shard ${shard.key}: still ${status} after ${polls} poll agents — normalizing what exists; re-run with the same runTag later to pick up the rest`)

  // Normalizing is idempotent (the SQL reads each item's newest job_row), so a
  // short write is simply re-run by the script rather than patched by the agent.
  let norm = null
  const complete = (n) => !!n && isNum(n.written) && n.written === n.passing && n.failed === 0
  for (let attempt = 1; attempt <= 3 && !complete(norm); attempt++) {
    norm = await runCode(normalizeCode(shard, websetId), {
      label: `normalize:${shard.key}${attempt > 1 ? `:retry${attempt}` : ''}`, phase: 'Populate', schema: NORMALIZE_SCHEMA, timeout: 120000,
    })
  }
  if (!complete(norm)) {
    log(`Shard ${shard.key}: normalization incomplete (${JSON.stringify(norm)}) — its rows may be missing from the list`)
  } else {
    if (norm.mappedColumns !== ENRICHMENTS.length) {
      log(`Shard ${shard.key}: only ${norm.mappedColumns}/${ENRICHMENTS.length} enrichment columns mapped — this webset was created with a different column set, so some fields will be blank`)
    }
    if (norm.truncated) log(`Shard ${shard.key}: items.getAll truncated at its maxItems cap`)
    log(`Shard ${shard.key}: ${norm.written} row(s) normalized (${norm.total - norm.passing} item(s) failed the webset's own criteria and were left out)`)
  }
  return { shard: shard.key, label: shard.label, websetId, idle: status === 'idle', polls, written: complete(norm) ? norm.written : 0, normalized: complete(norm) }
}

// --- Gap planner: the dynamic half of the shard list --------------------------
async function planMoreShards(census, results, want) {
  const yields = results.map((r) => {
    const s = census.byShard.find((b) => b.shard === r.shard)
    return `- ${r.shard} (${r.label}): ${r.written ?? 0} rows normalized → ${s?.uniqueJobs ?? 0} unique after dedupe, ${s?.qualified ?? 0} qualified`
  }).join('\n')
  const titlesSql = `SELECT d.title AS title, count(*) AS n FROM (${DEDUPED_SQL}) d GROUP BY lower(d.title) ORDER BY n DESC LIMIT 60`
  const plan = await agent(
    `A job-sourcing run is collecting open ${LOCATION} job postings for engineers who work close to the customer with ` +
      `heavy end-to-end individual ownership (Forward Deployed Engineer, Applied AI Engineer, Member of Technical Staff, ` +
      `Product Engineer and the like), including such roles in the financial industry. Each "shard" is one Exa Webset ` +
      `capped at ${PER_SHARD} postings. The run has ${census.qualified} qualified unique postings and wants ${TARGET}.\n\n` +
      `Shards run so far and what each yielded:\n${yields}\n\n` +
      `To see which titles are already covered, you may run this through ${EXECUTE_TOOL}:\n` +
      `  return await callOperation('store.query', { sql: ${js(titlesSql)} });\n\n` +
      `Propose up to ${want} NEW shards that would surface postings the existing shards miss. Good new shards slice ` +
      `along a different axis than the ones above: an adjacent title cluster not yet covered, a sector lens (a specific ` +
      `kind of company), or a company-stage lens. A shard that paraphrases an existing one only returns duplicates; ` +
      `shards that yielded close to ${PER_SHARD} rows were cut off by the cap and are worth splitting into narrower ` +
      `slices, while shards that yielded few are exhausted. Stay inside the role family: code-writing engineering ` +
      `roles with customer contact and ownership.\n\n` +
      `For each shard give: key (short lowercase slug, unique), label, query (one dense sentence describing the ` +
      `postings to find — do not mention location or salary, those are appended), and roleCriterion (one objective, ` +
      `checkable sentence stating what makes a posting belong to this shard). Return an empty list if you judge the ` +
      `space exhausted.`,
    { label: `plan-gaps:${results.length}`, phase: 'Plan', schema: PLAN_SCHEMA, model: MODEL_REASONING },
  )
  return cleanShards(plan?.shards, takenKeys).slice(0, want)
}

// --- Scheduler: a bounded queue, not a fan-out ---------------------------------
// At most `limit` websets populate at once; everything else waits in `queue`.
// A slot frees when a shard finishes, and the next shard is admitted with every
// FINISHED webset as an `exclude` source (finished = idle, so its contents are
// final). The ceiling is also learned: if Exa refuses a create for a rate or
// concurrency reason, the shard goes back to the front of the queue and `limit`
// drops to the number of websets this run had running at that moment.
phase('Populate')
log(`Run "${TAG}": target ${TARGET} qualified unique postings, up to ${MAX_SHARDS} shard(s) of ${PER_SHARD}, at most ${CONCURRENCY} populating at once; ${queue.length} seed shard(s) queued`)

const results = []
const running = new Map() // shard key → promise of { shard, r }
const refusals = new Map() // shard key → times its create was limit-refused
let limit = CONCURRENCY
let census = { uniqueJobs: 0, tierA: 0, tierB: 0, tierC: 0, qualified: 0, checked: 0, rawRows: 0, uncheckedTop: 0, byShard: [] }
let dryShards = 0
let stopReason = null
let plannerSpent = false
let backoffs = 0

const admit = (shard) => {
  const excludeIds = results.filter((r) => r.websetId && r.idle).map((r) => r.websetId)
  running.set(shard.key, runShard(shard, excludeIds).then(
    (r) => ({ shard, r }),
    (e) => ({ shard, r: { shard: shard.key, label: shard.label, websetId: null, error: `shard chain died: ${String(e?.message ?? e).slice(0, 200)}` } }),
  ))
}

while (true) {
  while (!stopReason && queue.length > 0 && running.size < limit && results.length + running.size < MAX_SHARDS) admit(queue.shift())

  if (running.size === 0) {
    if (stopReason) break
    if (results.length >= MAX_SHARDS) { stopReason = 'shard budget spent'; break }
    if (queue.length > 0) continue // slots are free again (e.g. after a backoff)
    if (plannerSpent || results.length === 0) { stopReason = 'no shards left to run'; break }
    const more = await planMoreShards(census, results, Math.min(4, MAX_SHARDS - results.length))
    if (more.length === 0) { stopReason = 'gap planner proposed nothing new'; plannerSpent = true; break }
    log(`Gap planner queued ${more.length} more shard(s): ${more.map((s) => s.key).join(', ')}`)
    queue.push(...more)
    continue
  }

  const { shard, r } = await Promise.race(running.values())
  running.delete(shard.key)

  if (r.limited) {
    const n = (refusals.get(shard.key) ?? 0) + 1
    refusals.set(shard.key, n)
    if (n > MAX_REFUSALS) {
      log(`Shard ${shard.key}: create refused ${n} times for rate/concurrency reasons — giving up on it`)
      results.push({ shard: shard.key, label: shard.label, websetId: null, error: `limit-refused ${n}x: ${r.error}` })
      continue
    }
    queue.unshift(shard)
    if (running.size > 0) {
      // Something of ours is still populating: that count is the real ceiling.
      limit = Math.max(1, Math.min(limit, running.size))
      log(`Shard ${shard.key}: create refused (${String(r.error).slice(0, 120)}) — requeued; concurrency lowered to ${limit}, it will start when a slot frees`)
    } else {
      // Nothing of ours is running, so the pressure comes from elsewhere (a
      // request-rate limit, or other websets on the account). Wait, then retry.
      backoffs++
      log(`Shard ${shard.key}: create refused with nothing of this run in flight (${String(r.error).slice(0, 120)}) — backing off ~90s (#${backoffs})`)
      await runCode(sleepCode, { label: `backoff:${backoffs}`, phase: 'Populate', schema: SLEEP_SCHEMA, timeout: 110000 })
    }
    continue
  }

  results.push(r)
  const next = await takeCensus(`after-${shard.key}`)
  if (!next) { stopReason = 'census failed — not admitting more shards'; continue }
  const gained = next.uniqueJobs - census.uniqueJobs
  census = next
  log(`Shard ${shard.key} finished (${results.length} done, ${running.size} populating, ${queue.length} queued): ${census.rawRows} rows → ${census.uniqueJobs} unique (+${gained}); tiers A/B/C = ${census.tierA}/${census.tierB}/${census.tierC}; qualified ${census.qualified}/${TARGET}`)

  if (stopReason) continue // already draining: let in-flight shards finish, admit nothing
  if (census.qualified >= TARGET) stopReason = 'target reached'
  else {
    dryShards = r.websetId && gained < MIN_GAIN ? dryShards + 1 : 0
    if (dryShards >= 2) stopReason = `two consecutive shards added fewer than ${MIN_GAIN} new postings`
  }
  if (stopReason && running.size > 0) log(`Stopping admission (${stopReason}); waiting for ${running.size} in-flight shard(s) that are already paid for`)
}

const expectedRows = results.reduce((n, r) => n + (r.written ?? 0), 0)
if (census.rawRows !== expectedRows) {
  log(`Row check: the store holds ${census.rawRows} job rows for this run but the shards reported writing ${expectedRows} — treat counts as approximate until this is explained`)
}
if (queue.length > 0) {
  log(`Stopped (${stopReason}) with ${census.qualified}/${TARGET} qualified and ${queue.length} shard(s) never started: ${queue.map((s) => s.key).join(', ')} — re-run the same runTag with a higher maxShards/target to continue; finished websets are reused, not re-bought`)
}
if (census.uniqueJobs === 0) {
  return { runTag: TAG, stopReason, census, shards: results, note: 'No postings collected — nothing to verify or export.' }
}

// --- Verify: live-crawl the best postings -------------------------------------
// The webset's enrichments are one model's reading of each page. For the rows
// most likely to be acted on, a separate agent re-reads the live page and
// records what it says; SQL (not the agent) decides whether that agrees.
const verifyAgent = (where, label) =>
  agent(
    `Check whether job postings are still open and whether their listed pay matches the live page. All tool calls go ` +
      `through ${EXECUTE_TOOL}.\n\n` +
      `STEP 1 — run this code verbatim (tool timeout 110000). It returns up to ${VERIFY_BATCH} postings, each with ` +
      `itemId, url, the values currently listed for it, and pageText (a live crawl of the URL) or fetchError:\n\n` +
      `<<<CODE\n${verifyFetchCode(where)}\nCODE\n\n` +
      `If it returns an empty list, there is nothing to check: return { written: 0, itemIds: [] }.\n\n` +
      `STEP 2 — for each posting, read pageText and record only what the page itself shows:\n` +
      `- live: true if the page is this specific role and still accepts applications; false if it says the role is ` +
      `closed, filled, or no longer available, or the page is a 404 or a generic careers/listing page with this role ` +
      `gone; null if pageText is missing or too thin to tell (a failed fetch is not evidence the job closed).\n` +
      `- pageSalaryMin / pageSalaryMax: the annual base salary range in USD exactly as the page states it, as plain ` +
      `numbers; null when the page gives none. Do not copy the listed values — report what you read.\n` +
      `- pageYoeMin: minimum years of experience the page asks for, or null.\n` +
      `- note: one short clause a job seeker would want (e.g. "range is for SF, NYC not stated", "requires clearance").\n\n` +
      `STEP 3 — record the checks by running this code with the CHECKS array filled in (change nothing else):\n\n` +
      `<<<CODE\n${verifyWriteCode}\nCODE\n\n` +
      `Return the \`written\` count and \`itemIds\` list exactly as that call returned them.`,
    { label, phase: 'Verify', schema: VERIFY_SCHEMA, model: MODEL_REASONING },
  )

if (VERIFY_TOP > 0 && census.uncheckedTop > 0) {
  phase('Verify')
  const toCheck = census.uncheckedTop
  // Round 1: fixed, non-overlapping slices of the ranked queue, in parallel.
  const slices = Math.ceil(Math.min(VERIFY_TOP, census.qualified) / VERIFY_BATCH)
  await parallel(Array.from({ length: slices }, (_, i) => () =>
    verifyAgent(`LIMIT ${VERIFY_BATCH} OFFSET ${i * VERIFY_BATCH}`, `verify:${i * VERIFY_BATCH + 1}-${(i + 1) * VERIFY_BATCH}`)))
  let after = await takeCensus('post-verify')
  // Round 2: whatever the census says is still unchecked, taken from the front
  // of the queue one batch at a time (sequential, so batches cannot collide).
  if (after && after.uncheckedTop > 0) {
    const retries = Math.ceil(after.uncheckedTop / VERIFY_BATCH)
    log(`${after.uncheckedTop} of the top postings still unchecked — ${retries} follow-up batch(es)`)
    for (let i = 0; i < retries; i++) await verifyAgent(`WHERE x.chk_id IS NULL LIMIT ${VERIFY_BATCH}`, `verify:retry${i + 1}`)
    after = await takeCensus('post-verify-retry')
  }
  if (after) {
    census = after
    log(`Verified ${toCheck - census.uncheckedTop}/${toCheck} top postings; ${census.uncheckedTop} left unchecked; tiers A/B/C now ${census.tierA}/${census.tierB}/${census.tierC}`)
  } else {
    log('Post-verify census failed — exporting against the pre-verify counts; the row-count assertion below may trip')
  }
} else if (VERIFY_TOP === 0) {
  log('verifyTop is 0 — skipping the liveness check; every row exports as posting_status "unchecked"')
}

// --- Export -------------------------------------------------------------------
// sqlite3 writes the CSV straight from the store, so no row is retyped by a
// model. Two things are asserted by this script: the SQL file on disk is
// byte-identical to EXPORT_SQL (cksum), and the CSV's data-row count equals the
// census taken through the MCP server by a different agent.
phase('Export')
const expectedSql = cksumOf(EXPORT_SQL)
let sqlWritten = false
for (let attempt = 1; attempt <= 3 && !sqlWritten; attempt++) {
  const w = await agent(
    `Using your Write tool, write EXACTLY the following content to "${SQL_PATH}" (relative to the current project ` +
      `directory, creating parent directories as needed; overwrite if it exists). Preserve every character and line ` +
      `verbatim, ending with a single trailing newline. The <<<SQL/SQL markers delimit the content and are not part of ` +
      `the file.\n\n<<<SQL\n${EXPORT_SQL}SQL\n\n` +
      `Then, with your Bash tool, run \`cksum "${SQL_PATH}"\` and report the first number it printed as cksumCrc and ` +
      `the second as bytes — the raw numbers, without judging whether they look right.`,
    { label: `write-sql${attempt > 1 ? `:retry${attempt}` : ''}`, phase: 'Export', schema: WRITE_SCHEMA, effort: 'low', model: MODEL_CHEAP },
  )
  sqlWritten = !!w && w.cksumCrc === expectedSql.crc && w.bytes === expectedSql.bytes
  if (!sqlWritten) log(`SQL file check failed (attempt ${attempt}/3): got crc=${w?.cksumCrc} bytes=${w?.bytes}, expected crc=${expectedSql.crc} bytes=${expectedSql.bytes}`)
}

let exported = null
let csvOk = false
if (sqlWritten) {
  for (let attempt = 1; attempt <= 2 && !csvOk; attempt++) {
    exported = await agent(
      `With your Bash tool, run exactly these commands from the project directory, one Bash call each:\n` +
        `  sqlite3 -readonly -header -csv "${DB_PATH}" < "${SQL_PATH}" > "${CSV_PATH}" 2> "${CSV_PATH}.err"; echo "exit=$?"\n` +
        `  wc -l < "${CSV_PATH}"\n` +
        `  cksum "${CSV_PATH}"\n` +
        `  head -c 300 "${CSV_PATH}.err"\n` +
        `Report exitCode (the number after exit=), lines (the wc number), cksumCrc and bytes (the first and second ` +
        `numbers cksum printed), and stderr (the head output, empty string if none). Raw values only — do not fix, ` +
        `rerun, or interpret anything.`,
      { label: `export-csv${attempt > 1 ? ':retry' : ''}`, phase: 'Export', schema: EXPORT_SCHEMA, effort: 'low', model: MODEL_CHEAP },
    )
    csvOk = !!exported && exported.exitCode === 0 && exported.lines === census.uniqueJobs + 1
    if (!csvOk) log(`CSV check failed (attempt ${attempt}/2): exit=${exported?.exitCode}, lines=${exported?.lines} (expected ${census.uniqueJobs + 1}), stderr=${String(exported?.stderr ?? '').slice(0, 200)}`)
  }
}
if (!csvOk) {
  log(`Export did not pass its checks. The data is safe in the store under source "${SRC}"; resuming this run only redoes the export. ` +
    `If the row count is short, the host's sqlite3 may not be seeing the container's un-checkpointed WAL at ${DB_PATH}.`)
}

return {
  runTag: TAG,
  stopReason,
  concurrency: { requested: CONCURRENCY, final: limit, backoffs },
  qualified: census.qualified,
  target: TARGET,
  census,
  shards: results,
  websetIds: results.filter((r) => r.websetId).map((r) => r.websetId),
  csvPath: CSV_PATH,
  sqlPath: SQL_PATH,
  csvWritten: csvOk,
  csvRows: csvOk ? exported.lines - 1 : null,
  csvCksum: csvOk ? { crc: exported.cksumCrc, bytes: exported.bytes } : null,
}
