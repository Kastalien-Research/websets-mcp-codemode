# Exa API Key Startup Invariant

## Problem

The initially checked-out base passed `exaApiKey` to `createServer` without defining it.
Current remote `master` later restored that wiring and added a build-only CI job, but unit
tests for `resolveExaApiKey` still verify the helper only in isolation and do not prove that
the production entrypoint calls it. The default-branch ruleset also does not require the
build job.

## Scope

Preserve the restored production startup wiring and add two independent enforcement layers:

1. A focused behavioral test executes the real TypeScript entrypoint with no Exa key and
   asserts the documented, actionable failure path.
2. The existing GitHub Actions build workflow runs the focused startup/config tests on
   every pull request and default-branch push. Its stable `build` job can become a required
   status check in the existing default-branch ruleset.

This change does not redesign configuration, change runtime defaults, add production
dependencies, or modify the pre-existing governance fixtures.

## Implementation

### Production entrypoint

`src/index.ts` already imports `resolveExaApiKey`, resolves `process.env` before constructing
the server, emits the existing keyless warning when applicable, and exits with status 1 plus
the existing actionable error when resolution fails. The branch will preserve that current
`master` behavior without carrying a duplicate entrypoint diff.

### Startup regression test

Add `src/__tests__/startup.test.ts`. It will launch `src/index.ts` in a child Node process
through the repository's existing `tsx` development dependency with `EXA_API_KEY` and
`ALLOW_NO_EXA_KEY` removed from a copied environment. The test will assert:

- exit status is 1;
- stderr contains the missing `EXA_API_KEY` guidance; and
- stderr names the `ALLOW_NO_EXA_KEY=1` escape hatch.

This test exercises the entrypoint rather than only retesting the configuration helper.
With the current broken wiring it fails because the expected startup error is absent.

### Continuous integration

Extend the existing `.github/workflows/ci.yml` while preserving its stable workflow and job
name (`build`). On pull requests and pushes to `master`, it will:

1. check out the repository;
2. install Node 20 and activate the package-manager-pinned pnpm version through the
   existing pnpm setup action;
3. run `pnpm install --frozen-lockfile`;
4. run `pnpm run build`; and
5. run the focused startup/config tests.

The full suite remains outside this required check because it contains pre-existing live
integration, Docker E2E, and type-format failures that need separate triage. The invariant
check must be reliable without credentials or external services.

After the workflow has produced its first PR check, update the existing `Essential`
repository ruleset by preserving all current rules and adding the exact observed Build job
context as a required status check with strict branch freshness. This external repository
policy mutation is separate from the code commit and must stop if Kastra returns HOLD or
DENY.

## Verification

Use a red-green sequence:

1. Add and run the focused startup test against the broken entrypoint; confirm it fails for
   the missing behavioral wiring.
2. Sync current `master`, preserve its restored startup block, and rerun the focused test;
   confirm it passes.
3. Run `pnpm run build`.
4. Run the full non-live/non-E2E unit test set locally.
5. Review `git diff` and `git status` to ensure pre-existing untracked files and the
   governance-fixture commit remain untouched.
6. Push the branch, open the PR, inspect the real check name and result, then add that exact
   context to the existing ruleset without replacing its current protections.

## Acceptance Criteria

- The production entrypoint resolves the Exa API key before calling `createServer`.
- Missing or blank keys produce the existing actionable error and status 1.
- The focused entrypoint regression test fails when the wiring is absent and passes when it
  is present.
- The TypeScript build, focused startup/config tests, and non-live/non-E2E unit tests pass
  locally; the build and focused tests pass in GitHub Actions.
- The default branch ruleset requires the new Build job while retaining its existing pull
  request, deletion, and non-fast-forward rules.
- No unrelated files, untracked user work, or production dependencies are changed.
