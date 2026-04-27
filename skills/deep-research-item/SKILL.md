---
name: deep-research-item
description: Run comprehensive research on an entity — news, funding, tech stack, buyer mapping, angle building. Writes findings to the webset store and optionally to Airtable. Use after verification passes or when a channel event requires deep research on a specific entity.
argument-hint: [entityName domain websetId]
user-invocable: true
allowed-tools: Read, mcp__schwartz13-local__execute, mcp__schwartz13-local__search, mcp__airtable__execute
---

Deep research on **$0** (domain: `$1`, webset: `$2`).

## Procedure

### 1. Parallel Exa searches

Run these searches concurrently:

- `exa.search("$0 funding investors Series")` — funding history
- `exa.search("$0 tech stack engineering blog")` — technology signals
- `exa.search("$0 hiring jobs engineering")` — hiring signals and growth
- `exa.search("$0 news announcement 2025 2026")` — recent news
- `exa.findSimilar("https://$1")` — similar companies (competitive landscape)

### 2. Content extraction

For the top 3-5 most relevant URLs from step 1, run `exa.getContents` to extract full text. Focus on:
- Evidence of the signal that scored this entity
- Decision-maker names and roles
- Technology choices and infrastructure
- Recent milestones or pain points

### 3. Buyer mapping

From enrichments and research, identify:
- **Primary contact**: Name, title, email (from enrichments)
- **Role fit**: Why this person would care about what we offer
- **Org context**: Team size, reporting structure if visible

### 4. Angle building

Based on all signals, synthesize:
- **Hook**: The specific signal or event that makes this timely
- **Value prop**: What we can offer that maps to their situation
- **Risk**: What could make this a bad fit

### 5. Store results

Annotate the webset item:
```javascript
await callOperation('store.annotate', {
  itemId: '<item_id>',
  type: 'research_finding',
  value: JSON.stringify(researchBrief)
});
```

### 6. Airtable write (if target specified)

If the workflow config includes an Airtable target, upsert the research brief using the Airtable Code Mode execute tool.

### 7. Return brief

```json
{
  "entity": "$0",
  "domain": "$1",
  "signals": { "funding": "...", "tech": "...", "hiring": "...", "news": "..." },
  "buyer": { "name": "...", "title": "...", "email": "...", "fit": "..." },
  "angle": { "hook": "...", "value_prop": "...", "risk": "..." },
  "confidence": 0.0-1.0,
  "sources": ["url1", "url2", "..."],
  "similar_companies": ["...", "..."]
}
```

Report the brief to the user.
