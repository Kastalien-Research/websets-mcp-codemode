# CLAUDE.md

This repository is the **Websets Claude Code plugin**: a stdio MCP server + a realtime channel, packaged via `.claude-plugin/plugin.json`. It also ships an HTTP MCP entrypoint (`dist/index.js`) for Docker/hosted use, but the plugin path (`dist/stdio.js`) is now primary.

## Working Assumptions

- Treat the plugin install path (`dist/stdio.js` + `dist/channel.js` spawned as stdio subprocesses) as the primary runtime.
- HTTP/Docker is a secondary path for hosted deployments.
- Do not treat this as a published npm package.
- The `servers/` siblings (github-channel, linear-channel, agentmail, google-workspace, effect-airtable) have been removed from this repo.

## Useful Commands

```bash
npm install
npm run build
npm run stdio          # run the plugin entrypoint locally
npm run channel        # run the channel locally
npm start              # run the HTTP entrypoint
docker compose up --build
npm test
npm run test:e2e
```

## Architecture Snapshot

- `.claude-plugin/plugin.json` — plugin manifest (mcpServers, channels, userConfig).
- `.claude-plugin/marketplace.json` — marketplace entry for this plugin.
- `src/stdio.ts` boots the **plugin entrypoint**: stdio MCP transport + in-process Express webhook listener on `WEBSETS_HTTP_PORT` (default `7860`).
- `src/index.ts` boots the HTTP entrypoint (Docker/hosted) on the same port.
- `src/server.ts` exports `createMcpServer()`, `startWebhookListener()`, and the HTTP `createServer()` factory. MCP over `StreamableHTTPServerTransport` at `/mcp` is HTTP-only.
- `src/tools/operations.ts` exports the `OPERATIONS` registry, `dispatchOperation()`, and supporting utilities.
- `src/tools/catalog.ts` builds a searchable index of all 110 operations + workflows.
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
- `src/channel.ts` stdio channel server. Declares `claude/channel`, subscribes to the local SSE stream, emits `notifications/claude/channel`.
- `skills/{deep-research-item,verify-item,workflow-config}/` plugin-bundled skills, namespaced as `/websets:<name>`.

### MCP Tools

The `websets` MCP server exposes three tools:
1. **`search`** — Code Mode discovery: find operations by keyword/domain with brief/detailed/full schemas
2. **`execute`** — Code Mode execution: run JS code with `callOperation()` in a sandboxed `vm`
3. **`status`** — Account overview: webset counts, running tasks, active monitors, server capabilities

The `websets-channel` MCP server exposes no tools — it only pushes events via `notifications/claude/channel`.

## Verification

Do not use curl to verify behavior. Use the MCP `execute` tool with `callOperation()` — that's the Code Mode pattern this server is built on.

## Agent Guidance

- Keep docs aligned with the plugin-first install path. HTTP/Docker stays documented as a secondary option.
- Prefer removing stale local assistant scaffolding over preserving broken historical flows.
- For the load-bearing skill during plugin/channel work, use the in-repo `channels-mcp`, `channel-bridge`, and `code-mode-servers` skills under `.claude/skills/`.
