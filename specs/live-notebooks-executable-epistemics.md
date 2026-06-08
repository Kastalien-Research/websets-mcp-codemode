# Live Notebooks — Executable Epistemic Documents

**Status:** Exploration / concept dump
**Author:** Claude (Thoughtbox-driven, 202-thought reasoning chain) + user
**Date:** 2026-06-02
**Branch:** feat/agent-runs-handler

> This document is the distilled output of a long sequential-reasoning session
> (Thoughtbox session `86c94e8f`, 202 thoughts) dreaming up implementations of a
> `notebook.*` domain for this Code Mode MCP server. It is exploratory — it
> prizes novelty and conceptual elegance over shippability. Treat the *axioms*,
> *primitives*, and *build-first three* as load-bearing; treat the concept
> catalog as a menu, not a roadmap.

---

## The substrate

A **notebook** is a first-class domain (`notebook.*`) in this server. Physically
it is a plain Srcbook `.src.md` file: markdown prose cells + runnable code cells
+ a `package.json` cell. Portable, human-legible, opens in a TypeScript notebook
UI.

The key trick: **a notebook code cell's source is itself Code Mode** — JavaScript
with `callOperation('domain.op', args)` in scope. So a notebook is a *persisted,
re-runnable execution session*. Re-running a cell fetches fresh real-world
evidence (Exa Websets). The notebook is simultaneously the **document**, the
**program**, and the **audit trail**.

