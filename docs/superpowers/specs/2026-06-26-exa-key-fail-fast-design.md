# Fail fast on missing EXA_API_KEY instead of a silent dummy key

**Issue:** [#40](https://github.com/Kastalien-Research/websets-mcp-codemode/issues/40) — server falls back to `dummy-key-for-testing` when `EXA_API_KEY` is unset, delaying failure.

## Problem

`createServer` does `new Exa(config.exaApiKey || 'dummy-key-for-testing')`
(`src/server.ts:61`). When `EXA_API_KEY` is missing, `index.ts` passes `''` and the
placeholder key is used, so a misconfiguration only surfaces later as an auth error
on the first API call — which reads like a credential problem rather than "key not
configured". Violates fail-fast with clear, actionable messages.

The placeholder is load-bearing: `new Exa('')` throws
(`API key must be provided ...`), and the e2e health tests construct
`createServer({ exaApiKey: '' })` directly. So the fix cannot simply remove it.

## Design

Guard at the entrypoint, not in the factory.

- **New `src/config.ts`** with a pure `resolveExaApiKey(env)`:
  - `EXA_API_KEY` set (non-blank) → `{ apiKey }`.
  - unset/blank + `ALLOW_NO_EXA_KEY === '1'` → `{ apiKey: '', warning }` (explicit
    keyless boot for tests/CI).
  - unset/blank + no flag → throws an `Error` whose message names both
    `EXA_API_KEY` and the `ALLOW_NO_EXA_KEY` escape hatch.
- **`src/index.ts`** calls `resolveExaApiKey(process.env)`: on success passes the key
  to `createServer` (and `console.warn`s any warning); on throw, `console.error`s the
  message and `process.exit(1)` before binding the port.
- **`src/server.ts`** keeps the placeholder fallback (load-bearing) with a comment
  noting production boot is guarded in `index.ts` and this path is only reached via
  explicit keyless boot or tests. `createServer` stays a pure factory.

Rationale: `createServer` is injectable and unit-testable (tests pass `exaApiKey: ''`);
`index.ts` owns env→config translation and is the right place to enforce required
configuration. `index.ts` runs `app.listen` at import time, so the guard logic lives
in `config.ts` to be unit-tested without booting a server.

## Tests

New `src/__tests__/config.test.ts` (vitest):

- key set → returned, no warning.
- unset + no flag → throws; message contains `EXA_API_KEY` and `ALLOW_NO_EXA_KEY`.
- blank/whitespace key → throws.
- unset + `ALLOW_NO_EXA_KEY=1` → empty key + warning mentioning the flag.
- `ALLOW_NO_EXA_KEY` value other than `"1"` → still throws.
- real key present alongside `ALLOW_NO_EXA_KEY=1` → key wins, no warning.

Runtime verification via `node dist/index.js`:
- no key/flag → exits 1 with the actionable message.
- `ALLOW_NO_EXA_KEY=1` → warns and boots.

## Scope

- Added: `src/config.ts`, `src/__tests__/config.test.ts`.
- Changed: `src/index.ts` (guard), `src/server.ts` (clarifying comment only).
- Pre-existing unrelated failures in
  `src/handlers/__tests__/integration/errors/type-format.test.ts` are out of scope.
