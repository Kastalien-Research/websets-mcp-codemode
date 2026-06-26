#!/usr/bin/env node
import { createServer } from "./server.js";
import { resolveExaApiKey } from "./config.js";

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

let exaApiKey: string;
try {
  const resolved = resolveExaApiKey(process.env);
  exaApiKey = resolved.apiKey;
  if (resolved.warning) console.warn(resolved.warning);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const { app } = createServer({
  exaApiKey,
  defaultCompatMode,
  webhookSecret: process.env.EXA_WEBHOOK_SECRET,
});

const PORT = process.env.PORT || 7860;

app.listen(PORT, () => {
  console.log(`Websets MCP Server running on port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/mcp`);
});
