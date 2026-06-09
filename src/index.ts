#!/usr/bin/env node
import { createServer } from "./server.js";

function parsePort(): number {
  const portFlagIdx = process.argv.indexOf('--port');
  if (portFlagIdx !== -1) {
    const value = process.argv[portFlagIdx + 1];
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }

  const portEq = process.argv.find((arg) => arg.startsWith('--port='));
  if (portEq) {
    const parsed = Number(portEq.split('=')[1]);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }

  return Number(process.env.PORT) || 7860;
}

const defaultCompatModeRaw = process.env.MANAGE_WEBSETS_DEFAULT_COMPAT_MODE;
const defaultCompatMode = defaultCompatModeRaw === 'safe' ? 'safe' : 'strict';
if (
  defaultCompatModeRaw !== undefined &&
  defaultCompatModeRaw !== 'safe' &&
  defaultCompatModeRaw !== 'strict'
) {
  console.warn(
    `Invalid MANAGE_WEBSETS_DEFAULT_COMPAT_MODE="${defaultCompatModeRaw}". Using "strict".`,
  );
}

if (!process.env.EXA_WEBHOOK_SECRET) {
  console.warn(
    'NOTE: EXA_WEBHOOK_SECRET is not set. Per-webhook secrets captured at '
    + 'webhooks.create time will be used for signature verification; until at '
    + 'least one webhook is registered, POST /webhooks/exa accepts unsigned '
    + 'payloads.',
  );
}

const { app } = createServer({
  exaApiKey: process.env.EXA_API_KEY || '',
  defaultCompatMode,
  webhookSecret: process.env.EXA_WEBHOOK_SECRET,
  mcpServerName: process.env.MCP_SERVER_NAME || 'websets',
});

const PORT = parsePort();
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Websets MCP Server running on ${HOST}:${PORT}`);
  console.log(`MCP endpoints: http://localhost:${PORT}/ (Dedalus) and http://localhost:${PORT}/mcp (compat)`);
});
