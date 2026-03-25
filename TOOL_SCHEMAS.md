# Websets MCP Tool Schema Reference

This server exposes **three MCP tools**:

1. **`search`** — Code Mode discovery tool: find operations by keyword/domain
2. **`execute`** — Code Mode execution tool: run JS code with `callOperation()` in a sandbox
3. **`status`** — Account overview: webset counts, running tasks, monitors, capabilities

---

## Code Mode Tools (Recommended)

### `search` — Discover operations

Find available operations by keyword, domain, or pattern before writing code for `execute`.

```json
{
  "query": "create",
  "detail": "brief",
  "domain": "websets",
  "limit": 10
}
```

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search keyword, domain name, or description |
| `detail` | `"brief"` \| `"detailed"` \| `"full"` | `"brief"` | Level of schema detail |
| `domain` | string | — | Filter to domain: websets, searches, items, enrichments, monitors, webhooks, imports, events, tasks, research, exa, workflow |
| `limit` | number | 10 | Max results |

### `execute` — Run code in sandbox

Execute JavaScript with access to all API operations and the Exa SDK.

```json
{
  "code": "const ws = await callOperation('websets.create', {\n  searchQuery: 'AI startups',\n  entity: { type: 'company' },\n  count: 10\n});\nawait callOperation('websets.waitUntilIdle', { id: ws.id });\nconst items = await callOperation('items.getAll', { websetId: ws.id });\nreturn items;",
  "timeout": 60000
}
```

**Sandbox globals:**
- `callOperation(name, args)` — dispatch to any operation (validated + coerced)
- `console.log/warn/error` — captured and returned with results

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `code` | string | required | JavaScript code (runs as async function body, use `return`) |
| `timeout` | number | 30000 | Execution timeout in ms (max 120000) |

---

## Parameter Format Rules

**These are the top agent footguns — get them right:**

| Parameter | Correct | Wrong |
|-----------|---------|-------|
| `criteria` | `[{"description": "..."}]` | `["criterion 1"]` |
| `entity` | `{"type": "company"}` | `"company"` |
| `options` | `[{"label": "..."}]` | `["option1"]` |
| `cron` | `"0 9 * * 1"` (5 fields) | `"0 0 9 * * 1"` (6 fields) |

### Compatibility Mode

By default, validation uses safe mode with deterministic coercions. You can opt into strict validation per call with `compat.mode = "strict"`:

```json
{
  "operation": "searches.create",
  "args": {
    "compat": { "mode": "safe" },
    "websetId": "ws_abc123",
    "query": "AI startups in SF",
    "entity": "company",
    "criteria": ["has funding"],
    "count": "25"
  }
}
```

Safe mode coercions:
- `entity`: `"company"` -> `{"type":"company"}` (known types only)
- `criteria` / `searchCriteria`: `["x"]` -> `[{"description":"x"}]`
- `options`: `["A","B"]` -> `[{"label":"A"},{"label":"B"}]`
- selected numeric fields: `"25"` -> `25`
- selected boolean fields: `"true"` / `"false"` -> `true` / `false`

Not coerced:
- Cron/date formats
- Enum case normalization
- Complex nested schemas

If coercions are applied, successful responses include `_coercions` and optional `_warnings`.

### Server-Level Default Compat Mode

Set `MANAGE_WEBSETS_DEFAULT_COMPAT_MODE` at server startup:
- `safe` (default)
- `strict`

Precedence rules:
- Per-call `args.compat.mode` overrides server default.
- `args.compat.mode = "strict"` forces strict validation for that call.

### Dry-Run Coercion Preview

Set `args.compat.preview = true` to preview coercions without executing the operation.

Preview response includes:
- `preview: true`
- `execution: "skipped"`
- `normalizedArgs`
- `_coercions` / `_warnings` when relevant

---

## Core CRUD Operations

### websets.create — Create a webset with search + enrichments

```json
{
  "operation": "websets.create",
  "args": {
    "searchQuery": "AI startups in San Francisco",
    "searchCount": 20,
    "entity": {"type": "company"},
    "searchCriteria": [
      {"description": "Founded after 2020"},
      {"description": "Has more than 10 employees"}
    ],
    "enrichments": [
      {"description": "CEO name", "format": "text"},
      {
        "description": "Company stage",
        "format": "options",
        "options": [
          {"label": "Seed"},
          {"label": "Series A"},
          {"label": "Series B+"},
          {"label": "Public"}
        ]
      },
      {"description": "Annual revenue in USD", "format": "number"}
    ]
  }
}
```

### items.list — List items in a webset

```json
{
  "operation": "items.list",
  "args": {
    "websetId": "ws_abc123",
    "limit": 50
  }
}
```

### enrichments.create — Add an enrichment to a webset

```json
{
  "operation": "enrichments.create",
  "args": {
    "websetId": "ws_abc123",
    "description": "Primary contact email address",
    "format": "email"
  }
}
```

