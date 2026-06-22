---
name: websets-cohort-bios
description: >
  Produce uniform, verified background reviews / biographies / profiles for a SHORTLIST of
  entities (people or companies) by dispatching one research subagent per entity in parallel,
  then synthesizing and persisting the results. Use when the user asks for "bios", "background
  reviews", "profiles", "tell me about each of these", or a comparison across several candidates
  — especially after a [[websets-secondary-review]] produced a shortlist. For a single entity use
  [[deep-research-item]] instead; this is the parallel, many-entities harness.
argument-hint: [list of entities OR websetId + which items] 
user-invocable: true
allowed-tools: Task, Read, mcp__schwartz13-local__execute, mcp__schwartz13-local__search, mcp__exa__web_search_exa
---

# Websets Cohort Bios

Fan out parallel research subagents to build comparable background reviews across a shortlist,
then synthesize and persist. The value is *uniformity* (every bio answers the same questions) and
*parallelism* (one agent per entity, dispatched together).

## Observe — assemble the shortlist
- Take entities from the conversation, or pull from a Webset (`items.getAll`) and the survivor set
  of a [[websets-secondary-review]]. For each, gather the starting facts you already have
  (name, practice/company, location, contact, any prior verification) so agents enrich rather than
  rediscover.

## Act — dispatch one subagent per entity, in parallel
Send all `Task` calls in a **single message** so they run concurrently (`general-purpose`, or a
research agent like `scout`). Give every agent the **same strict contract**:

- **Inputs:** the subject + known starting facts ("verify, don't just repeat").
- **Verify these dimensions, each with a source URL:** education & training; board
  certification / credentials; years & career history; clinical/scope focus and fit for the stated
  use-case; affiliations; languages; accepted insurance / plans; **accepting-new-clients status**;
  reputation signals (ratings + review themes); and **public red flags** (licensing-board
  disciplinary actions, sanctions, malpractice) — report "none found" explicitly.
- **Rules:** no fabrication; mark uncertain items "unverified" with the reason; **disambiguate**
  from same-name individuals; resolve and call out conflicting data (stale directories, NPI
  mislabels, aggregator errors).
- **Output contract (identical for all):** ~250-word prose review + a "Quick facts" bullet block +
  a "Sources" URL list.

## Orient — synthesize
Collect the returns and produce: per-entity bios in a consistent shape, a comparison table, and a
**revised ranking** with tiers (e.g. top-pick / solid / caution). Surface cross-cutting caveats
once (e.g. "directory accepting/insurance flags go stale — confirm by phone"; "board portals
couldn't be queried directly — self-verify at the licensing board"). Honestly flag where your
synthesized ranking differs from anything previously stated, and name which record is canonical.

## Persist (optional, on request)
Write results back so they survive: for each item `store.syncItem(...)` then
`store.annotate({ itemId, type: 'background_review' | 'judgment' | 'contact_verified', value, source })`.
Read back with `store.query` to confirm counts. (If `store.*` errors on the SQLite binding, see
[[pnpm10-blocks-native-builds]].) A durable local markdown export is a fine fallback if the store
is unavailable.

## Notes
- Scale agent count to the shortlist; for >8 consider batching.
- Keep the per-agent prompt asking for *sources* — uncited claims are the main failure mode.
