# Workflows as Prompts and Resources — Recommendations

**Date:** 2026-05-22
**Scope:** All 13 registered workflows in `src/workflows/`
**Method:** Source reading of every workflow + live exercise of the ones the running server permits.

---

## Important context: the scaffolding already exists

`src/workflows/mcp.ts` already registers, for every workflow with `WorkflowMeta`:

- A **resource** at `workflow://<key>` (markdown docs, rendered from metadata)
- A **prompt** at `workflow/<key>` (templated with a `goal` arg; returns the resource text + invocation guidance)
- A global index resource `workflow://index` (categorized listing)
- A global `workflow/choose` prompt (renders the full catalog + selection guide given a `goal`)

`workflowMetadata` is the single source of truth — it feeds the resource renderer, the prompt builder, and the `search` tool's `workflow` domain.

So the architectural question isn't "should we expose workflows as prompts and resources?" — that's already done. The real questions are:

1. **Which workflows actually need executable code vs. would be just as good as a prompt-only recipe?**
2. **Should tool responses embed `resource_link` blocks back to the matching `workflow://` resource so the caller doesn't need a separate fetch?**
3. **Are there workflows that should be retired or promoted as regular ops instead?**

---

## Live exercise results

| Workflow | Live? | Result |
|---|---|---|
| `echo` | yes | passed, 54ms |
| `echo.effect` | yes | passed, 77ms |
| `retrieval.searchAndRead` | yes | 3 results read in 1.6s |
| `retrieval.verifiedAnswer` | yes | overlap=1/3, 5s |
| `retrieval.expandAndCollect` | yes | 3 initial + 5 expanded = 8 unique in 1.5s |
| `research.deep` | yes | `exa-research-fast`, 15s, returned synthesis |
| `semantic.cron.replay` | yes (inline snapshot) | emitted `signal-fired`, 14ms |
| `lifecycle.harvest` | yes (small count) | webset created, polled to idle |
| `qd.winnow` | yes (small count) | classified items into niches |
| `convergent.search` | yes (2 queries, small count) | multi-webset intersection computed |
| `adversarial.verify` | source-only | shape understood from src/workflows/adversarial.ts |
| `research.verifiedCollection` | source-only | shape understood from src/workflows/verifiedCollection.ts |
| `verify.enrichments` | source-only | shape understood from src/workflows/verifyEnrichments.ts |
| `semantic.cron` | source-only | shape understood from src/workflows/semanticCron.ts (1,400 LOC DSL interpreter) |

Two deployment bugs surfaced during the live runs (call out separately — not blockers for this design):

- **Container `EXA_API_KEY` loading**: docker-compose only reads `.env` (not `.env.local`) for `${VAR}` substitution. Fixed by user renaming the file. Worth a `env_file:` block on the service for robustness.
- **`better-sqlite3` native binding in container**: `pnpm install` skipped build scripts during image build (`Ignored build scripts` warning), so the prebuilt `arm64` `.node` file is missing. `store.*` ops + `semantic.cron` snapshot persistence silently fail in-container. Needs `pnpm rebuild better-sqlite3` (or `pnpm approve-builds`) in the Dockerfile.

---

## Workflow archetypes

After reading all 13, they fall into four buckets by **logic-per-API-call ratio** — how much novel computation each workflow does beyond stringing API calls together.

### A. Pure orchestration glue (1–3 API calls, recipe-shaped)
- `echo`, `echo.effect` (smoke tests)
- `retrieval.searchAndRead` (search → getContents)
- `retrieval.verifiedAnswer` (answer → search → getContents → count overlap)
- `research.deep` (research.create → pollUntilFinished)
- `semantic.cron.replay` (read snapshot → emit event)

**These could be expressed as prompts alone**, with the model writing the orchestration via `execute`. The case for keeping them as code:
- TaskStore lifecycle (cancel, progress, partial result) is awkward to do from sandbox-emitted code.
- Standardized projection/`_summary` is consistent across calls.
- The caller writes one line instead of ten.

The case against: thin glue, every line of caller code is replaceable by the prompt + `execute` combination.

### B. Foundational webset lifecycle
- `lifecycle.harvest` (create → poll → collect → optional cleanup)

This is the canonical create-poll-collect skeleton that every Archetype-C workflow internally repeats. **Keep as code** and document it as THE pattern — when the model needs "give me a populated webset," this is the one-call path.

