import crypto from "node:crypto";
import type { Server as HttpServer } from "node:http";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Exa } from "exa-js";
import { registerSearchTool } from "./tools/searchTool.js";
import { registerExecuteTool } from "./tools/executeTool.js";
import { registerStatusTool } from "./tools/statusTool.js";
import { registerWorkflowMcp } from "./workflows/mcp.js";
import { createWebhookRouter } from "./webhooks/receiver.js";
import { initDAuth, protectedResourceMetadata, requireDAuth } from "./auth/dauth.js";
import type { Express, Request, Response } from "express";

const SERVER_NAME = "websets-server";
const SERVER_VERSION = "2.0.0";

function buildMcpServer(exa: Exa, defaultCompatMode: 'safe' | 'strict'): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerSearchTool(server);
  registerExecuteTool(server, exa, { defaultCompatMode });
  registerStatusTool(server, exa, { defaultCompatMode });
  registerWorkflowMcp(server);
  return server;
}

/**
 * Build a fully-configured McpServer for stdio transport (plugin install path).
 * Caller is responsible for connecting it to a transport.
 */
export function createMcpServer(config: {
  exaApiKey: string;
  defaultCompatMode?: 'safe' | 'strict';
}): McpServer {
  const exa = new Exa(config.exaApiKey || 'dummy-key-for-testing');
  return buildMcpServer(exa, config.defaultCompatMode ?? 'safe');
}

/**
 * Start a minimal Express listener that exposes the webhook receiver routes
 * (/health, /webhooks/exa, /webhooks/events, /webhooks/status). Used by the
 * stdio entrypoint so the channel can subscribe via SSE on localhost.
 *
 * Defaults to binding on 127.0.0.1: signature verification is optional, and
 * the SSE stream forwards events directly into the user's Claude session,
 * so a public bind would let anyone on the network inject fake events.
 * Pass `host: '0.0.0.0'` explicitly when running behind Docker / a proxy.
 */
export function startWebhookListener(opts: {
  port?: number;
  host?: string;
  secret?: string;
}): { httpServer: HttpServer; port: number } {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as any).__rawBody = buf;
    },
  }));
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });
  app.use(createWebhookRouter(opts.secret));

  const port = opts.port ?? 7860;
  const host = opts.host ?? '127.0.0.1';
  const httpServer = app.listen(port, host);
  return { httpServer, port };
}

export interface ServerConfig {
  exaApiKey: string;
  host?: string;
  sessionTimeoutMs?: number;
  /** @default 'safe' — override with DEFAULT_COMPAT_MODE env var or per-call compat.mode */
  defaultCompatMode?: 'safe' | 'strict';
  /** Secret for verifying Exa webhook signatures (Exa-Signature header) */
  webhookSecret?: string;
  /** Public URL of this server (used as OAuth resource identifier for DAuth) */
  resourceUrl?: string;
  /** DAuth authorization server URL. Defaults to https://as.dedaluslabs.ai */
  authServerUrl?: string;
  /** Required OAuth scopes. Defaults to [] */
  requiredScopes?: string[];
  /** Skip DAuth token validation (for local development). Defaults to false */
  skipDAuth?: boolean;
}

export interface ServerInstance {
  app: Express;
  sessions: Map<string, SessionEntry>;
  shutdown(): void;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
  timeoutId?: ReturnType<typeof setTimeout>;
}

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export function createServer(config: ServerConfig): ServerInstance {
  // Manual Express setup (replaces createMcpExpressApp) to capture raw body
  // for webhook signature verification. The SDK's createMcpExpressApp only adds
  // express.json() and optional host validation — for host '0.0.0.0' it just
  // logs a warning, so no middleware to replicate.
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      // Store raw body for Exa webhook signature verification
      (req as any).__rawBody = buf;
    },
  }));

  // DAuth: always initialize. Resource URL is derived from the request
  // Host header when not explicitly configured. Set DAUTH_SKIP_VALIDATION=true
  // for local development to bypass token checks.
  initDAuth({
    resourceUrl: config.resourceUrl,
    authServerUrl: config.authServerUrl,
    requiredScopes: config.requiredScopes,
    skipValidation: config.skipDAuth,
  });

  // Health endpoint for Docker healthchecks and k8s probes
  app.get('/health', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.json({ status: 'ok' });
  });

  // OAuth Protected Resource Metadata (RFC 9728)
  app.get(
    '/.well-known/oauth-protected-resource',
    protectedResourceMetadata,
  );

  // Webhook receiver for Exa webhook events + SSE stream for channel bridges
  app.use(createWebhookRouter(config.webhookSecret));

  const exa = new Exa(config.exaApiKey || 'dummy-key-for-testing');
  const sessions = new Map<string, SessionEntry>();
  const pendingSessions = new Set<string>();
  const sessionTimeoutMs = config.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;

  // Helper to schedule session cleanup
  const scheduleSessionCleanup = (sessionId: string) => {
    const entry = sessions.get(sessionId);
    if (!entry) return;

    // Clear existing timeout
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
    }

    // Schedule new timeout
    entry.timeoutId = setTimeout(() => {
      const session = sessions.get(sessionId);
      if (session) {
        sessions.delete(sessionId);
        session.transport.close();
      }
    }, sessionTimeoutMs);
  };

  // Helper to update session activity
  const updateSessionActivity = (sessionId: string) => {
    const entry = sessions.get(sessionId);
    if (entry) {
      entry.lastActivity = Date.now();
      scheduleSessionCleanup(sessionId);
    }
  };

  // DAuth: require Bearer token on /mcp
  app.use('/mcp', requireDAuth);

  app.all("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      // Existing session — route to its transport
      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;
        updateSessionActivity(sessionId);
        await entry.transport.handleRequest(req, res, req.body);

        // Handle DELETE cleanup
        if (req.method === "DELETE") {
          if (entry.timeoutId) {
            clearTimeout(entry.timeoutId);
          }
          sessions.delete(sessionId);
          entry.transport.close();
        }
        return;
      }

      // New session — create server + transport pair
      const newSessionId = sessionId || crypto.randomUUID();

      // Prevent race condition: check if session creation is already in progress
      if (pendingSessions.has(newSessionId)) {
        // Wait briefly and retry
        await new Promise(resolve => setTimeout(resolve, 50));
        if (sessions.has(newSessionId)) {
          const entry = sessions.get(newSessionId)!;
          updateSessionActivity(newSessionId);
          await entry.transport.handleRequest(req, res, req.body);
          return;
        }
      }

      // Mark session as pending
      pendingSessions.add(newSessionId);

      try {
        const server = buildMcpServer(exa, config.defaultCompatMode ?? 'safe');

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          enableJsonResponse: true,
        });

        transport.onclose = () => {
          const entry = sessions.get(transport.sessionId || newSessionId);
          if (entry?.timeoutId) {
            clearTimeout(entry.timeoutId);
          }
          sessions.delete(transport.sessionId || newSessionId);
        };

        await server.connect(transport);
        
        const entry: SessionEntry = {
          transport,
          server,
          lastActivity: Date.now(),
        };
        
        sessions.set(newSessionId, entry);
        scheduleSessionCleanup(newSessionId);

        // Remove from pending
        pendingSessions.delete(newSessionId);

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        // Clean up on error
        pendingSessions.delete(newSessionId);
        throw error;
      }
    } catch (error) {
      console.error("MCP ERROR:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  function shutdown() {
    for (const [, entry] of sessions) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      entry.transport.close();
    }
    sessions.clear();
  }

  return { app, sessions, shutdown };
}
