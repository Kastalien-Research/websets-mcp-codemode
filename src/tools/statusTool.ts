import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Exa } from 'exa-js';
import { taskStore } from '../lib/taskStore.js';
import { OPERATIONS } from './operations.js';
import type { CompatMode } from './coercion.js';

export interface WebsetsSummary {
  count: number;
  hasMore: boolean;
  by_status: Record<string, number>;
  recent: Array<{ id: string; status: string; query: string }>;
}

export interface AccountStatus {
  /** True iff a live Exa section failed to load (see `errors`). */
  degraded: boolean;
  /** Sanitized "<section>: <reason>" strings; empty when healthy. */
  errors: string[];
  /** Null when the live websets call failed — distinct from a real empty account. */
  websets: WebsetsSummary | null;
  tasks: {
    running: number;
    active: Array<{ taskId: string; type: string }>;
    recent_errors: Array<{ taskId: string; step: string; message: string }>;
  };
  /** Null when the live monitors call failed. */
  monitors: {
    active: number;
  } | null;
  capabilities: {
    tools: string[];
    operationCount: number;
    compatMode: string;
    hint: string;
    notifications: string;
  };
  timestamp: string;
}

const inputSchema = z.object({});

const DESCRIPTION = `Get current account status: websets by status, running tasks, active monitors, and server capabilities. Call this first to orient yourself. When live Exa data is unavailable, the affected section is null and degraded/errors explain what failed — null means "unavailable", not "empty".`;

const CACHE_TTL_MS = 10_000; // 10 seconds
const STATUS_TIMEOUT_MS = 3_000;

let cached: { data: AccountStatus; expiresAt: number } | null = null;

/** Test seam: clear the in-memory status cache. */
export function _resetStatusCache(): void {
  cached = null;
}

class StatusTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = 'StatusTimeoutError';
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StatusTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Reduce any failure to a non-sensitive reason string. */
function failureReason(error: unknown): string {
  if (error instanceof StatusTimeoutError) return error.message;
  return 'unavailable (live call failed)';
}

function summarizeWebsets(raw: { data?: Array<Record<string, unknown>>; hasMore?: boolean }): WebsetsSummary {
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
  return {
    count: websetsList.length,
    hasMore: raw.hasMore ?? false,
    by_status: byStatus,
    recent,
  };
}

export interface GetAccountStatusOptions {
  /** Per-call timeout in ms (test seam; defaults to STATUS_TIMEOUT_MS). */
  timeoutMs?: number;
}

export async function getAccountStatus(
  exa: Exa,
  compatMode: string,
  options: GetAccountStatusOptions = {},
): Promise<AccountStatus> {
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS;

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

  const errors: string[] = [];

  // Each live call is isolated behind its own timeout so one can succeed while
  // the other degrades — a shared race would discard partial results.
  const [websetsResult, monitorsResult] = await Promise.allSettled([
    withTimeout(exa.websets.list() as Promise<unknown>, timeoutMs),
    withTimeout(exa.websets.monitors.list() as Promise<unknown>, timeoutMs),
  ]);

  let websetsData: WebsetsSummary | null = null;
  if (websetsResult.status === 'fulfilled') {
    websetsData = summarizeWebsets(
      websetsResult.value as { data?: Array<Record<string, unknown>>; hasMore?: boolean },
    );
  } else {
    errors.push(`websets: ${failureReason(websetsResult.reason)}`);
  }

  let monitorsData: { active: number } | null = null;
  if (monitorsResult.status === 'fulfilled') {
    const raw = monitorsResult.value as { data?: Array<Record<string, unknown>> };
    const monitorsList = raw.data ?? [];
    monitorsData = {
      active: monitorsList.filter(m => (m.status as string) === 'active').length,
    };
  } else {
    errors.push(`monitors: ${failureReason(monitorsResult.reason)}`);
  }

  const status: AccountStatus = {
    degraded: errors.length > 0,
    errors,
    websets: websetsData,
    tasks: {
      running: runningTasks.length,
      active: runningTasks.map(t => ({ taskId: t.id, type: t.type })),
      recent_errors: recentErrors,
    },
    monitors: monitorsData,
    capabilities: {
      tools: ['search', 'execute', 'status'],
      operationCount: Object.keys(OPERATIONS).length,
      compatMode,
      hint: 'Use search tool to discover specific operations, execute tool to run code',
      notifications:
        'If the websets-channel bridge is connected, webhook events arrive in your context as <channel source="websets-channel"> blocks. Delivery is turn-gated: events queue and arrive at your next turn boundary and NEVER interrupt an in-progress turn; bursts are delivered together (handle as a group). A block that does not appear immediately is queued, not lost — finish the turn and look again. Design handling to act from a single notification where possible.',
    },
    timestamp: new Date().toISOString(),
  };

  // Only cache healthy results — a degraded snapshot must not be pinned, so the
  // next call retries and recovers immediately when Exa is back.
  if (!status.degraded) {
    cached = { data: status, expiresAt: Date.now() + CACHE_TTL_MS };
  }
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