### C. Webset lifecycle + meaningful computation
- `retrieval.expandAndCollect` (parallel `findSimilar` fanout with concurrency-3 via Effect, then URL dedup)
- `qd.winnow` (MAP-Elites classification: items → criteria-vector niches → fitness score → elite selection; computes Shannon entropy, coverage, stringency)
- `convergent.search` (N parallel websets → URL/name fuzzy dedup via Dice coefficient → overlap matrix between query pairs)
- `adversarial.verify` (parallel thesis + antithesis websets, optional Research API synthesis with structured prompt)
- `research.verifiedCollection` (webset + per-entity research with template expansion `{{name}}`/`{{url}}`/`{{description}}` and concurrency-3 semaphore)
- `verify.enrichments` (per-entity-type verification strategies: GitHub API for profile/repo, DNS MX for emails, Exa search for general; persists per-field verdicts to SQLite)

**Keep all as code.** The value is in the computation, not the API calls. None would survive translation to a prompt without losing fidelity.

### D. Domain DSL interpreter
- `semantic.cron` (1,400 LOC: template engine, condition operators `gte`/`gt`/`lte`/`lt`/`eq`/`contains`/`matches`/`oneOf`/`exists`/`withinDays`, join engine `entity`/`temporal`/`entity+temporal`/`cooccurrence`, signal evaluator `all`/`any`/`threshold`/`combination`, snapshot persistence + delta, webhook auto-registration, monitor scheduling)

This isn't a workflow — it's a small interpreter for a JSON-based monitoring DSL. **Absolutely keep as code.** The prompt for it needs to embed the config schema, not just templated invocation text.

---

## Per-workflow recommendation matrix

| Workflow | Archetype | Code? | Prompt? | Resource? | Notes |
|---|---|---|---|---|---|
| `echo` | smoke | keep | **drop** | keep | Smoke test, shouldn't clutter the prompt picker. Resource OK as part of `workflow://index` count. |
| `echo.effect` | smoke | keep | **drop** | keep | Same. |
| `lifecycle.harvest` | B | keep | **promote** | keep | Make this the headline prompt — "the foundational pattern." |
| `retrieval.searchAndRead` | A | keep | keep | keep | Borderline; prompt is useful for "give me the recipe" requests. |
| `retrieval.verifiedAnswer` | A | keep | keep | keep | Same. |
| `retrieval.expandAndCollect` | C | keep | keep | keep | Effect concurrency is the unique value. |
| `research.deep` | A | reconsider | keep | keep | Almost just `research.create + pollUntilFinished`. Could be a regular op rather than a workflow. Currently no harm in keeping. |
| `research.verifiedCollection` | C | keep | keep | keep | Template expansion + semaphore — non-trivial. |
| `qd.winnow` | C | keep | keep | keep | Map-elites logic is the value. |
| `convergent.search` | C | keep | keep | keep | Fuzzy dedup + overlap matrix. |
| `adversarial.verify` | C | keep | keep | keep | Parallel websets + structured synthesis. |
| `verify.enrichments` | C | keep | keep | keep | Per-type strategies with classification heuristics. |
| `semantic.cron` | D | keep | **enhance** | keep | Prompt should embed the DSL schema, not just templated invocation. |
| `semantic.cron.replay` | A (utility) | keep | keep | keep | Demo/rehearsal aid. |

---

## Architectural change: embedded `resource_link` in tool responses

The user's specific ask was: *"we could also embed a resource on a tool operation to additionally serve instructions on its usage."*

MCP supports `resource_link` content blocks in tool responses. When a tool returns content, it can include:

```json
{
  "type": "resource_link",
  "uri": "workflow://qd.winnow",
  "name": "Quality-Diversity Winnow",
  "mimeType": "text/markdown",
  "description": "MAP-Elites style classifier for webset items"
}
```

Three concrete integration points:

### 1. `tasks.create` response → attach resource_link to the matching `workflow://<type>`