It carries a light typed spine by convention (not a heavy runtime). The original
proposal was `Thesis → Evidence-For → Evidence-Against → Verdict → Run-log`, with
reruns appending dated Run sections to form a **verdict timeline**. This document
keeps that as the common case but argues the real spine is more general (see
[The spine, reconsidered](#the-spine-reconsidered)).

---

## The why (the hook)

**The Inert-Log Problem.** Every chain-of-thought, analyst memo, and research doc
ever written — *including the 202-thought session that produced this file* — is a
frozen claim about a world that kept moving. Not one of those thoughts can re-run
itself tomorrow and tell you which have gone stale.

**A live notebook is the first format that refuses to freeze: a reasoning session
that kept its right to be checked.**

The one-liner for the cover: *a reasoning log is a photograph of a mind; this is a
living thing you can also pocket as a photograph — alive AND auditable, portable
AND live.*

---

## The two axioms

**A0 — A claim is a live typed object, not a string.** The minimum viable
claim-object is `{normalized_text, epistemic_shape, evidence_set_hash,
current_verdict, freshness, falsifiers, derivation}`. Any system that treats
claims as substrings (most RAG, free-form reasoning logs, naive claim-extractors)
is building on sand. *This insight came from invoking Thoughtbox's own
claim-extractor peer on the concept list mid-session — it shattered a `.src.md`
line into three garbage fragments, a live demo of exactly the problem this
substrate solves.*

**A1 — Core/shell split with frozen facts.** Every notebook has two strata:

- a stochastic, world-facing **shell** (LLM extraction + web fetches) whose
  outputs are *frozen* into immutable, content-addressed **facts**, and
- a pure, deterministic **core** (aggregation / judging / validation) that
  reasons over those frozen facts.

This is the functional-core / imperative-shell pattern, where the shell is "the
world + the models" and the core is "the reasoning." It is what lets a live,
stochastic, web-grounded document *also* be reproducible, auditable, and
time-travelable. **The LLM only perceives; code reasons.** Reproducibility,
as-of re-judgement, evidence gradients, and zero-knowledge verdicts all live in
the pure core and all *require* this split.

Corollary design principle — **minimize the judgment surface**: push every
inference you can from the LLM into inspectable code; the LLM's job is to feed
clean numbers/types to that code. A free-form reasoning log is *all* judgment
surface; a good live notebook is mostly code. This is what "a better notebook
than a reasoning log" actually means.

---

## The ten primitives

The ~128 concepts generated in the session collapse onto a small set of nearly
orthogonal primitives. Almost every "flashy" concept is a composition of two or
three of these.

| # | Primitive | What it is |
|---|-----------|------------|
| P1 | **Frozen fact** | Content-addressed, immutable, timestamped evidence atom |
| P2 | **Deterministic judge** | Pure code over frozen facts (the core) |
| P3 | **Append-only bitemporal run-log** | Records both *world-time* and *knowledge-time* |
| P4 | **Live typed claim-object** | Addressable as an endpoint (`notebook://thesis@latest`) |
| P5 | **Citation graph** | Theses cite theses; confidence attenuates per hop |
| P6 | **Evidence covariance graph** | Pairwise evidence-overlap; powers belief-algebra *and* anti-Sybil consensus |
| P7 | **Independent-origin estimator** | "How many real witnesses?" — discounts echoes, cycles, astroturf, AI-generated text |
| P8 | **Tripwire runtime** | Cheap monitors gate expensive reruns |
| P9 | **Evidence type lattice** | `Primary > Secondary > Tertiary > Hearsay > Model-Inferred`; caps confidence |
| P10 | **Rigor tiers** | Cost scales with stakes/uncertainty, not uniformly |

The whole design space is then a **grammar**: `~10 primitives × ~15 mechanisms ×
N personalities`. The "200 dreams" are that grammar's outputs.

---

## The spine, reconsidered

The proposed binary `For → Against → Verdict` spine is *adversarial by
construction*, which quietly forces a courtroom frame onto questions that are
really estimation, classification, or cartography.

**The real spine is a living differential.** A claim is a posterior over a set of
competing hypotheses; evidence is chosen to *discriminate* between the leaders;
the "verdict" is `argmax` (or the whole distribution); and a **principled
abstain** fires when no hypothesis concentrates probability mass. The original
shapes fall out as special cases:

- **Boolean** = a 2-hypothesis differential `{true, false}` — and `For/Against`
  is its adversarial personality.
- **Scalar** = a continuous differential (a confidence interval that tightens).
- **Taxonomic** = an n-hypothesis differential.
- **Cartographic** = the hypothesis *space* itself is the deliverable (a map, not
  a verdict).

A "Verdict" cell therefore returns a typed structure governed by the notebook's
declared **epistemic shape**, not a bare boolean.

---

## The concept catalog (nine families)

Memorable names retained from the session. Each is `pitch — cleverest mechanism`.
This is a menu of what becomes *possible* once a document can re-run itself
against reality.

### F1 · Temporal & decay
- **Half-Life Verdicts** — beliefs decay like isotopes — verdict stores a
  function-of-the-world + a claim-specific freshness half-life; reading past
  half-life triggers re-evaluation.
- **Tensed / Bitemporal Thesis** — a claim is a belief-over-time function with
  validity intervals — every fact carries `(valid_time, transaction_time)`; the
  timeline is sliceable by either axis (world-history vs knowledge-history).
- **Belief Thermocline** — fast and slow belief layers — a low-pass filter lets
  volatile evidence move structural verdicts only when it persists.
- **Dead-Man's Switch** — staleness is active failure — a critical verdict not
  re-verified within its SLA flips to a loud STALE-ALARM rather than silently
  coasting.
- **Semantic-Drift Guard** — pin the operational definition of load-bearing
  terms; flag when fresh evidence uses a drifted sense (the *question* changed,
  not the answer).

### F2 · Adversarial honesty
- **Courtroom Cell** — Advocate / Prosecutor / deterministic Judge — verdict
  blocked until the opposing case is independently rated "strong" (the
  **Steelman Gate**: premature conviction is a compile error).
- **Red-Team Auditor** — a cell that attacks the notebook's *own* methodology
  (leading queries, biased rubric) and scores process integrity separately from
  the verdict. (Guards against **Rigor Theater** — the aesthetics of rigor
  without the substance.)
- **Devil's Ledger** — build the strongest *false-but-plausible* case from real
  cherry-picked evidence, run alongside the honest notebook as inoculation.
- **Jester Cell** — periodically inject the single most destabilizing true fact
  to fight motivated stopping.
- **Motivated-Reasoning Tax** — when a verdict serves the author's interest,
  auto-raise the steelman threshold and rigor tier.
- **Query-Framing Audit** — search prompts are auditable provenance; detect
  one-sided framing and auto-issue neutralizing counter-queries.

### F3 · Graph & propagation
- **Belief Spreadsheet** — verdicts cite live verdicts; staleness + attenuated
  confidence propagate like spreadsheet recalc.
- **Belief Epidemiology** — model verdict-flips as contagion through the citation
  graph (an R0 for beliefs; super-spreader sources; herd-immune robust theses).
- **Contradiction Hunter** — a SAT/consistency check over the verdict graph flags
  pairs of high-confidence inconsistent verdicts and spawns reconciliation
  notebooks.
- **Evidence Grafting** — one fetched source auto-routes to every other live
  thesis it bears on; one expensive fetch fertilizes the garden.
- **Blast-Radius Preview** — `terraform plan` for a belief flip: simulate the
  downstream recalc + actions before committing.
- **Incremental Verdict** — delta-update the posterior on a tripwire; recompute
  only downstream verdicts with non-negligible gradient to the change.
- **Cycle-Breaker** — detect circular support (A cites B cites A) and compute
  confidence only from the acyclic, grounded evidence.

### F4 · Provenance & trust
- **Chain-of-Custody Verdict** — embed a Merkle root over the evidence set per
  Run; a verdict is cryptographically reproducible even after sources 404.
- **Evidence Type Lattice** — typed evidence caps verdict confidence; can't
  launder a rumor into a fact.
- **Echo Collapse / Independent-Origin Count** — near-dup clustering collapses
  copies to one content-address; corroboration counts independent *origins*, not
  pages.
- **Astroturf Detector** — community-detection over the source-origin network
  exposes coordinated inauthenticity by network *shape*.
- **Synthetic-Aware Mode** — estimate `P(AI-generated)` per source; prefer
  hard-to-fake costly signals (signed disclosures, on-chain, primary documents).
- **ZK-Verdict** — prove a verdict was honestly computed from committed real
  evidence of claimed quality *without revealing the evidence*. *(Premature —
  vision, not roadmap.)*
- **Belief DOI / Claim Watermark** — exported claims carry a signed reference
  that resolves to the live derivation + current freshness.
- **Insight Notary** — anchor a verdict's hash + signed timestamp to prove "we
  knew X at time T" (sealed predictions). *(Trim the blockchain cosplay; keep the
  signed timestamp.)*

### F5 · Economy & runtime
- **Notebook Metabolism** — notebooks spend API credits; fitness = `citations ×
  importance × freshness / maintenance cost`; low-value theses hibernate.
- **Tripwire Notebook** — the verdict emits its own cheap monitorable
  falsification conditions; expensive reruns fire only when a wire trips
  (Popperian falsifiability, self-guarded).
- **Attention Economy** — a wide cheap periphery (vigilance) gates a narrow
  expensive fovea (re-derivation).
- **Freshness SLA / Scheduler** — per-thesis staleness SLAs become scheduling
  constraints; shortfalls escalate with explicit triage.
- **Progressive Rigor / Tiered Verdicts** — escalate from a cheap heuristic to
  full adversarial/shadow/parliament rigor only as stakes/contestedness justify;
  the verdict shows which tier produced it.
- **Belief Market** — notebooks bid expected decision-value-at-risk for the right
  to refresh; budget flows to where freshness matters most *now*. *(Premature; a
  priority queue gets 90%.)*
- **Deadline Planner** — plan the investigation backward from a decision
  deadline, sequencing queries by value-of-information; satisfice, don't
  optimize.
- **Epistemic Debt Ledger** — quantify the org's stale/under-evidenced beliefs as
  a liability with an interest rate; prioritize paydown by stakes × staleness.

### F6 · Social & ensemble
- **Shadow Replication** — every important thesis is re-investigated by a twin
  forced to use different methods/sources; cross-method agreement = robust.
- **Consensus Thermometer** — aggregate independent verdicts weighted by
  track-record + **independence** (evidence-overlap Jaccard); measure variance to
  distinguish settled from contested.
- **Schelling Verdict** — privacy-preserving consensus: parties publish only
  verdicts + independence proofs, converge without revealing evidence.
- **Minority Report** — the outvoted view is preserved as a live dissent that
  keeps gathering evidence and can trigger a re-vote.
- **Belief Feed / Follow-a-Thesis** — subscribe to a thesis; it posts only on
  genuine epistemic events (flip, new load-bearing source, calibration update).
- **Double-Crux Engine** — structurally diff two opposing forks to auto-locate
  the minimal differing input driving the disagreement.

### F7 · Self-improvement
- **Gardener Cell** — on drift, the notebook rewrites its own evidence-gathering
  query cells and commits the edit.
- **Darwinian Methodology** — investigation-templates compete on accuracy-per-
  credit; high-fitness ones reproduce and mutate. **Cell Horizontal Transfer**: a
  proven single cell can splice into unrelated notebooks.
- **Self-Calibrating Confidence** — fit an isotonic transform on resolved
  `(stated_conf, outcome)` pairs; pipe future verdicts through it (humility
  learned from being wrong).
- **Surprise Ledger** — record `KL(posterior‖prior)` per Run; high-surprise
  theses map where your world-model is worst.
- **Evidence Holdout** — withhold a random subset of sources from the Judge; a
  verdict that flips on the holdout was overfit to cherry-picked evidence.
- **Calibration Controls** — slip known-answer theses into the workload as blind
  controls; catch methodology drift the same day, not next quarter.
- **Self-Bootstrapping Dataset** — every awake rerun appends a labeled row;
  eventually train a cheap local model to replace/pre-filter the LLM judge.

### F8 · Shape & output
- **Polymorphic / Differential Spine** — see [above](#the-spine-reconsidered).
- **Principled Abstain** — "I genuinely can't call this yet" as a first-class
  output, distinct from ethical refusal.
- **Rosetta Projection** — all human-facing renderings are projections of one
  canonical belief object, guaranteed mutually consistent across audiences.
- **Faithful Prose** — a validator fails CI if the human summary's sentiment
  contradicts the structured verdict; the narrative can't lie about the numbers.
- **Honest Compression** — every TL;DR carries a fidelity score + "⚠ drops 3
  caveats, 1 dissent" marker; lossy but labeled.
- **Belief Blame** — verdict prose is *rendered from* a provenance derivation
  tree, so every sentence is traceable and orphan claims are unrenderable.

### F9 · Human & lived
- **The Confidante** — a private notebook that holds your self-stories to your own
  data (journal, calendar, health, commits) via personal MCP servers.
- **Sommelier** — encode calibrated *taste* as an editable, arguable rubric
  learned from a curator's past accept/reject calls.
- **Sparring Partner** — interrogates *your* stated belief (surfaces its most
  fragile point) instead of emitting its own; the anti-oracle that wants you to
  need it less.
- **Lichen** — human-only and agent-only cells interleave in one derivation, each
  tagged by authorship; honors the seam between web evidence and tacit knowledge.
- **Apprentice** — a proven notebook emits a parameterized, critique-able
  *tutorial* of its own method.
- **Heirloom** — a cared-for question (and its self-maintaining inquiry) is
  bequeathed across people and time.

### Delight-anchors (art, not roadmap)
- **Epistemic Orrery** — your belief-corpus as a planetarium: foundational theses
  are massive bodies, dependents orbit them (citation gravity), instability shows
  as a wobbling orbit before a flip.
- **Sonification / Belief Organ** — your worldview as ambient generative music;
  hear a critical thesis flip from the next room, hear a contested cluster as
  dissonance.

---

## Analytical mechanisms worth singling out

These exploit P1+P2 (frozen facts + deterministic judge) and are unusually novel:

- **Mind-Change Diff** — diff consecutive Runs' content-addressed evidence sets to
  name the single source that flipped a verdict.
- **Belief Bisect** — binary-search the run-log to localize exactly when a belief
  broke (git-bisect for belief).
- **Belief Path-Integral** — accumulate each source's per-Run gradient
  contribution over the whole timeline to find the *quiet* influencers (the
  lobbyist, not the bombshell) that flip-detection misses.
- **Differentiable Verdict** — take `∂verdict/∂(each evidence item)` to expose
  which 2-3 of your "20 sources" actually carry the verdict.
- **As-Of Judge** — re-run the deterministic Judge over only the evidence that
  existed at a past date, separating bad luck from bad reasoning ("was that a good
  call *at the time*?").
- **Fragility Map** — invert the Judge to synthesize the minimal evidence that
  would flip the verdict, and assess how plausible/findable it is.
- **Crux Finder** — toggle each first-class assumption to its opposite and
  re-derive to find the single load-bearing one.

---

## The build-first three

Dependency-ordered. Each verified against this repo's *actual* structure
(`src/tools/sandbox.ts`, `src/store/db.ts`, `src/webhooks/`, the `tasks.create`
workflow runner) — not hand-waved.

### 1 · Smallest Lovable Notebook (the kernel)

A new `notebook.*` domain. A notebook is a `.src.md`; a code cell's source runs in
the existing `vm` sandbox with `callOperation` injected. Five cells:

1. a **thesis** line;
2. a **For** cell — e.g. `const r = await callOperation('websets.search', {query, mode:'for'})`;
3. an **Against** cell;
4. a **Judge** cell — LLM extracts typed features (frozen + content-addressed into
   `store/db.ts`), then *pure JS* computes `{verdict, confidence}`;
5. a **Run** append — `notebook.run` writes a dated Run section and upserts the
   latest verdict into a new SQLite table
   `notebook_verdicts(thesis_id, verdict, confidence, fresh_at, evidence_root)`.

Reuses sandbox + store + the `OPERATIONS` registry. ~a few hundred LOC + a
`.src.md` template. Verification per `CLAUDE.md`: drive it via the `execute` tool
with `callOperation`, **not** curl.

*Proves the core loop:* a markdown file that re-runs adversarial web research and
logs how its verdict drifts.

### 2 · Living Dossier (the demo)

`tasks.create` spawns a workflow that maps the SLN skill across a Webset of
entities. Each entity's dossier is an **awake** notebook whose tripwires are Webset
monitors. On `webset.item.*` / a monitor trip, the **already-built**
`webhooks/receiver.ts → eventBus → channel.ts` path (the documented dispatch
protocol) re-runs the affected dossier and, on a verdict **flip**, emits a channel
event with a Mind-Change Diff: *"AcmeCo downgraded — caused by new WARN-Act
filing."*

This is mostly *integration of parts that already exist* (webhook receiver, event
bus, channel bridge, workflow runner, Websets monitors). That is exactly why it is
the demo: it lights up infra already in the repo, composing ~9 concepts onto one
screen.

### 3 · Belief Spreadsheet (the moat)

Builds on the SQLite index the repo already has:

- the `notebook_verdicts` table becomes the resolver for `notebook://thesis@latest`;
- a Verdict cell calls `callOperation('notebook.cite', {thesisId})` to pull
  another notebook's live verdict as typed (Derived-tagged) evidence;
- on any verdict upsert, a trigger walks a `notebook_citations(from, to)` edge
  table and marks downstream rows stale with attenuated confidence;
- stale rows get re-run by the same workflow runner; Incremental Verdict keeps it
  cheap.

*The compounding moat:* once verdicts cite verdicts and prose transcludes them
(Live Citations), you get a web of living knowledge no static tool can match.

---

## Two caveats that keep it honest

**The Goodhart Stance.** The moment verdicts drive actions, money, or reputation,
people and agents optimize the *metrics*, not the truth (game the Brier score by
forecasting only easy things; farm bounties with borderline submissions; tune a
Judge rubric to a desired verdict). Mitigation is a *stance*, not a feature: keep
humans at stakes-gated points; keep the red-team adversarial and *independently
incentivized*; rotate hidden calibration controls so they can't be memorized;
never let the system's outputs feed its own training signal unchecked. This needs
permanent adversarial governance, not a one-time build.

**The unproven crux.** Whether LLM extraction (the shell) is reliable enough that
frozen-feature determinism (the core) yields *trustworthy* verdicts is empirical
and unproven. The Calibration Controls and Evidence Holdout are the mitigations;
validate them **early**, before trusting any downstream concept. The system's
honest value proposition is **accountability, not oracle**: it does not make LLM
judgments true; it makes them scored, traceable, falsifiable, and challengeable
over time.

---

## Relationship to Thoughtbox (fair comparison)

Thoughtbox's own `notebook.*` module (`notebook_validate`, `notebook_start_run`
"Evidence Engine", `notebook_persist`) is along the *same axis* — this is an
extension, not a refutation. The differences that matter:

1. Thoughtbox's *reasoning sessions* (`tb.thought`) are free-form logs — pure
   judgment surface, no world-grounding, no reproducibility, no decay. (The
   202-thought session that produced this file is Exhibit A: gorgeous, structured,
   and epistemically inert — no thought in it can re-run against reality.)
2. Its claim-extractor peer treats claims as *strings* (it shattered a `.src.md`
   line into garbage), violating axiom A0.

The four moves Thoughtbox's notebook doesn't fully make — **world-grounded
executable evidence** (cells call live Exa), the **core/shell determinism
boundary**, the **bitemporal self-revising run-log**, and the **cross-notebook
citation graph** — are the contribution. The natural bridge is a **Log-to-Live
Compiler**: take any free-form reasoning log, extract its implicit claims as typed
objects, attach an evidence cell + falsifier to each, and graduate "here's what I
reasoned" into "here's what I'll continuously check."

---

## Appendix · provenance

Generated from Thoughtbox session `86c94e8f-4722-421c-9564-f6ccc12d6ac7` (202
sequential, non-batched thoughts; 1 assumption-flip where the chain caught itself
trying to stop early; the claim-extractor peer invoked mid-stream, whose *failure*
seeded axiom A0). Export:
`/root/.thoughtbox/exports/86c94e8f-...-2026-06-03T02-28-49-807Z.json`.
