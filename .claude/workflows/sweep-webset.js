export const meta = {
  name: 'sweep-webset',
  description: 'Batch verify→research→annotate every uninvestigated Webset item (resumable, cross-checked)',
  whenToUse:
    'Clear a backlog of uninvestigated Webset items in one resumable run instead of reacting one channel event at a time. Pass {websetId} to scope to a webset, {items:[...]} to sweep a specific set, or nothing to sweep everything uninvestigated.',
  phases: [
    { title: 'Discover', detail: 'store.listUninvestigated → work list' },
    { title: 'Verify', detail: 'independent Exa verification per item (verify-item logic)' },
    { title: 'Research', detail: 'deep research + store.annotate for items that clear the bar' },
    { title: 'Mark', detail: 'write the judgment annotation that clears the item from the backlog' },
    { title: 'Synthesize', detail: 'one cited report over the sweep' },
  ],
}

// --- Tunables (override via args) -------------------------------------------
// confidenceThreshold: items at/above this verdict confidence get deep research;
// below it they're annotated as low-confidence and skipped (cost control).
const THRESHOLD = args?.confidenceThreshold ?? 0.7
const LIMIT = args?.limit ?? 50

// The websets Code-Mode execute tool the agents drive. Agents call it with
// callOperation('<op>', {...}). Kept in one place so it's easy to retarget.
const EXECUTE_TOOL = 'the websets `execute` MCP tool (mcp__schwartz13-local__execute), calling callOperation(...) inside it'

