# Mark connect.providers output as a curated static catalog

**Issue:** [#42](https://github.com/Kastalien-Research/websets-mcp-codemode/issues/42) — `connect.providers` static catalog can be mistaken for live Exa entitlement state.

## Problem

`connect.providers` returns a curated, in-repo static catalog (`PROVIDER_CATALOG`)
with `status: active|gated`. The source comments are honest that it is static, but
the operation *output* does not self-identify as curated. An agent could read
`status: 'active'`/`'gated'` as **this account's** live entitlements rather than
general self-serve availability.

## Design

Make the response self-describing; no change to the catalog data or filters.

- The `providers` handler response gains three fields ahead of the existing
  `count`/`providers`:
  - `source: 'curated-static'`
  - `verifiedAt: '2026-06-26'`
  - `note`: explains the list is in-repo (not live entitlements) and that
    `gated` ≠ account entitlement, `active` ≠ provisioned.
- The `connect.providers` op summary (`src/tools/operations.ts`) is updated to say
  the list is a curated in-repo catalog, not live entitlements, and that `gated`
  means "requires Exa activation".

Existing `count` and `providers` keys are unchanged (additive, non-breaking).

## Tests

Extend `src/handlers/__tests__/connect.test.ts`: assert the default response carries
`source: 'curated-static'`, `verifiedAt: '2026-06-26'`, and a `note` string that
mentions entitlement. Existing count/filter tests remain.

Runtime verification via the MCP `execute` tool: `callOperation('connect.providers', {})`
returns the curated markers.

## Scope

- Changed: `src/handlers/connect.ts`, `src/tools/operations.ts`.
- Test: `src/handlers/__tests__/connect.test.ts`.
- Non-goal: fetching live entitlement state (no such Exa endpoint is used here).
