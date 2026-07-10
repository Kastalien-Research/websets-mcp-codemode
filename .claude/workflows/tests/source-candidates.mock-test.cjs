// Mock harness for .claude/workflows/source-candidates.js — exercises the
// deterministic script logic behind the Greptile/Bugbot/Codex review fixes
// without any real agents. Write/assemble mocks report measurements from the
// REAL `cksum` binary over the exact prompt content, so the script's pure-JS
// POSIX cksum implementation is validated against the actual tool (including
// multi-byte UTF-8 via a unicode candidate name). Run from repo root:
//   node .claude/workflows/tests/source-candidates.mock-test.cjs
const fs = require('fs')
const { spawnSync } = require('child_process')

const SRC = fs
  .readFileSync('.claude/workflows/source-candidates.js', 'utf8')
  .replace('export const meta', 'const meta')

const AsyncFunction = async function () {}.constructor

function realCksum(content) {
  const r = spawnSync('cksum', [], { input: content })
  if (r.status !== 0) throw new Error(`cksum failed: ${r.stderr}`)
  const [crc, bytes] = r.stdout.toString().trim().split(/\s+/).map(Number)
  return { crc, bytes }
}

function makePipeline() {
  return async (items, ...stages) => {
    return Promise.all(
      items.map(async (item, idx) => {
        let acc = item
        for (const stage of stages) {
          try {
            acc = await stage(acc, item, idx)
          } catch {
            return null
          }
          if (acc === null || acc === undefined) return null
        }
        return acc
      }),
    )
  }
}

function makeParallel() {
  return async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)))
}

// Configurable agent mock, dispatching on opts.label.
function makeAgent(cfg, calls) {
  const written = {} // part filename → content, for faithful assemble emulation
  return async (prompt, opts = {}) => {
    const label = opts.label ?? '(none)'
    calls.push(label)
    if (label === 'collect') return cfg.collect
    if (label.startsWith('verify:')) {
      if (cfg.verifyNullOnce && label === `verify:${cfg.verifyNullOnce}`) return null // retry label differs, so only first pass nulls
      return `mock writeup for ${label}`
    }
    if (label.startsWith('verdict:')) {
      const itemId = /itemId "([^"]+)"/.exec(prompt)?.[1] ?? /itemId="([^"]+)"/.exec(prompt)?.[1]
      const name = /candidate "([^"]+)"/.exec(prompt)?.[1] ?? 'unknown'
      // include is always emitted true — the script must recompute it.
      return {
        itemId, name,
        identityConfirmed: cfg.identityUnconfirmedFor !== name,
        include: true, confidence: 0.9,
        criteria: [{
          index: 0, criterion: cfg.collect.criteria[0] ?? 'C0',
          verdict: cfg.missFor === name ? 'Miss' : cfg.unclearFor === name ? 'Unclear' : 'Match',
        }],
        enrichments: [], notes: 'ok',
      }
    }
    if (label.startsWith('persist:')) {
      const itemId = /itemId: '([^']+)'/.exec(prompt)?.[1]
      return { itemId, marked: true }
    }
    if (label.startsWith('write:')) {
      const content = /<<<PART\n([\s\S]*?)PART\n/.exec(prompt)?.[1] ?? ''
      const partName = label.replace(/^write:/, '').replace(/:retry\d+$/, '')
      written[partName] = content
      const m = realCksum(content)
      if (cfg.corruptPart && partName === cfg.corruptPart) return { cksumCrc: m.crc + 1, bytes: m.bytes }
      return { cksumCrc: m.crc, bytes: m.bytes }
    }
    if (label === 'assemble-csv') {
      const concat = (prefix) =>
        Object.keys(written).filter((k) => k.startsWith(prefix)).sort().map((k) => written[k]).join('')
      const v = realCksum(concat('v-'))
      const r = realCksum(concat('r-'))
      return { csvCrc: v.crc, csvBytes: v.bytes, rejectedCrc: r.crc, rejectedBytes: r.bytes }
    }
    if (label === 'report') return 'mock report'
    throw new Error(`mock agent: unhandled label ${label}`)
  }
}

async function run(args, cfg, agentOverride) {
  const calls = []
  const logs = []
  const base = makeAgent(cfg, calls)
  const agentFn = agentOverride ? (p, o) => agentOverride(p, o, base) : base
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'log', 'phase', 'args', 'budget', 'workflow', SRC)
  const result = await fn(
    agentFn, makeParallel(), makePipeline(),
    (m) => logs.push(m), () => {}, args,
    { total: null, spent: () => 0, remaining: () => Infinity }, () => {},
  )
  return { result, calls, logs }
}

const ITEMS = [
  { itemId: 'w1', name: 'Alice', url: 'https://x/a' },
  { itemId: 'w2', name: 'Bob', url: 'https://x/b' },
  { itemId: 'w3', name: 'Cara', url: 'https://x/c' },
  { itemId: 'w4', name: 'Miklós Horváth', url: 'https://x/d' }, // multi-byte UTF-8 exercises the JS cksum
]
const COLLECT_OK = { websetId: 'webset_test', criteria: ['C0 pub or OSS'], enrichmentColumns: ['E0 email'], items: ITEMS, truncated: false }