// --- Schemas ----------------------------------------------------------------
const DISCOVER_SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['itemId', 'entity'],
        properties: {
          itemId: { type: 'string' },
          websetId: { type: 'string' },
          entity: { type: 'string' },
          domain: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['itemId', 'entity', 'overallVerdict', 'confidence'],
  properties: {
    itemId: { type: 'string' },
    entity: { type: 'string' },
    overallVerdict: { type: 'string', enum: ['confirmed', 'plausible', 'disputed'] },
    confidence: { type: 'number' },
    discrepancies: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const RESEARCH_SCHEMA = {
  type: 'object',
  required: ['hook', 'summary'],
  properties: {
    hook: { type: 'string' },
    summary: { type: 'string' },
  },
}

const MARK_SCHEMA = {
  type: 'object',
  required: ['itemId', 'marked'],
  properties: {
    itemId: { type: 'string' },
    marked: { type: 'boolean' },
  },
}

// --- Phase 1: Discover the work list ----------------------------------------
phase('Discover')

let workItems = args?.items
if (!Array.isArray(workItems) || workItems.length === 0) {
  const scopeNote = args?.websetId
    ? `Scope to websetId "${args.websetId}".`
    : 'No webset scope was given — list across all websets.'
  const discovery = await agent(
    `Discover uninvestigated Webset items to sweep. Using ${EXECUTE_TOOL}, run:\n\n` +
      `  callOperation('store.listUninvestigated', { ${args?.websetId ? `websetId: '${args.websetId}', ` : ''}limit: ${LIMIT} })\n\n` +
      `${scopeNote} Return each item's itemId, its websetId, the entity name, and the domain/URL if present. ` +
      `Return ONLY items not yet investigated — do not fabricate any.`,
    { label: 'discover', phase: 'Discover', schema: DISCOVER_SCHEMA },
  )
  workItems = discovery?.items ?? []
}

log(`Sweeping ${workItems.length} item(s) — confidence gate ${THRESHOLD}`)
if (workItems.length === 0) {
  return { swept: 0, note: 'No uninvestigated items found for the given scope.' }
}

// --- Phases 2+3: Verify → Research, pipelined per item -----------------------
// pipeline() runs each item through both stages independently: item A can be in
// Research while item B is still in Verify — no barrier, no wasted wall-clock.
// agentType is intentionally omitted: verification-judge/scout currently lack the
// MCP `execute` tool in their allowlists, so the persona is baked into the prompt
// instead. Wire {agentType:'verification-judge'} here once that agent is granted
// the websets execute/search MCP tools.
const swept = await pipeline(
  workItems,

  // Stage 1 — Verify (mirrors the /verify-item skill procedure)
  (item) =>
    agent(
      `You are an independent verification judge. Verify the enrichments for Webset item "${item.itemId}"` +
        `${item.websetId ? ` in webset "${item.websetId}"` : ''} (entity: "${item.entity}").\n\n` +
        `Procedure (the /verify-item skill):\n` +
        `1. Using ${EXECUTE_TOOL}, fetch the item: callOperation('items.get', { id: '${item.itemId}'${item.websetId ? `, websetId: '${item.websetId}'` : ''} }).\n` +
        `2. For EACH enrichment claim (email, phone, description, URL), run an INDEPENDENT Exa search via callOperation('exa.search', ...) / callOperation('exa.getContents', ...). Do not trust the enriched value — corroborate it from a separate public source.\n` +
        `3. Classify each enrichment: confirmed | plausible | disputed | unverifiable.\n` +
        `4. Produce an overallVerdict and a confidence in [0,1]. Be skeptical: when independent corroboration is missing, confidence should be low, not generous.`,
      { label: `verify:${item.entity}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ),

  // Stage 2 — Research the survivors; low-confidence items pass straight through.
  // No judgment write here: marking is its own deterministic stage (3) below, so a
  // research-busy agent that forgets a bookkeeping call can't strand the item in
  // the backlog. The live run on 2026-06-03 caught exactly that failure mode.
  (verdict, item) => {
    if (!verdict) return null // stage 1 errored → drop this item
    const passed = verdict.confidence >= THRESHOLD && verdict.overallVerdict !== 'disputed'
    if (!passed) {
      // Below the bar: no research, but still flow into the Mark stage so it's cleared.
      return { itemId: item.itemId, entity: item.entity, verdict, researched: false,
        hook: '', summary: `skipped: ${verdict.overallVerdict} @ ${verdict.confidence}` }
    }
    return agent(
      `Entity "${item.entity}" passed verification (${verdict.overallVerdict} @ ${verdict.confidence}). ` +
        `Run deep research and persist the findings.\n\n` +
        `Procedure (the /deep-research-item skill), all via ${EXECUTE_TOOL}:\n` +
        `1. Parallel Exa searches on funding, tech stack, hiring, recent news, and findSimilar for "${item.entity}"${item.domain ? ` (domain ${item.domain})` : ''}.\n` +
        `2. exa.getContents on the top 3-5 URLs; extract decision-makers, tech choices, recent milestones.\n` +
        `3. Buyer mapping (primary contact, role fit) and an angle (hook / value-prop / risk).\n` +
        `4. Persist findings: callOperation('store.annotate', { itemId: '${item.itemId}', type: 'research', value: <JSON-stringified findings>, source: 'sweep-webset' }).\n` +
        `Return the one-line hook and a short summary of the findings.`,
      { label: `research:${item.entity}`, phase: 'Research', schema: RESEARCH_SCHEMA },
    ).then((r) =>
      r ? { ...r, itemId: item.itemId, entity: item.entity, verdict, researched: true } : null,
    )
  },

  // Stage 3 — Mark investigated (deterministic, single call). This is the ONLY place
  // the 'judgment' annotation is written, and it's what actually clears the item from
  // store.listUninvestigated (db.ts getUninvestigatedItems keys on a 'judgment' row).
  // Isolated into one trivial call so it can't be skipped by an agent busy researching.
  (res, item) => {
    if (!res) return null
    const judgment = res.researched
      ? { verdict: 'researched', confidence: res.verdict.confidence }
      : { verdict: res.verdict.overallVerdict, confidence: res.verdict.confidence, action: 'skipped-below-threshold' }
    return agent(
      `Make EXACTLY ONE tool call and nothing else, using ${EXECUTE_TOOL}:\n` +
        `  callOperation('store.annotate', { itemId: '${item.itemId}', type: 'judgment', value: ${JSON.stringify(
          JSON.stringify(judgment),
        )}, source: 'sweep-webset' })\n` +
        `This marks the item investigated so it leaves the uninvestigated backlog. ` +
        `Do not research or call anything else. Return { itemId: '${item.itemId}', marked: true }.`,
      { label: `mark:${item.entity}`, phase: 'Mark', schema: MARK_SCHEMA },
    ).then((m) => ({ ...res, marked: !!(m && m.marked) }))
  },
)

const results = swept.filter(Boolean)
const researched = results.filter((r) => r.researched)

// --- Phase 4: Synthesize ----------------------------------------------------
phase('Synthesize')
let report = ''
if (researched.length > 0) {
  report = await agent(
    `Write a concise sweep report over these researched Webset entities. For each, give the entity, the hook ` +
      `(why it's timely), and the value angle. Group by strength and call out anything worth acting on now.\n\n` +
      JSON.stringify(researched, null, 2),
    { label: 'synthesize', phase: 'Synthesize' },
  )
}

return {
  swept: workItems.length,
  verified: results.length,
  researched: researched.length,
  skipped: results.length - researched.length,
  marked: results.filter((r) => r.marked).length, // items actually cleared from the backlog
  report,
  items: results,
}
