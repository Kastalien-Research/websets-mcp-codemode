# enrichments.update returns confirmed state

**Issue:** [#43](https://github.com/Kastalien-Research/websets-mcp-codemode/issues/43) — `enrichments.update` returns a synthesized `{success:true}` instead of confirmed state.

## Problem

`exa.websets.enrichments.update(...)` returns `void`, so the handler returned a
locally synthesized `{ success: true, enrichmentId }`. This is accurate (a
non-throwing await means the update succeeded), but unlike its sibling ops
(create/get/cancel/delete, which all return the projected enrichment) it returns a
synthesized shape rather than fetched confirmation. Reviewers/agents might mistake
the synthesized object for fabricated data.

## Design

After a successful `update`, fetch the enrichment with
`exa.websets.enrichments.get(websetId, enrichmentId)` and return
`projectEnrichment(...)` — identical to the sibling ops, returning confirmed live
state. Costs one extra GET per update (acceptable for a config-mutation op).
Failures still throw and route through `errorResult`.

The `enrichments.update` op summary notes it returns the refetched enrichment.

## Tests

`src/handlers/__tests__/enrichments.test.ts` gains a `describe('enrichments.update')`:
- success path mocks `update` (void) + `get` (enrichment) and asserts the handler
  calls both with the right args and returns the projected enrichment (`id`,
  `status`), with no `success` field.
- error path: `update` rejects → `isError: true`.

The existing live integration test (`integration/enrichments.test.ts`,
"enrichments.update — updates the enrichment description") asserts no-error and
continues to pass with the added refetch.

## Scope

- Changed: `src/handlers/enrichments.ts`, `src/tools/operations.ts`.
- Test: `src/handlers/__tests__/enrichments.test.ts`.
- Pre-existing unrelated failures in
  `src/handlers/__tests__/integration/errors/type-format.test.ts` are out of scope.
