---
name: verify-item
description: Verify a webset item's enrichments against public data using independent Exa searches. Returns structured verdict with confidence score, evidence, and discrepancies. Use when a channel event or workflow step requires enrichment verification before proceeding.
argument-hint: [websetId itemId entityName]
user-invocable: true
allowed-tools: Read, mcp__schwartz13-local__execute, mcp__schwartz13-local__search
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
