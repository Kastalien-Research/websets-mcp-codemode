# Websets — Claude Code Plugin

Exa Websets packaged as a [Claude Code plugin](https://code.claude.com/docs/en/plugins).
Bundles the full Websets MCP server (search / execute / status — 110 operations across 12 domains plus 12 background workflows and a SQLite shadow store) **and** a realtime [channel](https://code.claude.com/docs/en/channels) that pushes Webset webhook events into your Claude Code session as they happen.

## What you get

When the plugin is enabled, two MCP servers spawn as stdio subprocesses:

- **`websets`** — Code-mode tools the model uses to drive Websets.
  - `search` — discover operations by keyword/domain
  - `execute` — run JS that calls `callOperation(name, args)` against any of the 110 operations
  - `status` — webset/task/monitor counts and capabilities
  - 12 background workflows (deep research, verified collection, semantic cron, qd winnow, …)
  - Local SQLite shadow store for annotations, scoring, and uninvestigated-item triage
- **`websets-channel`** — Pushes `webset.item.created`, `webset.item.enriched`, `webset.idle`, and `NEW_OPPORTUNITY_CANDIDATE` events into your session as `<channel source="websets-channel">…</channel>` blocks so Claude can react in real time.

Three Websets-specific skills install with the plugin and become invocable as:

- `/websets:deep-research-item`
- `/websets:verify-item`
- `/websets:workflow-config`

## Install

### From this repository (development)

```bash
# clone alongside your other plugins
git clone https://github.com/Kastalien-Research/websets-mcp-codemode
cd websets-mcp-codemode
npm install && npm run build
```

The first `npm install` compiles the `better-sqlite3` native binding and must be re-run if you switch Node versions.

Add the marketplace and install the plugin:

```bash
# in any Claude Code session
/plugin marketplace add /absolute/path/to/websets-mcp-codemode
/plugin install websets@websets-mcp-codemode
```

You'll be prompted for `EXA_API_KEY` (required, stored in your system keychain) and a few optional values.

During the channels research preview, you also need the `--dangerously-load-development-channels` flag and `--channels` to actually receive events:

```bash
claude \
  --dangerously-load-development-channels plugin:websets@websets-mcp-codemode \
  --channels plugin:websets@websets-mcp-codemode
```

### Plugin user config

Prompted at install time:

| Key | Type | Default | Notes |
|---|---|---|---|
| `exa_api_key` | string | — | Required. Sensitive — keychain-stored. |
| `exa_webhook_secret` | string | — | Optional. HMAC secret for `Exa-Signature` verification. Sensitive. |
| `websets_http_port` | number | `7860` | Local TCP port for `/webhooks/exa` intake and SSE. |
| `websets_db_path` | string | `${CLAUDE_PLUGIN_DATA}/websets.db` | SQLite shadow store path. |
| `compat_mode` | string | `safe` | `safe` or `strict` argument coercion. |

### Receiving Exa webhooks

The websets process listens on `http://localhost:${websets_http_port}/webhooks/exa`. Configure that URL in your Exa webhook destination (use a tunnel like ngrok if Exa needs to reach you over the public internet). The channel subscribes to `…/webhooks/events` SSE on the same port and forwards every event to Claude Code.

## Tools (code-mode)

### `search` — Discover operations

```json
{ "query": "create", "detail": "brief", "domain": "websets", "limit": 10 }
```

### `execute` — Run code in sandbox

```json
{
  "code": "const ws = await callOperation('websets.create', { searchQuery: 'AI startups', entity: { type: 'company' }, count: 10 });\nawait callOperation('websets.waitUntilIdle', { id: ws.id });\nreturn await callOperation('items.getAll', { websetId: ws.id });",
  "timeout": 60000
}
```

Sandbox globals: `callOperation(name, args)`, `console.log/warn/error`, `setTimeout`/`clearTimeout`.

### `status` — Account overview

Returns webset counts by status, running tasks, active monitors, and server capabilities. Good first call.

## Validation footguns

- `criteria` must be objects: `[{"description":"..."}]`
- `entity` must be an object: `{"type":"company"}`
- `options` must be objects: `[{"label":"..."}]`
- `cron` must use 5 fields

## HTTP / Docker mode (alternative)

The same codebase still runs as an HTTP MCP server with DAuth OAuth on port 7860 — used when hosting Websets behind a public URL rather than as a local plugin.

```bash
EXA_API_KEY=your-key docker compose up --build
```

```json
{
  "mcpServers": {
    "websets": {
      "type": "http",
      "url": "http://localhost:7860/mcp"
    }
  }
}
```

The plugin entrypoint is `dist/stdio.js`; the HTTP entrypoint is `dist/index.js`. Both live in this repo.

## Useful commands

```bash
npm install            # one-time
npm run build          # compile TS to dist/
npm run stdio          # run the plugin entrypoint locally (stdio MCP)
npm run channel        # run the channel locally (stdio MCP)
npm start              # run the HTTP server locally
npm test
npm run test:integration
npm run test:e2e
npm run test:workflows
docker compose up --build
```

## Architecture

- `src/stdio.ts` — plugin entrypoint. Stdio MCP transport + in-process Express webhook listener.
- `src/index.ts` — HTTP entrypoint (Docker/hosted).
- `src/server.ts` — `createMcpServer()`, `startWebhookListener()`, and the HTTP `createServer()` factory.
- `src/channel.ts` — stdio channel server. Subscribes to `…/webhooks/events` SSE and emits `notifications/claude/channel`.
- `src/tools/{search,execute,status}Tool.ts` — the three MCP tools.
- `src/tools/operations.ts` — `OPERATIONS` registry + `dispatchOperation()`.
- `src/handlers/` — domain handlers (websets, searches, items, enrichments, monitors, webhooks, imports, events, tasks, research, exa, github).
- `src/workflows/` — 12 background workflows registered into `tasks.create`.
- `src/webhooks/{receiver,eventBus,signature}.ts` — Express receiver, in-memory pub/sub, HMAC verification.
- `src/store/{db,operations}.ts` — SQLite shadow store + the `store.*` operations.
- `.claude-plugin/plugin.json` — plugin manifest.
- `.claude-plugin/marketplace.json` — single-entry marketplace pointing at this plugin.
- `skills/{deep-research-item,verify-item,workflow-config}/SKILL.md` — bundled skills.

## Resources

- [Exa Websets Documentation](https://docs.exa.ai/reference/websets)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code channels](https://code.claude.com/docs/en/channels)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
