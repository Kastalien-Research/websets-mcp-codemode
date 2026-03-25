# schwartz13 Examples

This server is Docker-first and exposes a single HTTP MCP endpoint at `/mcp`.
All examples below assume the server is already running.

## Start the Server

```bash
EXA_API_KEY=your-key docker compose up --build
```

## Client Configuration

```json
{
  "mcpServers": {
    "schwartz13": {
      "type": "http",
      "url": "http://localhost:7860/mcp"
    }
  }
}
```

## Unified Tool Shape

Every call goes through `manage_websets`:

```json
{
  "operation": "<domain>.<action>",
  "args": {
    "...": "operation-specific arguments"
  }
}
```

## Basic Collection Examples

### Create a webset

```json
{
  "operation": "websets.create",
  "args": {
    "searchQuery": "AI startups in San Francisco",
    "searchCount": 20,
    "entity": { "type": "company" }
  }
}
```

### Wait for completion

```json
{
  "operation": "websets.waitUntilIdle",
  "args": {
    "id": "ws_abc123",
    "timeout": 300000
  }
}
```

### Retrieve items

```json
{
  "operation": "items.getAll",
  "args": {
    "websetId": "ws_abc123",
    "maxItems": 200
  }
}
```

## Enrichment Example

```json
{
  "operation": "enrichments.create",
  "args": {
    "websetId": "ws_abc123",
    "description": "Annual revenue in USD",
    "format": "number"
  }
}
```

## Monitor Example

```json
{
  "operation": "monitors.create",
  "args": {
    "websetId": "ws_abc123",
    "cron": "0 9 * * 1",
    "timezone": "America/New_York",
    "query": "New AI startups in San Francisco",
    "entity": { "type": "company" },
    "count": 10,
    "behavior": "append"
  }
}
```

## Task Workflow Examples

### Search, enrich, and collect

```json
{
  "operation": "tasks.create",
  "args": {
    "type": "lifecycle.harvest",
    "args": {
      "query": "Developer tools startups",
      "entity": { "type": "company" },
      "count": 25,
      "enrichments": [
        { "description": "CEO name", "format": "text" },
        { "description": "Latest funding stage", "format": "text" }
      ]
    }
  }
}
```

### Multi-angle search

```json
{
  "operation": "tasks.create",
  "args": {
    "type": "convergent.search",
    "args": {
      "queries": [
        "autonomous driving startups",
        "self-driving vehicle companies",
        "robotaxi technology firms"
      ],
      "entity": { "type": "company" }
    }
  }
}
```

### Verified answer

```json
{
  "operation": "tasks.create",
  "args": {
    "type": "retrieval.verifiedAnswer",
    "args": {
      "query": "What are the main open-source vector databases?",
      "numValidation": 3
    }
  }
}
```

### Poll a task

```json
{
  "operation": "tasks.get",
  "args": {
    "taskId": "task_abc123"
  }
}
```

### Fetch the final task result

```json
{
  "operation": "tasks.result",
  "args": {
    "taskId": "task_abc123"
  }
}
```

## Exa Retrieval Examples

### Search the web directly

```json
{
  "operation": "exa.search",
  "args": {
    "query": "AI infrastructure startups",
    "numResults": 5
  }
}
```

### Read page contents

```json
{
  "operation": "exa.getContents",
  "args": {
    "urls": [
      "https://example.com/article-1",
      "https://example.com/article-2"
    ]
  }
}
```

## Input Format Reminders

- `entity` should be an object: `{"type":"company"}`
- `criteria` should be objects: `[{"description":"has funding"}]`
- `options` should be objects: `[{"label":"Seed"}]`
- `cron` uses 5 fields

If you enable `compat.mode = "safe"`, the server can coerce a narrow set of common input
mistakes.
