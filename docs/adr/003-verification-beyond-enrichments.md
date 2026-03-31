# ADR-003: Verification Beyond Enrichments

**Status**: Accepted
**Date**: 2026-03-31
**Deciders**: b.c.nims

## Context

When Exa Websets returns search results with enrichments, the obvious verification step is to check whether the enrichment data is accurate: does this GitHub profile exist, is the email valid, did Exa hallucinate a repo name.

But in practice, enrichment accuracy is the *easy* problem. The hard problem is **entity fitness** — does this result actually match the intent behind the search? Exa's semantic search is good at finding entities that are *related* to a query, but "related" is not the same as "fits."

### The lawn care problem

A webset searching for "lawn care companies in Huntsville, AL" returned:
- **Turner Pest Control** (Jacksonville, FL) — a pest control company, not lawn care
- **Pierce Lawn Care** (Mason, OH) — a lawn care company, but 600 miles away
- **Alabama Arbor** — a tree service company that doesn't do lawn maintenance

All three had accurate enrichments. Their emails were real, their websites were live, their company names were correct. A naive enrichment-only verification would have scored them as high-confidence results. But they were all **wrong answers to the user's question**.

### The person problem

The same pattern applies to person searches. A webset searching for "developers building MCP servers" will return people who:
- Wrote one blog post about MCP but never built anything
- Work at a company that builds MCP tools (they're employees, not independent creators)
- Have a GitHub profile that mentions MCP in a fork, not original work

Enrichment verification confirms the person exists. Fitness verification asks whether they match what you're actually looking for.

## Decision

The `verify.enrichments` workflow performs **three tiers of verification**, not one:

### Tier 1: Fitness verification (search intent match)

Before checking any enrichment data, verify that the entity belongs in this result set at all.

- **Service fitness**: Fetch the entity's actual website/profile and check whether it mentions the specific services, skills, or attributes from the original search query. A pest control company's website will not mention "mowing" — that's a hard signal.
- **Location fitness**: Compare the entity's stated location against the search's target area. A company in Ohio doesn't serve Huntsville, regardless of how good its reviews are.
- **Activity fitness** (for persons): Check whether the entity is actively doing the thing the search was about, not just tangentially connected to it.

Entities that fail fitness checks are **deleted from the webset**, not just flagged. The reasoning: a result that doesn't fit the search intent is not a low-quality result — it's a wrong result. Keeping it pollutes downstream workflows (outreach, scoring, Airtable syncs) with noise that every subsequent step has to re-filter.

### Tier 2: Enrichment verification (data accuracy)

For entities that pass fitness checks, verify enrichment fields using the most authoritative source available:

| Field type | Verification method | Rationale |
|---|---|---|
| GitHub URL/profile | GitHub API `/users/{username}` | Authoritative — the profile either exists or it doesn't |
| GitHub repo | GitHub API `/repos/{owner}/{repo}` | Authoritative — the repo either exists or it doesn't |
| Programming language | GitHub API repos by user, check top languages | Empirical — what they actually commit, not what Exa inferred |
| Email | DNS MX record lookup | Structural — domain can receive mail or it can't |
| X/Twitter data | Trust Exa's enrichment | No reliable independent API; Exa has direct access |
| General claims | Exa search for corroboration | Best-effort cross-reference |

The hierarchy is: **API > DNS > cross-reference > trust source**. Use the most authoritative check available; fall back to weaker methods only when necessary.

### Tier 3: Calibration (accuracy over time)

Each verification run records a calibration snapshot:
- Total items checked, total deleted, deletion rate
- Per-field statistics (verified/unverified/contradicted/not_checkable)
- Service fitness and location fitness breakdowns
- Duration and search query context

These accumulate in SQLite, giving empirical data on how well Exa's results match different query types over time. If deletion rates are consistently high for a category of query, that's a signal to adjust the search strategy upstream — not just verify harder downstream.

## Consequences

### Positive
- Downstream workflows (outreach, Airtable sync, scoring) receive only entities that actually match the search intent
- Fitness failures are caught early, before money is spent on deep research or human review
- Calibration data creates a feedback loop: bad search patterns become visible over time
- Deleted items are annotated with reasons before removal, preserving the audit trail

### Negative
- Verification is more expensive per item (website fetch + enrichment checks vs. enrichment checks alone)
- Service keyword extraction is pattern-based and won't catch every mismatch
- Deletion is irreversible from the webset (though the item and deletion reason persist in SQLite)

### Design constraints
- Fitness checks run *before* enrichment checks — fail fast on the cheapest, most decisive signal
- Items that fail fitness are deleted, not just annotated — wrong results are worse than missing results
- The workflow must work for both `person` and `company` entity types, with different fitness strategies for each
- All results persist to SQLite regardless of outcome, so calibration data includes deletions

## Related
- ADR-001: Unified Dispatcher Refactoring (the dispatch layer these workflows run through)
- `src/workflows/verifyEnrichments.ts` (implementation)
- `src/lib/emailCheck.ts` (MX record verification)
- `src/store/db.ts` (SQLite persistence for items, annotations, and calibration)
