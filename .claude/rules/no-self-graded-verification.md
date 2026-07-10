## No Self-Graded Verification

An agent that produces an artifact must not be the one who decides whether that artifact is
correct. This is a specific application of "make illegal states unrepresentable" (see CLAUDE.md
Agent Guidance): a pass/fail boolean asserted by the same actor that could have caused the
failure is not evidence, because an actor unreliable enough to corrupt its own output is not
reliably more honest when grading it.

### What went wrong (2026-07-10)

`source-candidates.js`'s CSV export had a write agent report `{ written: true }` after running its
own `wc -l` / `grep` checks. It silently replaced 4/100 candidate rows with a stray `</content>`
line — same line count as expected, corrupted content — and still reported success. The boolean
was never independently checked; the workflow's own return value (`csvWritten: true`) was false.

### The rule

When a workflow step needs to confirm an agent's work succeeded:

1. **The agent reports raw, unopinionated measurements** — a count, a hash, a literal command
   output — never a self-computed verdict like `success`, `written`, `valid`, or `ok`.
2. **A different actor decides pass/fail.** Prefer deterministic script code (a plain equality or
   comparison the workflow script computes against an expected value it already knows) over
   another LLM call. If an LLM must judge, use a *different* agent invocation than the one that
   produced the artifact — never let one agent both act and grade itself in the same call.
3. **Retries are driven by the checker, not the actor.** Don't ask the producing agent to
   "retry until it's right" internally — that's still self-supervision. Loop in the calling
   script instead (see the Populate poll loop and `writePartVerified` in
   `.claude/workflows/source-candidates.js` for the pattern).

### Applying this

Any new workflow script with a "have an agent write/produce X, then confirm it worked" step should
follow the `writePartVerified` shape: schema requires only measurable facts, the script asserts
against expected values, and a bounded script-driven retry re-invokes a fresh agent call on
failure. This does not make corruption impossible — an agent can still misreport its own raw
numbers — but it closes the specific loophole where an unreliable actor can talk its way past a
check by asserting success rather than reporting facts.