### monitors.create — Schedule automatic updates

```json
{
  "operation": "monitors.create",
  "args": {
    "websetId": "ws_abc123",
    "cron": "0 9 * * 1",
    "timezone": "America/New_York",
    "query": "New AI startups in 2025",
    "entity": {"type": "company"},
    "count": 10,
    "behavior": "append"
  }
}
```

---

## Convenience Operations

### websets.waitUntilIdle — Poll until webset finishes processing

```json
{
  "operation": "websets.waitUntilIdle",
  "args": {
    "id": "ws_abc123",
    "timeout": 300000
  }
}
```

### items.getAll — Auto-paginate all items

```json
{
  "operation": "items.getAll",
  "args": {
    "websetId": "ws_abc123",
    "maxItems": 500
  }
}
```

---

## Research Operations

### research.create — Start a research request

```json
{
  "operation": "research.create",
  "args": {
    "instructions": "What are the leading approaches to protein folding prediction?",
    "model": "exa-research"
  }
}
```

Models: `"exa-research-fast"`, `"exa-research"`, `"exa-research-pro"`

### research.pollUntilFinished — Wait for research to complete

```json
{
  "operation": "research.pollUntilFinished",
  "args": {
    "researchId": "res_abc123",
    "timeoutMs": 300000
  }
}
```

---

## Workflow Tasks

Background tasks orchestrate multi-step research patterns. Create with `tasks.create`, poll with `tasks.get`, get results with `tasks.result`.

### lifecycle.harvest — Search + enrich + collect

```json
{
  "operation": "tasks.create",
  "args": {
    "type": "lifecycle.harvest",
    "args": {
      "query": "AI startups in San Francisco",
      "entity": {"type": "company"},
      "enrichments": [
        {"description": "CEO name", "format": "text"},
        {"description": "Annual revenue in USD", "format": "number"}
      ],
      "count": 25,
      "cleanup": false
    }
  }
}
```

### convergent.search — Multi-angle triangulation

```json
{
  "operation": "tasks.create",
  "args": {
    "type": "convergent.search",
    "args": {
      "queries": [
        "companies building autonomous vehicles",
        "self-driving car startups with funding",
        "autonomous driving technology firms"
      ],
      "entity": {"type": "company"},
      "count": 25
    }
  }
}
```

### adversarial.verify — Thesis vs antithesis

```json
{
  "operation": "tasks.create",
  "args": {
    "type": "adversarial.verify",
    "args": {
      "thesis": "Remote work improves developer productivity",
      "thesisQuery": "studies showing remote work boosts developer output",
      "antithesisQuery": "studies showing remote work hurts developer productivity",
      "entity": {"type": "article"},
      "synthesize": true
    }
  }
}
```

### qd.winnow — Quality-diversity analysis

```json
{
  "operation": "tasks.create",
  "args": {
    "type": "qd.winnow",
    "args": {
      "query": "AI safety research labs",
      "entity": {"type": "company"},
      "criteria": [
        {"description": "Publishes peer-reviewed papers"},
        {"description": "Has government funding"},
        {"description": "Founded before 2020"}
      ],
      "enrichments": [
        {"description": "Number of published papers", "format": "number"},
        {"description": "Primary research focus", "format": "text"}
      ],
      "selectionStrategy": "diverse"
    }
  }
}
```

### research.deep — Deep research question

```json
{
  "operation": "tasks.create",
  "args": {
    "type": "research.deep",
    "args": {
      "instructions": "What are the top AI safety labs and their key contributions?",
      "model": "exa-research"
    }
  }
}
```

### research.verifiedCollection — Collection + per-entity research

```json
{
  "operation": "tasks.create",
  "args": {
    "type": "research.verifiedCollection",
    "args": {
      "query": "AI safety research labs",
      "entity": {"type": "company"},
      "researchPrompt": "Research {{name}} and describe their main contributions to AI safety",
      "researchLimit": 10
    }
  }
}
```

### Checking task status

```json
{"operation": "tasks.get", "args": {"taskId": "task_abc123"}}
{"operation": "tasks.result", "args": {"taskId": "task_abc123"}}
{"operation": "tasks.list", "args": {"status": "running"}}
{"operation": "tasks.cancel", "args": {"taskId": "task_abc123"}}
```

---

## Valid Entity Types

- `"company"` — Business entities
- `"person"` — Individual people
- `"article"` — News articles, blog posts
- `"research_paper"` — Academic papers
- `"custom"` — Custom entity type

## Valid Enrichment Formats

- `"text"` — Free-form text
- `"number"` — Numeric values
- `"date"` — Date values
- `"options"` — Choose from predefined options (requires `options` array)
- `"email"` — Email addresses
- `"phone"` — Phone numbers
- `"url"` — URLs
