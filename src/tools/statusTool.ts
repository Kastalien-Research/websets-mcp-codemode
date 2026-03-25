import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Exa } from 'exa-js';
import { taskStore } from '../lib/taskStore.js';
import { OPERATIONS } from './operations.js';
import type { CompatMode } from './coercion.js';

export interface AccountStatus {
  websets: {
    count: number;
    hasMore: boolean;
    by_status: Record<string, number>;
    recent: Array<{ id: string; status: string; query: string }>;
  };
  tasks: {
    running: number;
    active: Array<{ taskId: string; type: string }>;
    recent_errors: Array<{ taskId: string; step: string; message: string }>;
  };
  monitors: {
    active: number;
  };
  capabilities: {
    tools: string[];
    operationCount: number;
    compatMode: string;
    hint: string;
  };
  timestamp: string;
}

const inputSchema = z.object({});

const DESCRIPTION = `Get current account status: websets by status, running tasks, active monitors, and server capabilities. Call this first to orient yourself.`;

const CACHE_TTL_MS = 10_000; // 10 seconds
const STATUS_TIMEOUT_MS = 3_000;

let cached: { data: AccountStatus; expiresAt: number } | null = null;

async function getAccountStatus(exa: Exa, compatMode: string): Promise<AccountStatus> {
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  // taskStore.list() is instant (in-memory), always include it
  const allTasks = taskStore.list();
  const runningTasks = allTasks.filter(t => t.status === 'pending' || t.status === 'working');
  const failedTasks = allTasks.filter(t => t.status === 'failed' && t.error);

  // Sanitize errors — keep only step name and a generic message
  const recentErrors = failedTasks.slice(0, 5).map(t => ({
    taskId: t.id,
    step: t.error?.step ?? 'unknown',
    message: t.error?.recoverable ? 'Recoverable error occurred' : 'Non-recoverable error occurred',
  }));

  let websetsData: { count: number; hasMore: boolean; by_status: Record<string, number>; recent: Array<{ id: string; status: string; query: string }> } = {
    count: 0,
    hasMore: false,
    by_status: {},
    recent: [],
  };

  let monitorsActive = 0;

  try {
    const results = await Promise.race([
      Promise.allSettled([
        exa.websets.list(),
        exa.websets.monitors.list(),
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Status timed out')), STATUS_TIMEOUT_MS)
      ),
    ]);

    // Process websets result
    if (results[0].status === 'fulfilled') {
      const raw = results[0].value as unknown as { data: Array<Record<string, unknown>>; hasMore: boolean };
      const websetsList = raw.data ?? [];
      const byStatus: Record<string, number> = {};
      for (const ws of websetsList) {
        const status = (ws.status as string) ?? 'unknown';
        byStatus[status] = (byStatus[status] ?? 0) + 1;
      }
      const recent = websetsList.slice(0, 5).map(ws => ({
        id: (ws.id as string) ?? '',
        status: (ws.status as string) ?? 'unknown',
        query: (ws.search as Record<string, unknown>)?.query as string ?? (ws.query as string) ?? '',
      }));
      websetsData = {
        count: websetsList.length,
        hasMore: raw.hasMore ?? false,
        by_status: byStatus,
        recent,
      };
    }

    // Process monitors result
    if (results[1].status === 'fulfilled') {
      const raw = results[1].value as unknown as { data: Array<Record<string, unknown>> };
      const monitorsList = raw.data ?? [];
      monitorsActive = monitorsList.filter(m => (m.status as string) === 'active').length;
    }
  } catch {
    // Timeout — websetsData and monitorsActive remain at defaults
    // Task store data is still available
  }

  const status: AccountStatus = {
    websets: websetsData,
    tasks: {
      running: runningTasks.length,
      active: runningTasks.map(t => ({ taskId: t.id, type: t.type })),
      recent_errors: recentErrors,
    },
    monitors: {
      active: monitorsActive,
    },
    capabilities: {
      tools: ['search', 'execute', 'status'],
      operationCount: Object.keys(OPERATIONS).length,
      compatMode,
      hint: 'Use search tool to discover specific operations, execute tool to run code',
    },
    timestamp: new Date().toISOString(),
  };

  cached = { data: status, expiresAt: Date.now() + CACHE_TTL_MS };
  return status;
}

export interface StatusToolOptions {
  defaultCompatMode?: CompatMode;
}

export function registerStatusTool(
  server: McpServer,
  exa: Exa,
  options: StatusToolOptions = {},
): void {
  const compatMode = options.defaultCompatMode ?? 'safe';

  server.registerTool(
    'status',
    {
      description: DESCRIPTION,
      inputSchema: inputSchema as any,
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      try {
        const status = await getAccountStatus(exa, compatMode);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Status error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
