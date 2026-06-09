import type { Request } from 'express';

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Stainless/Dedalus injects per-user secrets via this header on hosted MCP
 * requests. See dedalus-typescript packages/mcp-server/src/http.ts.
 */
export function parseUpstreamClientEnvs(req: Request): Record<string, string> | undefined {
  const raw = headerValue(req, 'x-stainless-mcp-client-envs');
  if (!raw) return undefined;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }

    const envs: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') envs[key] = value;
    }
    return Object.keys(envs).length > 0 ? envs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Exa API key for an MCP request.
 *
 * Priority (highest first):
 * 1. EXA_API_KEY from x-stainless-mcp-client-envs (Dedalus Required Credentials)
 * 2. x-api-key header (Exa MCP convention)
 * 3. Authorization: Bearer <key>
 * 4. Server fallback (process.env.EXA_API_KEY at boot)
 */
export function resolveExaApiKey(req: Request, fallback = ''): string {
  const upstream = parseUpstreamClientEnvs(req);
  if (upstream?.EXA_API_KEY) return upstream.EXA_API_KEY;

  const xApiKey = headerValue(req, 'x-api-key');
  if (xApiKey) return xApiKey;

  const authorization = headerValue(req, 'authorization');
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }

  return fallback;
}
