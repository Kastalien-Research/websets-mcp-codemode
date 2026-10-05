// Renders contract.ts as CONTRACT.md. G5 requires the committed file to match
// this output exactly, so the markdown can never drift from what is enforced.

import {
  ALLOWED_REMOVALS,
  ALWAYS_ALLOWED,
  CONTRACT_ID,
  CONTRACT_VERSION,
  CRITERIA,
  GLOBAL_INVARIANTS,
  PROCESS_INVARIANTS,
  SNAPSHOT_SPEND_LIMIT,
  STATES,
  TRANSITIONS,
} from './contract.js';
import type { Invariant } from './kernel.js';

const invariantTable = (invariants: Invariant[]): string[] => [
  '| ID | Statement | Checked by |',
  '|---|---|---|',
  ...invariants.map(i => `| ${i.id} | ${i.statement} | ${i.checkedBy} |`),
];

export function renderContract(): string {
  const lines: string[] = [
    `# Contract: ${CONTRACT_ID} (v${CONTRACT_VERSION})`,
    '',
    '<!-- Generated from contract.ts by `run.ts render`. Do not edit by hand (invariant G5). -->',
    '',
    'This contract takes the server from S0 (today) to S5 (terminal) through five transitions.',
    'Invariants are hard boundaries decided by deterministic code; criteria are soft, judged by',
    'an isolated Claude Agent SDK judge, recorded in the ledger, and never block a transition.',
    '',
    '## How state is decided',
    '',
    '- The current state is computed, never declared: S0 holds when every global invariant passes;',
    '  Sk holds when S0 holds and every invariant of S1..Sk passes.',
    '- Invariants ratchet: once required, they stay required in every later state.',
    '- A missing or crashing check counts as a failure.',
    '- Advances run in a fresh worktree of a committed HEAD and are recorded in the append-only',
    '  `ledger.jsonl`, together with the contract hash that judged them.',
    '',
    '## Global invariants (every state)',
    '',
    ...invariantTable(GLOBAL_INVARIANTS),
    '',
    `Allowed removals: ${ALLOWED_REMOVALS.map(o => `\`${o}\``).join(', ')}.`,
    '',
    '## Process invariants (across transitions)',
    '',
    ...invariantTable(PROCESS_INVARIANTS),
    '',
    `Live Snapshot spend limit for contract tooling: ${SNAPSHOT_SPEND_LIMIT} requests.`,
    '',
    '## States',
    '',
  ];

  for (const state of STATES) {
    lines.push(`### ${state.id}: ${state.name}${state.terminal ? ' (terminal)' : ''}`, '', state.summary, '');
    if (state.invariants.length > 0) lines.push(...invariantTable(state.invariants), '');
  }

  lines.push('## Transitions', '', '| ID | From | To | May change |', '|---|---|---|---|');
  for (const t of TRANSITIONS) {
    lines.push(`| ${t.id} | ${t.from} | ${t.to} | ${t.scope.map(s => `\`${s}\``).join(', ')} |`);
  }
  lines.push('', `Every transition may also change: ${ALWAYS_ALLOWED.map(s => `\`${s}\``).join(', ')}.`, '');

  lines.push('## Soft criteria (advisory)', '', '| ID | Applies to | Weight | Kind | What is judged |', '|---|---|---|---|---|');
  for (const c of CRITERIA) {
    const applies = c.transitions === '*' ? 'every transition' : c.transitions.join(', ');
    const what = c.kind === 'review'
      ? c.question
      : `A fresh model sees only \`${c.artifact}\` and answers: ${c.questions.map(q => `"${q.ask}"`).join(' ')}`;
    lines.push(`| ${c.id} | ${applies} | ${c.weight} | ${c.kind} | ${what} |`);
  }
  lines.push('');
  return lines.join('\n');
}
