# CLAUDE.md

This repository is currently a Docker-first MCP server for Exa Websets.

## Working Assumptions

- Treat Docker and HTTP transport as the primary runtime.
- Do not treat this as a published npm package.
- If we add a non-Docker path later, that should be designed deliberately rather than inferred
  from stale docs.

## Useful Commands

```bash
docker compose up --build
npm run build
npm test
npm run test:e2e
```

## Architecture Snapshot

- `src/index.ts` boots the Express app and listens on port `7860`.
- `src/server.ts` exposes MCP over `StreamableHTTPServerTransport` at `/mcp`.
- `src/tools/operations.ts` exports the `OPERATIONS` registry, `dispatchOperation()`, and supporting utilities.
- `src/tools/catalog.ts` builds a searchable index of all 60 operations + workflows.
- `src/tools/searchTool.ts` registers the Code Mode `search` tool (operation discovery).
- `src/tools/sandbox.ts` executes LLM-generated JS in a `vm` sandbox with `callOperation` injected.
- `src/tools/executeTool.ts` registers the Code Mode `execute` tool (code execution).
- `src/handlers/` contains the domain handlers.
- `src/workflows/` contains background workflows invoked through `tasks.create`.
- `src/webhooks/receiver.ts` serves `POST /webhooks/exa` (Exa webhook receiver) and `GET /webhooks/events` (SSE stream).
- `src/webhooks/signature.ts` verifies `Exa-Signature` HMAC-SHA256 headers.
- `src/webhooks/eventBus.ts` decouples webhook ingestion from SSE delivery with SQLite persistence.
- `src/store/db.ts` SQLite shadow store for Webset items + local annotations layer.
- `src/store/operations.ts` exposes `store.annotate`, `store.getItem`, `store.listUninvestigated`, `store.query`.
- `src/channel.ts` standalone stdio MCP channel bridge for Claude Code webhook notifications.
- `src/lib/yelp.ts` Yelp Fusion HTTP client; `src/handlers/yelp.ts` exposes `yelp.*` business-discovery ops, persisted to the local store via `store.attachYelp` (`yelp_businesses` table).
- `src/handlers/connect.ts` exposes `connect.providers` (Exa Connect partner catalog). Connect itself is the `dataSources` param on `agentRuns.create`; `src/workflows/connectEnrich.ts` batch-enriches a webset and persists results via `store.attachConnect` (`connect_enrichments` table + `similarweb_v`/`firmographics_v` views).

### MCP Tools

The server exposes three tools:
1. **`search`** — Code Mode discovery: find operations by keyword/domain with brief/detailed/full schemas
2. **`execute`** — Code Mode execution: run JS code with `callOperation()` in a sandboxed `vm`
3. **`status`** — Account overview: webset counts, running tasks, active monitors, server capabilities

## Verification

Do not use curl to verify behavior. Use the MCP `execute` tool with `callOperation()` — that's the Code Mode pattern this server is built on.

## Agent Guidance

- Keep docs aligned with Docker-first operation.
- Prefer removing stale local assistant scaffolding over preserving broken historical flows.
- For the load-bearing skill during this refactor, use
  `/workspaces/openchatwidget/.agents/skills/code-mode-servers/SKILL.md`.
