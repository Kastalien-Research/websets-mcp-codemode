// DAuth middleware: validates Bearer tokens from Dedalus's authorization server.
//
// Adds three things to the Express app:
//   1. GET /.well-known/oauth-protected-resource — resource metadata
//   2. Bearer token requirement on /mcp — returns 401 with WWW-Authenticate if missing
//   3. JWT validation — verifies signature against DAuth JWKS, checks issuer + audience

import type { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface DAuthConfig {
  /** The public URL of this MCP server (used as the OAuth resource identifier) */
  resourceUrl: string;
  /** DAuth authorization server URL. Defaults to https://as.dedaluslabs.ai */
  authServerUrl?: string;
  /** Required scopes for all requests. Defaults to [] (no scope requirement) */
  requiredScopes?: string[];
  /** Skip token validation (for local development). Defaults to false */
  skipValidation?: boolean;
}

interface DAuthState {
  jwks: ReturnType<typeof createRemoteJWKSet>;
  issuer: string;
  resourceUrl: string;
  requiredScopes: string[];
  skipValidation: boolean;
}

let state: DAuthState | null = null;

export function initDAuth(config: DAuthConfig): void {
  const authServerUrl = config.authServerUrl ?? 'https://as.dedaluslabs.ai';
  const jwksUrl = new URL('/.well-known/jwks.json', authServerUrl);

  state = {
    jwks: createRemoteJWKSet(jwksUrl),
    issuer: authServerUrl,
    resourceUrl: config.resourceUrl,
    requiredScopes: config.requiredScopes ?? [],
    skipValidation: config.skipValidation ?? false,
  };
}

/**
 * Serves OAuth 2.0 Protected Resource Metadata (RFC 9728).
 * Mount at: GET /.well-known/oauth-protected-resource
 */
export function protectedResourceMetadata(
  _req: Request,
  res: Response,
): void {
  if (!state) {
    res.status(500).json({ error: 'DAuth not initialized' });
    return;
  }

  res.json({
    resource: state.resourceUrl,
    authorization_servers: [state.issuer],
    scopes_supported: state.requiredScopes.length > 0
      ? state.requiredScopes
      : undefined,
    bearer_methods_supported: ['header'],
  });
}

/**
 * Express middleware that enforces Bearer token auth on the MCP endpoint.
 *
 * - No token → 401 with WWW-Authenticate pointing to resource metadata
 * - Invalid token → 401
 * - Insufficient scopes → 403
 * - Valid token → attaches decoded claims to req and calls next()
 */
export async function requireDAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!state) {
    res.status(500).json({ error: 'DAuth not initialized' });
    return;
  }

  // Skip validation for local dev
  if (state.skipValidation) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const metadataUrl = `${state.resourceUrl}/.well-known/oauth-protected-resource`;
    const scopeParam = state.requiredScopes.length > 0
      ? `, scope="${state.requiredScopes.join(' ')}"`
      : '';
    res
      .status(401)
      .set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${metadataUrl}"${scopeParam}`,
      )
      .json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Authorization required' },
        id: null,
      });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const { payload } = await jwtVerify(token, state.jwks, {
      issuer: state.issuer,
      audience: state.resourceUrl,
    });

    // Check required scopes
    if (state.requiredScopes.length > 0) {
      const tokenScopes = parseScopes(payload);
      const missing = state.requiredScopes.filter(
        (s) => !tokenScopes.has(s),
      );
      if (missing.length > 0) {
        const metadataUrl = `${state.resourceUrl}/.well-known/oauth-protected-resource`;
        res
          .status(403)
          .set(
            'WWW-Authenticate',
            `Bearer error="insufficient_scope", ` +
            `scope="${state.requiredScopes.join(' ')}", ` +
            `resource_metadata="${metadataUrl}", ` +
            `error_description="Missing scopes: ${missing.join(', ')}"`,
          )
          .json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: `Insufficient scopes. Missing: ${missing.join(', ')}`,
            },
            id: null,
          });
        return;
      }
    }

    // Attach claims to request for downstream use
    (req as any).auth = {
      subject: payload.sub,
      scopes: [...parseScopes(payload)],
      claims: payload,
    };

    next();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token validation failed';
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer error="invalid_token"')
      .json({
        jsonrpc: '2.0',
        error: { code: -32000, message },
        id: null,
      });
  }
}

function parseScopes(payload: JWTPayload): Set<string> {
  const raw = payload.scope ?? payload.scp;
  if (typeof raw === 'string') return new Set(raw.split(' '));
  if (Array.isArray(raw)) return new Set(raw.map(String));
  return new Set();
}