```ts
// in src/handlers/tasks.ts after creating the task
return {
  content: [
    { type: "text", text: JSON.stringify({ taskId, status: "pending" }) },
    workflowMetadata.has(type)
      ? { type: "resource_link", uri: `workflow://${type}`, name: workflowMetadata.get(type)!.title, mimeType: "text/markdown" }
      : null,
  ].filter(Boolean),
};
```

When the LLM dispatches `tasks.create({ type: 'qd.winnow', ... })`, the response includes a link back to the workflow docs. The model can read it inline to interpret the result, choose follow-up params, or recover from errors.

### 2. `search` tool → workflow domain results carry resource_link

When `search({ domain: 'workflow' })` returns results, attach a resource_link to each workflow entry. Discovery and docs in one round-trip.

### 3. `execute` tool → detect `tasks.create` calls in the executed code and append matching links

Lighter-touch alternative to (1): the execute tool's sandbox already captures `callOperation` invocations. After execution, append resource_links for any workflow types that were dispatched. Doesn't require changes to per-handler return shapes.

**Recommend (1) + (2).** Both are cheap; both give the model docs context exactly when it needs them. (3) is redundant if (1) is in place.

---

## Trim the prompt surface

The MCP prompt picker shows users a flat list of all registered prompts. Right now `workflow/echo` and `workflow/echo.effect` appear there alongside meaningful workflows. They're smoke tests, not user-facing.

**Recommendation:** Add an optional `WorkflowMeta` field like `hiddenFromPicker?: boolean` and gate the `server.prompt()` registration on it. Or filter by `category !== 'smoke'`. Resources stay (so `workflow://index` still counts them).

---

## The `semantic.cron` prompt needs to be different

The default prompt template (`renderWorkflowResource` + "Goal: {goal}\n\nFill in callOperation(...)") works for workflows whose parameters are flat. `semantic.cron` takes a `config` object that is essentially a small DSL — lenses, shapes, conditions, join, signal. The model needs:

- The JSON schema for `SemanticCronConfig` (or a typed example for each lens/shape/join/signal variant)
- A short-form guide to picking `join.by` (`entity` vs `entity+temporal` vs `cooccurrence` vs `temporal`)
- A short-form guide to picking `signal.requires.type` (`all` / `any` / `threshold` / `combination`)
- The validation gotchas already in the source (e.g. `minLensOverlap >= 2` when there are 2+ lenses; `combination` requires at least 2 lens IDs per combo)

**Recommendation:** Give `semantic.cron` a custom prompt body instead of the generic one. Either:

- Extend `WorkflowMeta` with an optional `promptBody?: (goal: string) => string`, or
- Special-case it in `mcp.ts`.

---

## Where this all lands

If we do the work above, the topology becomes:

- **3 tools** (search, execute, status) — unchanged surface, but with resource_link enrichment on responses
- **~75 operations** — unchanged, but every workflow-related response carries a docs link
- **~12 prompts** (drop the 2 smoke tests; one `workflow/choose`) — surfaced in the prompt picker, each a one-shot "configure this workflow for my goal"
- **~14 resources** (one per workflow + index) — same as today, but actually reached via embedded links rather than only by manual fetch

The single substantive code path change is **embedding `resource_link`** in tool responses. Everything else is metadata, prompt-body customization, and trimming.

---

## Concrete next steps (in order)

1. Fix the two container deployment bugs (`env_file:` and `pnpm rebuild better-sqlite3`) — unrelated to design but blocks anyone running the server on `arm64` with the current Dockerfile.
2. Implement embedded `resource_link` on `tasks.create` responses (~10 LOC in `src/handlers/tasks.ts`).
3. Implement embedded `resource_link` on `search` tool workflow results (~10 LOC in `src/tools/searchTool.ts`).
4. Add `hiddenFromPicker` (or equivalent) to `WorkflowMeta`; mark `echo` + `echo.effect`.
5. Add a custom prompt body for `semantic.cron` that embeds the DSL schema.
6. Document `lifecycle.harvest` prominently as THE create-poll-collect pattern — update its description to call this out explicitly and link from related-workflow sections.
7. (Optional) reconsider whether `research.deep` should stay a workflow or become a regular op. It does almost nothing beyond two SDK calls; the workflow form costs a TaskStore entry that may not pay for itself.

---

## What this doesn't change

- The existing `workflow://` URIs stay. No breaking changes.
- `tasks.create` continues to be the dispatch path.
- The metadata-driven rendering in `mcp.ts` continues to work.
- The `search` tool's workflow domain continues to work.

The pitch is additive: enrich what's already there with resource_link surfacing, prune two smoke prompts, customize one prompt body. No demolition.
