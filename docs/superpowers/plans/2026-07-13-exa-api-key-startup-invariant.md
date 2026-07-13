# Exa API Key Startup Invariant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the production Exa API key startup wiring and enforce it with an entrypoint regression test plus a required-capable CI build check.

**Architecture:** Keep `resolveExaApiKey` as the configuration contract and restore only its missing production-entrypoint wiring. Exercise the real TypeScript entrypoint in a bounded child process so the test detects disconnected wiring, then add a stable GitHub Actions workflow whose observed check context can later be added to the existing ruleset after separate approval.

**Tech Stack:** TypeScript, Node.js 22, tsx, Vitest, pnpm 10.32.1, GitHub Actions.

## Global Constraints

- Preserve all pre-existing commits, governance fixtures, and untracked files.
- Do not add production dependencies or change runtime defaults.
- The child-process test must use an explicit repository cwd and a 5-second timeout.
- Stop before any GitHub ruleset mutation; show the live context and exact proposed request for separate approval.
- Record every observed Kastra ALLOW, HOLD, or DENY.

---

### Task 1: Add the failing production-entrypoint regression test

**Files:**
- Create: `src/__tests__/startup.test.ts`

**Interfaces:**
- Consumes: the executable `src/index.ts` entrypoint and its existing `resolveExaApiKey` error copy.
- Produces: a test proving the real entrypoint emits missing-key guidance before exiting.

- [ ] **Step 1: Write the failing test**

```ts
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('production startup', () => {
  it('fails with actionable guidance when EXA_API_KEY is missing', () => {
    const env = { ...process.env };
    delete env.EXA_API_KEY;
    delete env.ALLOW_NO_EXA_KEY;

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts'],
      {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        timeout: 5_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EXA_API_KEY is not set.');
    expect(result.stderr).toContain('ALLOW_NO_EXA_KEY=1');
  });
});
```

- [ ] **Step 2: Run the test and verify the specific red state**

Run: `pnpm exec vitest run src/__tests__/startup.test.ts`

Expected: FAIL because stderr does not contain `EXA_API_KEY is not set.` or
`ALLOW_NO_EXA_KEY=1`; a nonzero child exit by itself is not sufficient.

### Task 2: Restore the minimal startup wiring

**Files:**
- Modify: `src/index.ts`
- Test: `src/__tests__/startup.test.ts`

**Interfaces:**
- Consumes: `resolveExaApiKey(env: Record<string, string | undefined>): ResolvedExaApiKey` from `src/config.ts`.
- Produces: a defined `exaApiKey: string` passed to `createServer` after fail-fast resolution.

- [ ] **Step 1: Import the existing resolver**

```ts
import { resolveExaApiKey } from './config.js';
```

- [ ] **Step 2: Resolve the key before server construction**

```ts
let exaApiKey: string;
try {
  const resolved = resolveExaApiKey(process.env);
  exaApiKey = resolved.apiKey;
  if (resolved.warning) console.warn(resolved.warning);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
```

- [ ] **Step 3: Run focused tests and confirm green**

Run: `pnpm exec vitest run src/__tests__/startup.test.ts src/__tests__/config.test.ts`

Expected: both files pass; the startup child exits 1 with both guidance strings.

- [ ] **Step 4: Commit the behavioral repair**

```bash
git add src/index.ts src/__tests__/startup.test.ts
git commit -m "fix: enforce Exa key resolution at startup"
```

### Task 3: Add the ordinary CI build gate

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `packageManager: pnpm@10.32.1`, `pnpm run build`, and `pnpm test` from `package.json`.
- Produces: stable workflow/job identity `Build / build-and-test` subject to confirmation from the live PR check.

- [ ] **Step 1: Add the workflow**

```yaml
name: Build

on:
  pull_request:
  push:
    branches: [master]

permissions:
  contents: read

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Activate pnpm
        run: |
          corepack enable
          corepack prepare pnpm@10.32.1 --activate
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Build
        run: pnpm run build
      - name: Test
        run: pnpm test
```

- [ ] **Step 2: Validate workflow whitespace and intended diff**

Run: `git diff --check -- .github/workflows/ci.yml`

Expected: exit 0 with no whitespace errors.

- [ ] **Step 3: Commit the CI workflow**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: require build and tests on pull requests"
```

### Task 4: Verify, publish, and stop before ruleset mutation

**Files:**
- Verify only: `src/index.ts`, `src/__tests__/startup.test.ts`, `.github/workflows/ci.yml`, design and plan documents.

**Interfaces:**
- Consumes: local Git state and the GitHub PR check run.
- Produces: a pushed branch, open PR, and a ruleset-mutation proposal without applying it.

- [ ] **Step 1: Run fresh local verification**

Run: `pnpm run build`

Expected: exit 0.

Run: `pnpm test`

Expected: exit 0 with no failed tests.

- [ ] **Step 2: Review repository state**

Run: `git diff --check && git status --short && git log --oneline origin/master..HEAD`

Expected: only the known untracked user files remain; intended changes are committed as
separate design, plan/implementation, and CI changes.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin kastra-governance-evaluation
gh pr create --repo Kastalien-Research/websets-mcp-codemode --base master --head kastra-governance-evaluation
```

- [ ] **Step 4: Wait for and inspect the Build check**

Run: `gh pr checks <PR-number> --watch`

Expected: observe the exact status-check context and final result. Do not infer the context
from workflow YAML alone.

- [ ] **Step 5: Present the separate ruleset approval package**

Read `GET /repos/Kastalien-Research/websets-mcp-codemode/rulesets/16775881` again, then show:

- current ruleset JSON relevant to conditions and rules;
- exact observed check context;
- proposed rules array preserving every current entry and adding only
  `required_status_checks` with strict branch freshness; and
- the exact `gh api --method PUT` request body that would apply it.

Stop without sending the PUT request.

