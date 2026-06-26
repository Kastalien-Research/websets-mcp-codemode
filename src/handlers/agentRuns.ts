import { z } from 'zod';
import type { OperationHandler } from './types.js';
import { successResult, errorResult, requireParams } from './types.js';

// Exa Agent Runs API surface — beta, not yet in the exa-js SDK (v2.12.1
// has no agent/agentRuns namespace). We hit /agent/runs via fetch directly,
// reusing the SDK instance's baseURL + auth headers and adding the required
// Exa-Beta header. When the SDK ships exa.beta.agent.runs, this module
// becomes a thin wrapper over that without changing the operation surface.
//
// OpenAPI spec: specs/exa-api/exa-public-api.yaml:997 (POST /agent/runs),
// :1232 (GET /agent/runs), :1309 (GET /agent/runs/{id}).
const AGENT_BETA_HEADER = 'agent-2026-05-07';
const AGENT_ENDPOINT = '/agent/runs';

export const Schemas = {
  create: z.object({
    query: z.string(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    input: z.object({
      data: z.array(z.record(z.string(), z.unknown())).optional(),
      exclusion: z.array(z.record(z.string(), z.unknown())).optional(),
    }).passthrough().optional(),
    dataSources: z.array(z.object({ provider: z.string() }).passthrough()).max(5).optional(),
    systemPrompt: z.string().optional(),
    previousRunId: z.string().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'auto']).optional(),
    stream: z.boolean().optional(),
  }),
  get: z.object({
    id: z.string(),
  }),
  list: z.object({
    cursor: z.string().optional(),
    limit: z.number().min(1).max(100).optional(),
  }),
};

/**
 * Build a fetch request for the Agent Runs API. Re-uses the SDK client's
 * baseURL + auth headers and adds the required Exa-Beta header.
 *
 * `accept` switches between JSON response (default) and SSE stream.
 */
