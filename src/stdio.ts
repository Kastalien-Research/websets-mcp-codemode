#!/usr/bin/env node
// Plugin stdio entrypoint.
//
// Serves the Websets MCP server (search/execute/status/workflow) over stdio
// AND starts the Express webhook receiver in-process so Exa can POST events
// and the channel bridge can subscribe via SSE on localhost.
//
// Spawned by Claude Code via .claude-plugin/plugin.json mcpServers.websets.
// Logs go to stderr; stdout is reserved for the MCP transport.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, startWebhookListener } from "./server.js";

const compatRaw = process.env.MANAGE_WEBSETS_DEFAULT_COMPAT_MODE;
const defaultCompatMode = compatRaw === "strict" ? "strict" : "safe";
if (compatRaw !== undefined && compatRaw !== "safe" && compatRaw !== "strict") {
  console.error(
    `[websets-stdio] invalid MANAGE_WEBSETS_DEFAULT_COMPAT_MODE="${compatRaw}". Using "safe".`,
  );
}

const portEnv = process.env.WEBSETS_HTTP_PORT;
const port = portEnv ? Number(portEnv) : 7860;
if (Number.isNaN(port)) {
  console.error(`[websets-stdio] invalid WEBSETS_HTTP_PORT="${portEnv}", aborting.`);
  process.exit(1);
}

// Default to loopback. Webhook signature verification is optional, and the
// channel forwards events directly into the active Claude session — binding
// publicly would let anyone on the network inject fake events. Set
// WEBSETS_HTTP_HOST=0.0.0.0 only if you front this with a reverse proxy that
// performs its own auth (or have set EXA_WEBHOOK_SECRET).
const host = process.env.WEBSETS_HTTP_HOST ?? "127.0.0.1";

const { httpServer, port: actualPort } = startWebhookListener({
  port,
  host,
  secret: process.env.EXA_WEBHOOK_SECRET,
});

httpServer.on("listening", () => {
  console.error(
    `[websets-stdio] webhook listener on http://${host}:${actualPort}/webhooks/*`,
  );
});

httpServer.on("error", (err) => {
  console.error(`[websets-stdio] webhook listener error:`, err);
});

const mcp = createMcpServer({
  exaApiKey: process.env.EXA_API_KEY ?? "",
  defaultCompatMode,
});

await mcp.connect(new StdioServerTransport());
console.error(`[websets-stdio] MCP server connected via stdio`);

const shutdown = () => {
  httpServer.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
