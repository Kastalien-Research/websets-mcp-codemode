# Websets Code Mode MCP

Docker-first MCP server for [Exa's Websets API](https://docs.exa.ai/reference/websets).
The current runtime model is an HTTP MCP server behind Docker. It is not a published npm
package today, and any non-Docker path should be treated as future work until we design it
explicitly.

## Current Shape

- MCP transport: HTTP at `/mcp`
- Primary runtime: Docker Compose
- Primary server entrypoints:
  - `src/index.ts`
  - `src/server.ts`
- Three MCP tools: `search`, `execute`, `status`

## Quick Start

### Prerequisites

- Docker / Docker Compose
- `EXA_API_KEY`

### Run

```bash
EXA_API_KEY=your-key docker compose up --build
```

The server listens on port `7860` by default.

### Connect an MCP Client

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

## Tools

The server exposes three MCP tools.

### `search` — Discover operations

Find available API operations by keyword, domain, or pattern. Use before writing code for `execute`.

```json
{ "query": "create", "detail": "brief", "domain": "websets", "limit": 10 }
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Keyword, domain name, or description |
| `detail` | `"brief"` \| `"detailed"` \| `"full"` | `"brief"` | Schema detail level |
| `domain` | string | — | Filter to a domain |
| `limit` | number | 10 | Max results |

### `execute` — Run code in sandbox

Execute JavaScript with `callOperation(name, args)` and an authenticated `exa` SDK client injected into a sandboxed VM.

```json
{
  "code": "const ws = await callOperation('websets.create', { searchQuery: 'AI startups', entity: { type: 'company' }, count: 10 });\nawait callOperation('websets.waitUntilIdle', { id: ws.id });\nreturn await callOperation('items.getAll', { websetId: ws.id });",
  "timeout": 60000
}
```

Sandbox globals:
- `callOperation(name, args)` — dispatch to any of the 60 operations
- `console.log/warn/error` — captured and returned with results

### `status` — Account overview

Returns current account state: webset counts by status, running tasks, active monitors, and server capabilities. Call this first to orient.

Long-running workflows are created with `tasks.create` and polled with `tasks.get` /
`tasks.result`.

## Local Development

Docker is the primary runtime, but local Node-based development is still useful while
iterating on the server:

```bash
npm install
npm run build
npm start
```

## Compatibility Mode

`MANAGE_WEBSETS_DEFAULT_COMPAT_MODE` controls the default argument coercion mode:

- `strict` (default)
- `safe`

Per-call `args.compat.mode` overrides the server default.

## Validation Footguns

- `criteria` must be objects: `[{"description":"..."}]`
- `entity` must be an object: `{"type":"company"}`
- `options` must be objects: `[{"label":"..."}]`
- `cron` must use 5 fields

## Useful Commands

```bash
npm test
npm run test:integration
npm run test:e2e
npm run test:workflows
docker compose up --build
docker compose down
```

## Resources

- [Exa Websets Documentation](https://docs.exa.ai/reference/websets)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
