#!/usr/bin/env node
import { createServer } from "./server.js";

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

const { app } = createServer({
  exaApiKey: process.env.EXA_API_KEY || '',
  defaultCompatMode,
  webhookSecret: process.env.EXA_WEBHOOK_SECRET,
  resourceUrl: process.env.DAUTH_RESOURCE_URL,
  authServerUrl: process.env.DAUTH_SERVER_URL,
  requiredScopes: process.env.DAUTH_SCOPES?.split(',').filter(Boolean),
  skipDAuth: process.env.DAUTH_SKIP_VALIDATION === 'true',
});

const PORT = process.env.PORT || 7860;

app.listen(PORT, () => {
  console.log(`Websets MCP Server running on port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/mcp`);
});
