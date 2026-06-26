# Plan: Headless Srcbook Execution for Live Notebooks

**Status:** Plan / ready for review
**Date:** 2026-06-03
**Spans two repos:** `glassBook` (Srcbook fork — gains the runner) and `websets-mcp-codemode` (this server — delegates execution)
**Supersedes:** the vm-sandbox execution path that shipped in the `notebook.*` PR (`8da0002`).

## Context

The `notebook.*` domain shipped as a **verdict log**: `thesis.investigate` gathers evidence
server-side and writes it as static markdown, so the scaffold has no runnable code cells and
`notebook.runCell` has nothing to run. The spec (`specs/live-notebooks-executable-epistemics.md`,
build-first #1) requires the opposite: a notebook's **For / Against / Judge cells are runnable
code cells** whose source is `callOperation(...)`, and re-running them refreshes evidence. That is
the "executable epistemic document" keystone, and it was not built.

Decision (locked): execution is **headless Srcbook** — the real Srcbook `tsx`-on-cell-file engine,
no web UI — with `callOperation` provided as a **preload-injected global** so cells stay identical
to the spec. The runner lives **in glassBook**; this server calls it as a sidecar.

There is no off-the-shelf headless Srcbook: `@srcbook/api` exports only `app`/`wss`/`SRCBOOKS_DIR`
and execution is WebSocket-driven (`packages/api/server/ws.mts`, `cell:exec`). But the execution
*primitive* — `packages/api/exec.mts` `spawnCall()`/`node()` spawning `node`/`tsx` on a cell file
in a notebook dir — is already headless-shaped. We assemble it (+ the `.src.md` codec + deps
install) into the runner glassBook's own `docs/spec/mvp-build-plan.md` anticipated but never built.

## The interface contract (pin this first — both tracks build to it)

**glassBook runner HTTP sidecar:**
```
POST /run
  body: { srcmd: string,                 // the .src.md text
          cellIds?: (number|string)[],   // omit = run all code cells in order
          env?: Record<string,string>,   // forwarded to the cell process (e.g. WEBSETS_MCP_URL)
          timeoutMs?: number }
  → 200: { ok: boolean,
           cells: [{ cellId, filename, stdout, stderr, returnValue, exitCode, durationMs }] }
```
- The runner injects the preload on every cell spawn: `tsx --import ./_preload.mjs <cellFile>`.
- `_preload.mjs` sets `globalThis.callOperation = (name, args) => …`, an MCP StreamableHTTP client
  to `env.WEBSETS_MCP_URL` that invokes this server's **`execute`** tool with
  `return await callOperation(${JSON.stringify(name)}, ${JSON.stringify(args)})` and returns the
  parsed result. (Double-hop: cell → preload → websets `execute` → sandbox → `dispatchOperation`.
  Acceptable for fast ops like `exa.search`; long ops use the task-polling pattern.)
- Transport choice: **HTTP now** (simplest). MCP-server sidecar is the prettier symmetric
  end-state (matches glassBook's "MCP client + server" tagline) — defer.

## Track A — glassBook: the headless runner

New code (reuses Srcbook internals, no UI):
- `packages/api/runner/runner.mts` — `runNotebook({ srcmd, cellIds, env, timeoutMs })`:
  1. decode `.src.md` → cells (reuse `packages/api/srcmd/decoding.mts`).
  2. materialize a temp notebook dir (reuse `session.mts` `decodeDir`/`writeToDisk`/`writeCellToDisk`).
  3. install deps if needed (reuse `packages/api/deps.mts` `shouldNpmInstall`/`missingUndeclaredDeps`).
  4. for each requested code cell, spawn `tsx --import <preload> <cellFile>` via `exec.mts`
     `spawnCall()`, capturing stdout/stderr/exit + a structured return (cell writes its result to a
     conventional FD/file the runner reads).
  5. return the contract shape above.
- `packages/api/runner/_preload.mjs` — sets `globalThis.callOperation` (MCP client to `WEBSETS_MCP_URL`).
- `packages/api/runner/server.mts` (or extend `server/http.mts`) — the `POST /run` endpoint, **no
  React, no WS** (the "no UI" slice). Runs as its own entrypoint.
- Reuse, do not rebuild: codec, session dir IO, deps, exec — all already exist
  (`docs/discovery/01-notebook-runtime.md` inventories them with file evidence).

Verification (glassBook): unit test `runNotebook` on a fixture `.src.md` whose cell is
`globalThis.callOperation = …` mocked; assert stdout/returnValue captured; assert preload injection;
assert dep-install path. Integration: `POST /run` against a stub `WEBSETS_MCP_URL`.

## Track B — websets-mcp-codemode: delegate execution + emit real cells

1. **Runner client** — `src/notebook/runnerClient.ts` (new): thin HTTP client to the glassBook
   sidecar (`GLASSBOOK_RUNNER_URL`), passing `WEBSETS_MCP_URL` in `env`.
2. **`notebook.runCell`** (`src/handlers/notebook.ts`): stop using `src/tools/sandbox.ts`; render the
   notebook to `.src.md` (`src/notebook/srcmd.ts`), POST to the runner, append the returned output as
   a result cell. (Keep the sandbox path behind a flag for local/no-sidecar fallback.)
3. **`notebook.create` scaffold** (`src/handlers/notebook.ts`): emit the **five real cells** of
   build-first #1 — thesis (markdown), `for.ts` (code: `callOperation('exa.search', …)`),
   `against.ts` (code), `judge.ts` (code: see #5), `package.json`. No prose placeholders for the
   executable cells.
4. **`thesis.investigate`** (`src/workflows/thesisInvestigate.ts`): instead of gathering evidence
   out-of-band, **drive the cells through the runner** (or call `notebook.runCell` per cell), then
   append a Run from the cells' outputs. Headless orchestration stays (the earlier decision); the
   cells are now the gatherers.
5. **Judge cell + A1 core/shell** (`src/store/db.ts` + the `judge.ts` cell):
   - shell (perceive): an LLM/extraction step turns evidence text into typed features, **frozen** as
     content-addressed rows in a new `facts(hash, notebook_slug, source_url, normalized, kind,
     created_at)` table (hash = sha256 of normalized content).
   - core (reason): **pure JS** computes `{verdict, confidence}` from the frozen facts.
   - **`evidence_root`**: sha root over the run's fact hashes, stored on the Run and on
     `notebook_verdicts(thesis_id, verdict, confidence, fresh_at, evidence_root)` (rename/extend the
     current `notebooks` index). Makes verdicts reproducible after sources 404 (Chain-of-Custody).
   - **Open item:** where the shell LLM lives — a new websets `callOperation`-able extraction op vs
     the cell using glassBook's `@ai-sdk/anthropic` directly. Recommend a websets op so cells stay
     uniform (everything via `callOperation`). Resolve before Phase 2.
6. **Compose wiring** (`docker-compose.yml`): add a `glassbook-runner` service; set
   `GLASSBOOK_RUNNER_URL` here and `WEBSETS_MCP_URL=http://websets-codemode:7860/mcp` there (compose net).

## Phasing (de-risk the new execution path before the epistemics)

- **Phase 1 — prove headless execution.** Track A runner + preload; Track B runnerClient +
  `runCell` delegation + scaffold `for.ts`/`against.ts` cells that call `exa.search`. Success =
  `notebook.runCell` runs a real cell through headless Srcbook and `callOperation` reaches Exa.
  Deterministic Judge (counts, no LLM) for now.
- **Phase 2 — the A1 Judge.** Content-addressed `facts`, shell-extraction op, pure-core verdict,
  `evidence_root`. Success = a rerun produces a reproducible verdict with a Mind-Change-able fact set.

## Verification (end-to-end, per CLAUDE.md — via `execute`/`callOperation`, not curl)
1. `pnpm build && pnpm test`; `docker compose down && build && up` (both services healthy).
2. `callOperation('notebook.create', { thesis })` → assert `for.ts`/`against.ts`/`judge.ts` are
   **code** cells (the bug we caught: previously only `package.json` was code).
3. `callOperation('notebook.runCell', { slug, cellId: 'for.ts' })` → returns live Exa results via
   the runner; result cell appended. **This is the loop that currently does nothing.**
4. `callOperation('tasks.create', { type:'thesis.investigate', args:{…} })` → Run appended with
   `evidence_root`; `store.query` on `notebook_verdicts` shows it.
5. Re-run → second Run; diff fact sets (Mind-Change Diff) to confirm bitemporal run-log.

## Risks / open
- **Double-hop latency & the 120s `execute` ceiling** for cells that kick long tasks
  (`adversarial.verify`). Mitigate: evidence cells call fast ops; long ops use task-polling. If it
  bites, add a direct single-op dispatch endpoint to this server (bypassing `execute`).
- **Srcbook is unmaintained** — we depend on glassBook (our fork), not upstream `srcbook`. Acceptable.
- **Shell-LLM location** (#5 open item) — decide before Phase 2.
- **Cross-repo execution:** glassBook track ships as its own PR/cloud session; this server's Track B
  builds to the contract and can land behind the sidecar flag before glassBook is ready.
