import crypto from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Exa } from "exa-js";
import { resolveExaApiKey } from "./auth.js";
import { registerSearchTool } from "./tools/searchTool.js";
import { registerExecuteTool } from "./tools/executeTool.js";
import { registerStatusTool } from "./tools/statusTool.js";
import { registerWorkflowMcp } from "./workflows/mcp.js";
import { createWebhookRouter } from "./webhooks/receiver.js";
import { setEnrichmentLabelResolver } from "./webhooks/eventBus.js";
import type { Express, Request, Response } from "express";

export interface ServerConfig {
  exaApiKey: string;
  host?: string;
  sessionTimeoutMs?: number;
  /** @default 'safe' — override with DEFAULT_COMPAT_MODE env var or per-call compat.mode */
  defaultCompatMode?: 'safe' | 'strict';
  /** Secret for verifying Exa webhook signatures (Exa-Signature header) */
  webhookSecret?: string;
  /** MCP server name — should match Dedalus marketplace slug */
  mcpServerName?: string;
}

export interface ServerInstance {
  app: Express;
  sessions: Map<string, SessionEntry>;
  shutdown(): void;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  exa: Exa;
  lastActivity: number;
  timeoutId?: ReturnType<typeof setTimeout>;
}

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MCP_PATHS = ["/", "/mcp"] as const;

function createExaClient(apiKey: string): Exa {
  return new Exa(apiKey || 'dummy-key-for-testing');
}

export function createServer(config: ServerConfig): ServerInstance {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as any).__rawBody = buf;
    },
  }));

  // Stainless/Dedalus: echo mcp-session-id on responses when absent
  app.use((req: Request, res: Response, next) => {
    const existing = req.headers['mcp-session-id'];
    const sessionId = (Array.isArray(existing) ? existing[0] : existing) || crypto.randomUUID();
    (req as any).mcpSessionId = sessionId;
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = function (statusCode: number, ...rest: any[]) {
      if (!res.getHeader('mcp-session-id')) {
        res.setHeader('mcp-session-id', sessionId);
      }
      return origWriteHead(statusCode, ...rest);
    } as typeof res.writeHead;
    next();
  });

  // Dedalus/Stainless health probe convention
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).send('OK');
  });

  app.use(createWebhookRouter(config.webhookSecret));

  const webhookExa = createExaClient(config.exaApiKey);

  setEnrichmentLabelResolver(async (websetId: string) => {
    const ws = (await webhookExa.websets.get(websetId)) as unknown as {
      enrichments?: Array<{ id?: string; description?: string; title?: string }>;
    };
    const map = new Map<string, string>();
    for (const e of ws.enrichments ?? []) {
      const label = e.description ?? e.title;
      if (e.id && label) map.set(e.id, label);
    }
    return map;
  });

  const sessions = new Map<string, SessionEntry>();
  const pendingSessions = new Set<string>();
  const sessionTimeoutMs = config.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const mcpServerName = config.mcpServerName ?? 'websets';

  const scheduleSessionCleanup = (sessionId: string) => {
    const entry = sessions.get(sessionId);
    if (!entry) return;

    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
    }

    entry.timeoutId = setTimeout(() => {
      const session = sessions.get(sessionId);
      if (session) {
        sessions.delete(sessionId);
        session.transport.close();
      }
    }, sessionTimeoutMs);
  };

  const updateSessionActivity = (sessionId: string) => {
    const entry = sessions.get(sessionId);
    if (entry) {
      entry.lastActivity = Date.now();
      scheduleSessionCleanup(sessionId);
    }
  };

  const registerMcpTools = (server: McpServer, exa: Exa) => {
    registerSearchTool(server);
    registerExecuteTool(server, exa, {
      defaultCompatMode: config.defaultCompatMode ?? 'safe',
    });
    registerStatusTool(server, exa, {
      defaultCompatMode: config.defaultCompatMode ?? 'safe',
    });
    registerWorkflowMcp(server);
  };

  const handleMcpRequest = async (req: Request, res: Response) => {
    const sessionId = (req.headers["mcp-session-id"] as string | undefined)
      ?? (req as any).mcpSessionId;

    try {
      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;
        updateSessionActivity(sessionId);
        await entry.transport.handleRequest(req, res, req.body);

        if (req.method === "DELETE") {
          if (entry.timeoutId) {
            clearTimeout(entry.timeoutId);
          }
          sessions.delete(sessionId);
          entry.transport.close();
        }
        return;
      }

      const newSessionId = sessionId || crypto.randomUUID();

      if (pendingSessions.has(newSessionId)) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (sessions.has(newSessionId)) {
          const entry = sessions.get(newSessionId)!;
          updateSessionActivity(newSessionId);
          await entry.transport.handleRequest(req, res, req.body);
          return;
        }
      }

      pendingSessions.add(newSessionId);

      try {
        const exaApiKey = resolveExaApiKey(req, config.exaApiKey);
        const exa = createExaClient(exaApiKey);

        const server = new McpServer({
          name: mcpServerName,
          version: "2.0.0",
        });

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          enableJsonResponse: true,
        });

        registerMcpTools(server, exa);

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
          exa,
          lastActivity: Date.now(),
        };

        sessions.set(newSessionId, entry);
        scheduleSessionCleanup(newSessionId);
        pendingSessions.delete(newSessionId);

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
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
  };

  for (const path of MCP_PATHS) {
    app.all(path, handleMcpRequest);
  }

  function shutdown() {
    for (const [, entry] of sessions) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      entry.transport.close();
    }
    sessions.clear();
  }

  return { app, sessions, shutdown };
}