function agentFetch(
  exa: unknown,
  path: string,
  init: {
    method: string;
    body?: unknown;
    accept?: 'json' | 'sse';
    /**
     * AbortSignal threaded into the underlying fetch so cancellation
     * propagates to the network layer — not just to per-frame iteration
     * checks inside readSseEvents. Without this, a hung response
     * (header wait, quiet SSE interval, idle TCP) would keep the
     * connection open and the call would never settle even after the
     * caller aborts.
     */
    signal?: AbortSignal;
  } = { method: 'GET' },
): Promise<Response> {
  const client = exa as { baseURL: string; headers: unknown };
  const headers: Record<string, string> = {
    'Exa-Beta': AGENT_BETA_HEADER,
    Accept: init.accept === 'sse' ? 'text/event-stream' : 'application/json',
  };
  // SDK headers are a Headers-like instance with forEach(value, key) — pull
  // auth + content-type onto our own header bag. Order matters here: explicit
  // header bag last would overwrite our Accept; the loop runs first.
  const sdkHeaders = client.headers as { forEach?: (cb: (v: string, k: string) => void) => void };
  if (sdkHeaders && typeof sdkHeaders.forEach === 'function') {
    sdkHeaders.forEach((v, k) => {
      // Don't let SDK's default Accept override our SSE accept.
      if (k.toLowerCase() === 'accept' && init.accept === 'sse') return;
      headers[k] = v;
    });
  }
  if (init.body !== undefined && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(`${client.baseURL}${path}`, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
}

/**
 * Parse an SSE stream, invoking `onEvent` for each (event-type, data) pair.
 * Skips malformed frames. Honors the abort signal between frames.
 */
async function readSseEvents(
  response: Response,
  onEvent: (eventType: string, data: unknown) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body for SSE stream');
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === '[DONE]') continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(dataStr);
          } catch {
            continue;
          }
          await onEvent(currentEvent, parsed);
        } else if (line === '') {
          // SSE frame boundary — reset the event-type buffer.
          currentEvent = '';
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

const CREATE_HINTS = `Common issues:
- query is required (a string)
- outputSchema: pass a JSON Schema object to get structured output
- input.data: array of row objects when processing per-row inputs
- effort: low | medium | high | auto
- Concurrency: API returns 429 if your team's concurrent-runs cap is reached
- Beta header is auto-attached; no need to pass it manually`;

export const create: OperationHandler = async (args, exa, ctx) => {
  const guard = requireParams('agentRuns.create', args, 'query');
  if (guard) return guard;
  try {
    const body: Record<string, unknown> = { query: args.query };
    if (args.outputSchema) body.outputSchema = args.outputSchema;
    if (args.input) body.input = args.input;
    if (args.dataSources) body.dataSources = args.dataSources;
    if (args.systemPrompt) body.systemPrompt = args.systemPrompt;
    if (args.previousRunId) body.previousRunId = args.previousRunId;
    if (args.effort) body.effort = args.effort;

    if (args.stream === true) {
      const response = await agentFetch(exa, AGENT_ENDPOINT, {
        method: 'POST',
        body,
        accept: 'sse',
        signal: ctx?.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(
          `agentRuns.create stream failed: ${response.status} ${errText.slice(0, 200)}`,
        );
      }

      let finalRun: Record<string, unknown> | null = null;
      let chunkIndex = 0;

      await readSseEvents(
        response,
        async (eventType, data) => {
          if (ctx?.signal?.aborted) return;
          if (ctx?.sendProgress && !ctx.silent) {
            try {
              await ctx.sendProgress(chunkIndex, JSON.stringify({ event: eventType, data }));
            } catch (err) {
              console.warn('[agentRuns.create] sendProgress failed; continuing stream', err);
            }
          }
          chunkIndex += 1;
          // Terminal events (agent_run.completed / .failed / .canceled) carry
          // the full AgentRun object as `data`. Track the latest such object
          // as the final return value; SSE close otherwise leaves us with the
          // most recent state we observed.
          if (data && typeof data === 'object' && (data as Record<string, unknown>).object === 'agent_run') {
            finalRun = data as Record<string, unknown>;
          }
        },
        ctx?.signal,
      );

      if (ctx?.signal?.aborted) {
        return successResult({ aborted: true, lastSeen: finalRun, eventsObserved: chunkIndex });
      }

      // Stream ended cleanly. If we never saw an agent_run terminal payload
      // (some streams may not include `object` on every frame), fall back to
      // GET-ing the run by id we observed in earlier frames. For now, if we
      // saw nothing structured, surface what we have.
      if (!finalRun) {
        return successResult({ eventsObserved: chunkIndex, note: 'stream ended without terminal agent_run payload' });
      }
      return successResult(finalRun);
    }

    // Non-streaming path.
    const response = await agentFetch(exa, AGENT_ENDPOINT, {
      method: 'POST',
      body,
      signal: ctx?.signal,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(
        `agentRuns.create failed: ${response.status} ${errText.slice(0, 200)}`,
      );
    }
    const result = await response.json();
    return successResult(result);
  } catch (error) {
    return errorResult('agentRuns.create', error, CREATE_HINTS);
  }
};

export const get: OperationHandler = async (args, exa) => {
  const guard = requireParams('agentRuns.get', args, 'id');
  if (guard) return guard;
  try {
    const response = await agentFetch(exa, `${AGENT_ENDPOINT}/${encodeURIComponent(args.id as string)}`, {
      method: 'GET',
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(
        `agentRuns.get failed: ${response.status} ${errText.slice(0, 200)}`,
      );
    }
    return successResult(await response.json());
  } catch (error) {
    return errorResult('agentRuns.get', error);
  }
};

export const list: OperationHandler = async (args, exa) => {
  try {
    const params = new URLSearchParams();
    if (args.cursor) params.set('cursor', args.cursor as string);
    if (args.limit !== undefined) params.set('limit', String(args.limit));
    const qs = params.toString();
    const path = qs ? `${AGENT_ENDPOINT}?${qs}` : AGENT_ENDPOINT;
    const response = await agentFetch(exa, path, { method: 'GET' });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(
        `agentRuns.list failed: ${response.status} ${errText.slice(0, 200)}`,
      );
    }
    return successResult(await response.json());
  } catch (error) {
    return errorResult('agentRuns.list', error);
  }
};