let failures = 0
function check(desc, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${desc}`)
  if (!cond) failures++
}

;(async () => {
  // --- Issue 1: hostile outputCsv rejected before any agent runs ---------------
  {
    const { result, calls } = await run(
      { websetId: 'webset_test', outputCsv: 'exports/x"; rm -rf ~; echo ".csv' },
      { collect: COLLECT_OK },
    )
    check('issue1: shell-metachar outputCsv returns error', !!result.error && /outputCsv/.test(result.error))
    check('issue1: rejected before any agent call', calls.length === 0)
    const traversal = await run({ websetId: 'webset_test', outputCsv: 'exports/../../etc/x.csv' }, { collect: COLLECT_OK })
    check('issue1: dot-dot path rejected', !!traversal.result.error)
    const spaced = await run(
      { websetId: 'webset_test', outputCsv: 'exports/letta candidates.csv' },
      { collect: COLLECT_OK },
    )
    check('issue1: benign path with space accepted (run completes)', !spaced.result.error && spaced.result.csvWritten === true)
  }

  // --- Issue 2: empty criteria from collect is fatal on a websetId resume ------
  {
    const { result } = await run(
      { websetId: 'webset_test' },
      { collect: { ...COLLECT_OK, criteria: [] } },
    )
    check('issue2: empty criteria → fatal error, no export', !!result.error && /criteri/i.test(result.error))
  }

  // --- Issue 3: a part failing all write attempts aborts with failedParts ------
  {
    const { result, calls } = await run(
      { websetId: 'webset_test' },
      { collect: COLLECT_OK, corruptPart: 'v-000.csv' },
    )
    check('issue3: failed part → error return', !!result.error && /part/i.test(result.error))
    check('issue3: failedParts names the part', Array.isArray(result.failedParts) && result.failedParts[0]?.includes('v-000'))
    check('issue3: verification counts preserved in error return', result.verified === 4 && result.persisted === 4)
    check('issue3: exactly MAX_WRITE_ATTEMPTS tries for the bad part',
      calls.filter((c) => c.startsWith('write:v-000')).length === 3)
    check('issue3: no assemble/report after failure', !calls.includes('assemble-csv'))
  }

  // --- Issue 4: dropped candidate retried once, counted; retry label distinct --
  {
    const { result, calls } = await run(
      { websetId: 'webset_test' },
      { collect: COLLECT_OK, verifyNullOnce: 'Bob' },
    )
    check('issue4: all 4 candidates verified after retry', result.verified === 4 && result.unverified.length === 0)
    check('issue4: retry used a :retry-suffixed label', calls.includes('verify:Bob:retry'))
    check('issue4: run completes with csvWritten', result.csvWritten === true)
  }

  // --- Issue 4b: candidate still dead after retry → reported, not silent -------
  {
    const { result } = await run(
      { websetId: 'webset_test' },
      { collect: COLLECT_OK },
      (p, o, base) => (o?.label?.startsWith('verify:Bob') ? null : base(p, o)),
    )
    check('issue4b: permanently-failing candidate lands in unverified',
      result.unverified?.length === 1 && result.unverified[0].name === 'Bob')
    check('issue4b: other candidates still exported', result.verified === 3 && result.csvWritten === true)
  }

  // --- Bugbot 1+4: script recomputes include; agent's include:true is ignored --
  {
    const { result } = await run(
      { websetId: 'webset_test' },
      { collect: COLLECT_OK, missFor: 'Bob' },
    )
    check('bug1+4: Miss criterion overrides agent include:true → rejected', result.rejected === 1 && result.validated === 3)
    const ident = await run(
      { websetId: 'webset_test' },
      { collect: COLLECT_OK, identityUnconfirmedFor: 'Cara' },
    )
    check('bug1+4: unconfirmed identity overrides agent include:true → rejected',
      ident.result.rejected === 1 && ident.result.validated === 3)
    const unclear = await run(
      { websetId: 'webset_test' },
      { collect: COLLECT_OK, unclearFor: 'Alice' },
    )
    check('bug1+4: Unclear criterion does NOT reject (recall policy)',
      unclear.result.validated === 4 && unclear.result.rejected === 0)
  }

  // --- Bugbot 2: truncated ingestion is surfaced, not silent -------------------
  {
    const { result, logs } = await run(
      { websetId: 'webset_test' },
      { collect: { ...COLLECT_OK, truncated: true } },
    )
    check('bug2: ingestTruncated surfaced in return', result.ingestTruncated === true)
    check('bug2: truncation warning logged', logs.some((l) => /maxItems cap/.test(l)))
  }

  // --- Bugbot 5: empty toVerify still reports real found counts ----------------
  {
    const { result } = await run(
      { websetId: 'webset_test', maxVerify: 0 },
      { collect: COLLECT_OK },
    )
    check('bug5: maxVerify=0 reports found=4, not 0', result.found === 4 && result.uniqueCandidates === 4 && result.verified === 0)
  }

  // --- Codex 2: assembled-file CRC mismatch → csvWritten false -----------------
  {
    const { result } = await run(
      { websetId: 'webset_test' },
      { collect: COLLECT_OK },
      (p, o, base) =>
        o?.label === 'assemble-csv'
          ? base(p, o).then((m) => ({ ...m, csvCrc: m.csvCrc + 1 })) // same bytes, one bit of content difference
          : base(p, o),
    )
    check('codex2: assembled CRC mismatch (same byte count) → csvWritten=false', result.csvWritten === false)
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
})()
