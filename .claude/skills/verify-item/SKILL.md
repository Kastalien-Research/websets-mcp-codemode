---
name: verify-item
description: Verify a webset item's enrichments against public data using independent Exa searches. Returns structured verdict with confidence score, evidence, and discrepancies. Use when a channel event or workflow step requires enrichment verification before proceeding.
argument-hint: [websetId itemId entityName]
user-invocable: true
allowed-tools: Read, mcp__websets-codemode-local__execute, mcp__websets-codemode-local__search
---

Verify the enrichments for item `$1` in webset `$0` (entity: `$2`).

## Procedure

### 1. Fetch the item

```javascript
const item = await callOperation('items.get', { id: '$1', websetId: '$0' });
```

Extract: enrichments (email, phone, description, any custom), entity properties (name, URL, location), and evaluation criteria.

### 2. Independent verification via Exa

For each enrichment claim, run an independent search:

- **Email**: Search for the company name + "contact" or "email" — does the enriched email appear on their site or public directories?
- **Phone**: Search for the company name + "phone" — does the number appear publicly?
- **Description/About**: Search for the company name — does the public description match what Exa enriched?
- **URL**: Fetch the URL via `exa.getContents` — does it resolve? Does the content match the entity?

### 3. Cross-reference

For each enrichment:
- `confirmed` — independent source corroborates the value
- `plausible` — no contradiction found but no independent confirmation either
- `disputed` — independent source contradicts the enriched value
- `unverifiable` — no independent data available

### Known deception patterns (empirically validated 2026-07-10, 100+ person-entity webset)

Do not just check "does a source exist" — these specific patterns produced enriched values that
had a source, and were still wrong. Screen for each explicitly, they recur far more often than
outright missing data:

- **Liked/reposted content laundered into authorship.** The single largest failure mode found
  (~28% of rejections in one run): a paper, repo, or achievement belongs to someone whose post the
  candidate merely liked or shared, not something they authored. Before crediting a paper/repo to
  a person, confirm the actual byline/commit history names them — a mention on their feed is not
  evidence of authorship.
- **Circular self-report.** The only support for a claim is the candidate's own About-section
  prose, restated rather than corroborated. An independently-written source (paper, repo, press,
  employer page) is required before a claim counts as confirmed — self-description alone means
  `unverifiable` or `disputed`, never `confirmed`.
- **Name-collision misattribution.** A credential (paper, Scholar profile, award) actually belongs
  to a different person with the same or similar name. Cross-check employer, institution, and
  timeframe together, not name alone.
- **Tier/magnitude inflation.** Experience is padded with school years or unrelated roles (typical
  observed inflation: 1.5–2×, computed vs. self-reported); venue prestige is inflated (an arXiv
  preprint, workshop paper, or single-contributor-among-thousands credit reported as a top-tier
  publication); OSS "contribution" turns out to be a zero-commit fork.
- **Fabricated identifiers.** A specific-looking but nonexistent arXiv ID, degree, or repo name —
  specificity is not evidence; resolve the identifier and confirm it actually points to this
  person's claimed work.
- **Contact info is guessed, not sourced.** A plausible-format email/phone with no independent
  confirmation it belongs to this person — report the format-plausible-but-unconfirmed distinction
  rather than treating a plausible pattern as `confirmed`.

### 4. Return verdict

```json
{
  "entity": "$2",
  "itemId": "$1",
  "websetId": "$0",
  "overallVerdict": "confirmed | plausible | disputed",
  "confidence": 0.0-1.0,
  "enrichments": [
    { "field": "email", "value": "...", "verdict": "confirmed", "evidence": "Found on company contact page" },
    { "field": "phone", "value": "...", "verdict": "plausible", "evidence": "Not found independently but format is valid" }
  ],
  "discrepancies": [],
  "sources": ["url1", "url2"]
}
```

Report the verdict to the user. If this is part of a workflow chain, the calling context will use `confidence` as the gate value for the next step.
