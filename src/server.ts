import crypto from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Exa } from "exa-js";
import { registerSearchTool } from "./tools/searchTool.js";
import { registerExecuteTool } from "./tools/executeTool.js";
import { registerStatusTool } from "./tools/statusTool.js";
import { registerWorkflowMcp } from "./workflows/mcp.js";
import { createWebhookRouter } from "./webhooks/receiver.js";
import type { Express, Request, Response } from "express";

export interface ServerConfig {
  exaApiKey: string;
  host?: string;
  sessionTimeoutMs?: number;
  /** @default 'safe' — override with DEFAULT_COMPAT_MODE env var or per-call compat.mode */
  defaultCompatMode?: 'safe' | 'strict';
  /** Secret for verifying Exa webhook signatures (Exa-Signature header) */
  webhookSecret?: string;
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

  // Health endpoint for Docker healthchecks and k8s probes
  app.get('/health', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.json({ status: 'ok' });
  });

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
        const server = new McpServer({
          name: "websets-server",
          version: "2.0.0"
        });

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          enableJsonResponse: true,
        });

        registerSearchTool(server);
        registerExecuteTool(server, exa, {
          defaultCompatMode: config.defaultCompatMode ?? 'safe',
        });
        registerStatusTool(server, exa, {
          defaultCompatMode: config.defaultCompatMode ?? 'safe',
        });
        registerWorkflowMcp(server);

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
