// Contract orchestrator CLI.
//
//   npx tsx contracts/temporal-snapshot/run.ts <command>
//
//   render                 write CONTRACT.md from contract.ts
//   status [--working-tree] compute the current state (default: isolated worktree of HEAD)
//   lock                   verify S0 at HEAD, record the baseline and the contract hash
//   amend --reason "..."   record a deliberate change to the contract files
//   check-lock <T>         pin the target state's check file before implementing <T>
//   advance <T>            verify HEAD in isolation and record the transition if every boundary holds
//   grade <T>              run the soft criteria for an advanced transition (needs ANTHROPIC_API_KEY)
//   probe <search|contents> --as-of <iso> --purpose "..." [--out file]
//                          one sanctioned live Snapshot request, recorded as spend
//
// Commits written by this tool touch only the contract directory. Set
// CONTRACT_COMMIT_TRAILER to append a trailer to their messages.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import {
  CRITERIA,
  GLOBAL_INVARIANTS,
  SNAPSHOT_SPEND_LIMIT,
  STATES,
  STATE_CHECK_FILES,
} from './contract.js';
import { computeState, holds, TRANSITION_IDS, type TransitionId, type Verdict } from './kernel.js';
import {
  CONTRACT_DIR,
  LEDGER_PATH,
  appendLedger,
  commitPaths,
  contractHash,
  fileHash,
  git,
  isClean,
  processVerdicts,
  readLedger,
  recordedState,
  repoRoot,
  runVerifier,
  transition,
  withWorktree,
  type VerifyOutput,
} from './process.js';
import { renderContract } from './render.js';

const root = repoRoot();
const now = () => new Date().toISOString();

