// Mock harness for .claude/workflows/source-candidates.js — exercises the
// deterministic script logic behind the four Greptile fixes without any real
// agents. Run: node .scratch/test-source-candidates.js
const fs = require('fs')

const SRC = fs
  .readFileSync('.claude/workflows/source-candidates.js', 'utf8')
  .replace('export const meta', 'const meta')

const AsyncFunction = async function () {}.constructor

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
      return {
        itemId, name, identityConfirmed: true, include: true, confidence: 0.9,
        criteria: [{ index: 0, criterion: cfg.collect.criteria[0] ?? 'C0', verdict: 'Match' }],
        enrichments: [], notes: 'ok',
      }
    }
    if (label.startsWith('persist:')) {
      const itemId = /itemId: '([^']+)'/.exec(prompt)?.[1]
      return { itemId, marked: true }
    }
    if (label.startsWith('write:')) {
      const content = /<<<PART\n([\s\S]*?)PART\n/.exec(prompt)?.[1] ?? ''
      const lines = content.split('\n').filter((l) => l.length > 0).length
      const partName = label.replace(/^write:/, '').replace(/:retry\d+$/, '')
      if (cfg.corruptPart && partName === cfg.corruptPart) return { linesWritten: lines - 1, tagMatches: 0 }
      return { linesWritten: lines, tagMatches: 0 }
    }
    if (label === 'assemble-csv') return { linesWritten: cfg.expectedTotalLines, tagMatches: 0 }
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
]
const COLLECT_OK = { websetId: 'webset_test', criteria: ['C0 pub or OSS'], enrichmentColumns: ['E0 email'], items: ITEMS }

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
      { collect: COLLECT_OK, expectedTotalLines: 0 },
    )
    check('issue1: shell-metachar outputCsv returns error', !!result.error && /outputCsv/.test(result.error))
    check('issue1: rejected before any agent call', calls.length === 0)
    const traversal = await run({ websetId: 'webset_test', outputCsv: 'exports/../../etc/x.csv' }, { collect: COLLECT_OK, expectedTotalLines: 0 })
    check('issue1: dot-dot path rejected', !!traversal.result.error)
    const spaced = await run(
      { websetId: 'webset_test', outputCsv: 'exports/letta candidates.csv' },
      { collect: COLLECT_OK, expectedTotalLines: 5 },
    )
    check('issue1: benign path with space accepted (run completes)', !spaced.result.error && spaced.result.csvWritten === true)
  }

  // --- Issue 2: empty criteria from collect is fatal on a websetId resume ------
  {
    const { result } = await run(
      { websetId: 'webset_test' },
      { collect: { ...COLLECT_OK, criteria: [] }, expectedTotalLines: 5 },
    )
    check('issue2: empty criteria → fatal error, no export', !!result.error && /criteri/i.test(result.error))
  }

  // --- Issue 3: a part failing all write attempts aborts with failedParts ------
  {
    const { result, calls } = await run(
      { websetId: 'webset_test' },
      { collect: COLLECT_OK, corruptPart: 'v-000.csv', expectedTotalLines: 5 },
    )
    check('issue3: failed part → error return', !!result.error && /part/i.test(result.error))
    check('issue3: failedParts names the part', Array.isArray(result.failedParts) && result.failedParts[0]?.includes('v-000'))
    check('issue3: verification counts preserved in error return', result.verified === 3 && result.persisted === 3)
    check('issue3: exactly MAX_WRITE_ATTEMPTS tries for the bad part',
      calls.filter((c) => c.startsWith('write:v-000')).length === 3)
    check('issue3: no assemble/report after failure', !calls.includes('assemble-csv'))
  }

  // --- Issue 4: dropped candidate retried once, counted; retry label distinct --
  {
    const { result, calls } = await run(
      { websetId: 'webset_test' },
      { collect: COLLECT_OK, verifyNullOnce: 'Bob', expectedTotalLines: 5 },
    )
    check('issue4: all 3 candidates verified after retry', result.verified === 3 && result.unverified.length === 0)
    check('issue4: retry used a :retry-suffixed label', calls.includes('verify:Bob:retry'))
    check('issue4: run completes with csvWritten', result.csvWritten === true)
  }

  // --- Issue 4b: candidate still dead after retry → reported, not silent -------
  {
    const { result } = await run(
      { websetId: 'webset_test' },
      { collect: COLLECT_OK, expectedTotalLines: 4 }, // 2 validated rows + header + rejected header
      (p, o, base) => (o?.label?.startsWith('verify:Bob') ? null : base(p, o)),
    )
    check('issue4b: permanently-failing candidate lands in unverified',
      result.unverified?.length === 1 && result.unverified[0].name === 'Bob')
    check('issue4b: other candidates still exported', result.verified === 2 && result.csvWritten === true)
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
})()
