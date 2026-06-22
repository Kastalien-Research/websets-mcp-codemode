---
name: websets-secondary-review
description: >
  Secondary review / verification pass over an existing Webset against a target persona or
  use-case. Classifies every result as keep / scope-mismatch / hard-disqualify, web-verifies
  the ambiguous ones, deletes the bad results (with confirmation), and annotates the survivors.
  Use whenever the user asks to "secondary review", "verify", "filter", "clean up", "curate",
  or "find results appropriate for <a specific person/use-case>" on a Webset. The Webset's
  own built-in evaluations are unreliable — this re-checks them independently.
argument-hint: [websetId or webset name] + [target persona / use-case]
user-invocable: true
allowed-tools: Read, mcp__schwartz13-local__status, mcp__schwartz13-local__search, mcp__schwartz13-local__execute, mcp__exa__web_search_exa, WebFetch
---

# Websets Secondary Review

Re-review an existing Webset against a concrete persona/use-case. This is a Code Mode skill —
discover with `search`, act with `execute` + `callOperation` (see [[code-mode-servers]]). Verify
behavior through `execute`, never curl (per CLAUDE.md).

## Observe — load the Webset
1. `status` to orient. Resolve the target Webset: accept a `webset_...` id directly, or match by
   name via `websets.getAll` (the `recent` query field is often empty — match on `searches[].query`
   or ask the user for the id / share the dashboard URL, whose last path segment is the id).
2. `items.getAll({ websetId, maxItems })`. Pull `name`, `url`, `description`, `evaluations`, and
   `enrichments` for every item. **Dedupe by person/entity** — the same entity often appears 2–3×
   as separate `witem_` ids; a deletion must remove every copy.

## Orient — decode the persona into disqualifiers
Translate the use-case into explicit, checkable criteria. Example (adult male, non-military,
wants a PCP not a specialist) →
- **Hard-disqualify (unambiguous, errors):** wrong location (e.g. same city name, wrong state),
  wrong domain entirely (a vet in a physician list), wrong sub-population (pediatric for an adult),
  ineligible institution (VA/military for a civilian).
- **Scope mismatch (judgment):** specialists vs the requested generalist, inpatient-only
  (hospitalists), occupational/urgent-care/concierge/wellness when continuity care is wanted,
  out-of-area / virtual-only.
- **Credential mismatch:** e.g. NP vs MD if "physician" is required — flag, don't assume.

Do **not** trust the Webset's `evaluations` (they returned yes/yes for obviously wrong results in
practice). Classify from the description + enrichments, and escalate the genuinely ambiguous to
web verification.

## Decide & Act — tiered, confirmed deletion
1. Present the classification first (keep / scope-mismatch / hard-disqualify), with counts and the
   reason per item. **Deletion is a live write to Exa — confirm with the user before deleting.**
2. **Round 1:** delete the hard-disqualified (unambiguous). Use `items.delete({ websetId, itemId })`,
   one call per `witem_` id (loop with per-item try/catch; report deleted vs error). Re-count after.
3. **Round 2:** web-verify the ambiguous group with `mcp__exa__web_search_exa` (does this provider
   actually offer the requested service to this persona? accepting new patients? right location?).
   Then delete the ones verification disqualifies — again with confirmation.
4. Iterate further trims on request (e.g. drop NPs, drop virtual-only).

## Persist — annotate survivors
For each kept item you want to record judgment on:
1. `store.syncItem({ id, websetId, name, url, entityType, enrichments, evaluations, raw })` to mirror
   the item into the local shadow (required — annotations FK to a local `items` row).
2. `store.annotate({ itemId, type, value, source })` — use stable types like `judgment`,
   `background_review`, `contact_verified`; set `source` to something traceable (e.g.
   `secondary-review`). Read back with `store.getItem` / `store.query` to confirm.

> If `store.*` fails with "Could not locate the bindings file", the SQLite native module didn't
> build — see [[pnpm10-blocks-native-builds]].

## Deliver
A revised ranking/shortlist with contact info and one-line rationale per survivor, the deletion
log (counts per round + reasons), and a flag that the Webset's built-in evaluations were
unreliable. Related: [[verify-item]] (single-item enrichment check), [[deep-research-item]]
(single-entity deep dive), [[websets-cohort-bios]] (background reviews for the shortlist).