function usage(message: string): never {
  console.error(message);
  process.exit(2);
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function transitionArg(): TransitionId {
  const id = process.argv[3] as TransitionId;
  if (!TRANSITION_IDS.includes(id)) usage(`expected a transition id (${TRANSITION_IDS.join(', ')})`);
  return id;
}

function requireClean(): void {
  if (!isClean(root)) usage('working tree has uncommitted changes to tracked files; commit or stash them first');
}

function printVerdicts(verdicts: Verdict[]): void {
  for (const v of verdicts) {
    const mark = v.status === 'pass' ? 'PASS' : v.status.toUpperCase();
    console.log(`  ${mark.padEnd(7)} ${v.id.padEnd(5)} ${v.evidence.split('\n')[0].slice(0, 160)}`);
  }
}

function report(out: VerifyOutput): ReturnType<typeof computeState> {
  const byId = new Map(out.verdicts.map(v => [v.id, v]));
  const result = computeState(STATES, GLOBAL_INVARIANTS, byId);
  console.log(`\nComputed state: ${result.state ?? 'outside the contract (a global invariant fails)'}`);
  console.log('\nGlobal invariants:');
  printVerdicts(out.verdicts.filter(v => v.id.startsWith('G')));
  for (const state of STATES.filter(s => s.invariants.length > 0)) {
    console.log(`\n${state.id} ${state.name}:`);
    printVerdicts(state.invariants.map(i => byId.get(i.id) ?? { id: i.id, status: 'pending', evidence: 'not evaluated' }));
  }
  return result;
}

async function main() {
  const command = process.argv[2];
  switch (command) {
    case 'render': {
      writeFileSync(join(root, CONTRACT_DIR, 'CONTRACT.md'), renderContract());
      console.log(`wrote ${CONTRACT_DIR}/CONTRACT.md`);
      return;
    }

    case 'status': {
      const ledger = readLedger(root);
      const recorded = recordedState(ledger);
      console.log(`Recorded state (ledger): ${recorded ? `${recorded.state} at ${recorded.commit.slice(0, 8)}` : 'not locked'}`);
      if (process.argv.includes('--working-tree')) {
        console.log('Verifying the working tree in place (not valid for advancing).');
        report(runVerifier(root, 'check'));
        return;
      }
      const head = git(root, ['rev-parse', 'HEAD']);
      console.log(`Verifying an isolated worktree of HEAD ${head.slice(0, 8)}.`);
      report(withWorktree(root, head, dir => runVerifier(dir, 'check')));
      return;
    }

    case 'lock': {
      requireClean();
      if (readLedger(root).some(e => e.type === 'lock')) usage('already locked; use `amend` to change the contract');
      const head = git(root, ['rev-parse', 'HEAD']);
      const out = withWorktree(root, head, dir => runVerifier(dir, 'lock'));
      const globals = out.verdicts.filter(v => v.id.startsWith('G') && v.id !== 'G5');
      printVerdicts(out.verdicts.filter(v => v.id.startsWith('G')));
      const g5 = out.verdicts.find(v => v.id === 'G5');
      if (!globals.every(holds) || !g5 || !holds(g5) || !out.measuredBaseline) {
        usage('S0 does not hold at HEAD; refusing to lock');
      }
      const baseline = { commit: head, ...out.measuredBaseline };
      mkdirSync(join(root, CONTRACT_DIR, 'fixtures'), { recursive: true });
      writeFileSync(join(root, CONTRACT_DIR, 'fixtures', 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);
      const hash = contractHash(root);
      appendLedger(root, { type: 'lock', at: now(), commit: head, contractHash: hash });
      const commit = commitPaths(root, [`${CONTRACT_DIR}/fixtures/baseline.json`, LEDGER_PATH], 'contract(temporal-snapshot): lock S0');
      console.log(`\nLocked S0 at ${head.slice(0, 8)} (contract ${hash.slice(0, 12)}), recorded in ${commit.slice(0, 8)}.`);
      return;
    }

    case 'amend': {
      requireClean();
      const reason = option('reason') ?? usage('--reason is required');
      const ledger = readLedger(root);
      const previous = [...ledger].reverse().find(e => e.type === 'lock' || e.type === 'amend');
      if (!previous || !('contractHash' in previous)) usage('not locked');
      const hash = contractHash(root);
      if (hash === previous.contractHash) usage('contract files are unchanged; nothing to amend');
      const head = git(root, ['rev-parse', 'HEAD']);
      appendLedger(root, { type: 'amend', at: now(), commit: head, contractHash: hash, previousHash: previous.contractHash, reason });
      commitPaths(root, [LEDGER_PATH], `contract(temporal-snapshot): amend (${reason})`);
      console.log(`Amended: ${previous.contractHash.slice(0, 12)} -> ${hash.slice(0, 12)}`);
      return;
    }

    case 'check-lock': {
      requireClean();
      const t = transition(transitionArg());
      const file = STATE_CHECK_FILES[t.to];
      const hash = fileHash(root, file) ?? usage(`${file} does not exist`);
      if (git(root, ['ls-files', file]) === '') usage(`${file} is not committed`);
      const head = git(root, ['rev-parse', 'HEAD']);
      appendLedger(root, { type: 'check-lock', at: now(), transition: t.id, file, hash, commit: head });
      commitPaths(root, [LEDGER_PATH], `contract(temporal-snapshot): check-lock ${t.id} (${file.split('/').pop()})`);
      console.log(`Pinned ${file} (${hash.slice(0, 12)}) for ${t.id}.`);
      return;
    }

    case 'advance': {
      requireClean();
      const t = transition(transitionArg());
      const head = git(root, ['rev-parse', 'HEAD']);
      const { out, processResults, hash } = withWorktree(root, head, dir => ({
        out: runVerifier(dir, 'check'),
        processResults: processVerdicts(root, dir, head, t, true),
        hash: contractHash(dir),
      }));
      const computed = report(out);
      console.log('\nProcess invariants:');
      printVerdicts(processResults);

      const targetIdx = STATES.findIndex(s => s.id === t.to);
      const required = [
        ...GLOBAL_INVARIANTS.map(i => i.id),
        ...STATES.slice(1, targetIdx + 1).flatMap(s => s.invariants.map(i => i.id)),
      ];
      const byId = new Map(out.verdicts.map(v => [v.id, v]));
      const blockers = [
        ...required.map(id => byId.get(id) ?? { id, status: 'pending' as const, evidence: 'not evaluated' }),
        ...processResults,
      ].filter(v => !holds(v));
      if (blockers.length > 0) {
        console.error(`\n${t.id} blocked by ${blockers.map(v => v.id).join(', ')}. Nothing recorded.`);
        process.exit(1);
      }
      const base = recordedState(readLedger(root))!.commit;
      appendLedger(root, {
        type: 'advance', at: now(), transition: t.id, from: t.from, to: t.to, base, head,
        contractHash: hash, verdicts: [...out.verdicts.filter(v => required.includes(v.id)), ...processResults],
      });
      commitPaths(root, [LEDGER_PATH], `contract(temporal-snapshot): advance ${t.id} ${t.from} -> ${t.to}`);
      console.log(`\nAdvanced ${t.from} -> ${t.to} (computed state ${computed.state}). Run \`grade ${t.id}\` for the soft criteria.`);
      return;
    }

    case 'grade': {
      requireClean();
      loadDotenv({ path: join(root, '.env'), quiet: true });
      if (!process.env.ANTHROPIC_API_KEY) usage('ANTHROPIC_API_KEY is not set (add it to .env)');
      const t = transition(transitionArg());
      const advance = [...readLedger(root)].reverse().find(e => e.type === 'advance' && e.transition === t.id);
      if (!advance || advance.type !== 'advance') usage(`${t.id} has not been advanced`);
      const { gradeTransition, JUDGE_MODEL } = await import('./judge.js');
      const criteria = CRITERIA.filter(c => c.transitions === '*' || c.transitions.includes(t.id));
      const graded = await withWorktree(root, advance.head, async dir => {
        mkdirSync(join(dir, '.contract-evidence'), { recursive: true });
        writeFileSync(join(dir, '.contract-evidence', 'diff.patch'), git(root, ['diff', `${advance.base}..${advance.head}`]));
        writeFileSync(join(dir, '.contract-evidence', 'verdicts.json'), JSON.stringify(advance.verdicts, null, 2));
        return gradeTransition(criteria, t.to, t.id, dir);
      });
      for (const r of graded.results) {
        console.log(`  ${r.id.padEnd(28)} ${r.status === 'scored' ? r.score!.toFixed(2) : 'ungraded'}  w=${r.weight}  $${r.costUsd.toFixed(2)}${r.error ? `  (${r.error})` : ''}`);
      }
      console.log(`Aggregate (advisory): ${graded.aggregate === null ? 'n/a' : graded.aggregate.toFixed(3)}  cost $${graded.costUsd.toFixed(2)}`);
      appendLedger(root, {
        type: 'grade', at: now(), transition: t.id, head: advance.head, model: JUDGE_MODEL,
        aggregate: graded.aggregate, costUsd: graded.costUsd, results: graded.results,
      });
      commitPaths(root, [LEDGER_PATH], `contract(temporal-snapshot): grade ${t.id}`);
      return;
    }

    case 'probe': {
      loadDotenv({ path: join(root, '.env'), quiet: true });
      const endpoint = process.argv[3];
      const asOf = option('as-of') ?? usage('--as-of is required');
      const purpose = option('purpose') ?? usage('--purpose is required');
      if (endpoint !== 'search' && endpoint !== 'contents') usage('probe target must be search or contents');
      const spent = readLedger(root).filter(e => e.type === 'spend').length;
      if (spent >= SNAPSHOT_SPEND_LIMIT) usage(`spend limit reached (${spent}/${SNAPSHOT_SPEND_LIMIT})`);
      const { Exa } = await import('exa-js');
      const exa = new Exa(process.env.EXA_API_KEY);
      const response = endpoint === 'search'
        ? await exa.search(option('query') ?? 'latest stable Python release notes', {
          numResults: 2, contents: { snapshotAsOf: asOf, highlights: true },
        } as any)
        : await exa.getContents([option('url') ?? 'https://docs.python.org/3/whatsnew/changelog.html'], {
          snapshotAsOf: asOf, text: { maxCharacters: 2000 },
        } as any);
      appendLedger(root, {
        type: 'spend', at: now(), endpoint, snapshotAsOf: asOf,
        requestId: (response as { requestId?: string }).requestId ?? null, purpose,
      });
      const outFile = option('out');
      if (outFile) writeFileSync(join(root, outFile), `${JSON.stringify(response, null, 2)}\n`);
      else console.log(JSON.stringify(response, null, 2));
      console.log(`Recorded spend ${spent + 1}/${SNAPSHOT_SPEND_LIMIT}. Commit ${LEDGER_PATH} with the fixture.`);
      return;
    }

    default:
      usage('commands: render | status [--working-tree] | lock | amend --reason | check-lock <T> | advance <T> | grade <T> | probe');
  }
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err);
    process.exit(2);
  },
);
