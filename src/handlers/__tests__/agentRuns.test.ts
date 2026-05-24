import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Exa } from 'exa-js';
import * as agentRuns from '../agentRuns.js';
import type { OperationContext } from '../types.js';

// Minimal Exa-shaped object that exposes baseURL + headers (the two fields
// our agentFetch helper reads). Real SDK headers use HeadersImpl with
// forEach; we mirror that.
function fakeExa(): Exa {
  const headers = new Map<string, string>([
    ['x-api-key', 'test-key'],
    ['User-Agent', 'test-agent/1'],
  ]);
  return {
    baseURL: 'https://api.exa.ai',
    headers: {
      forEach: (cb: (v: string, k: string) => void) => {
        headers.forEach((v, k) => cb(v, k));
      },
    },
  } as unknown as Exa;
}

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext & {
  sendProgress: ReturnType<typeof vi.fn>;
} {
  return {
    sendProgress: vi.fn().mockResolvedValue(undefined),
    silent: false,
    ...overrides,
  } as any;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(frames: string[]): Response {
  const text = frames.join('') + '\n';
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

// vi.spyOn for globalThis.fetch returns a strongly-typed MockInstance
// that doesn't widen to ReturnType<typeof vi.spyOn>'s generic shape under
// some TS configs (the container build is stricter than the local
// incremental build). `any` here avoids a fragile type dance for what is
// purely a test fixture.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchSpy: any;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('agentRuns.create — non-streaming', () => {
  it('POSTs /agent/runs with query + beta header and returns the response', async () => {
    const expected = {
      id: 'agent_run_01j',
      object: 'agent_run',
      status: 'running',
      request: { query: 'What is MCP?' },
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(expected));

    const result = await agentRuns.create(
      { query: 'What is MCP?' },
      fakeExa(),
    );

    expect(result.isError).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.exa.ai/agent/runs');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Exa-Beta']).toBe('agent-2026-05-07');
    expect(headers['Accept']).toBe('application/json');
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body.query).toBe('What is MCP?');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject(expected);
  });

  it('passes outputSchema, input, and effort when provided', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'r1', status: 'queued' }));

    await agentRuns.create(
      {
        query: 'Find AI infra funding',
        outputSchema: { type: 'object', properties: { companies: { type: 'array' } } },
        input: { data: [{ company: 'Apple' }] },
        effort: 'auto',
      },
      fakeExa(),
    );

    const body = JSON.parse((fetchSpy.mock.calls[0] as any)[1].body as string);
    expect(body.outputSchema).toBeDefined();
    expect(body.input).toEqual({ data: [{ company: 'Apple' }] });
    expect(body.effort).toBe('auto');
  });

  it('surfaces a 429 concurrency error as an error result', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('Run concurrency limit exceeded', { status: 429 }),
    );

    const result = await agentRuns.create({ query: 'x' }, fakeExa());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('429');
  });

  it('requires query', async () => {
    const result = await agentRuns.create({}, fakeExa());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query');
  });
});

describe('agentRuns.create — streaming', () => {
  it('emits sendProgress per SSE event and returns final agent_run', async () => {
    const frames = [
      'id: 1\nevent: agent_run.created\ndata: {"id":"agent_run_01","object":"agent_run","status":"queued"}\n\n',
      'id: 2\nevent: agent_run.started\ndata: {"id":"agent_run_01","object":"agent_run","status":"running"}\n\n',
      'id: 3\nevent: agent_run.completed\ndata: {"id":"agent_run_01","object":"agent_run","status":"completed","output":{"text":"Final answer"}}\n\n',
    ];
    fetchSpy.mockResolvedValueOnce(sseResponse(frames));
    const ctx = makeCtx();

    const result = await agentRuns.create(
      { query: 'What is MCP?', stream: true },
      fakeExa(),
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(ctx.sendProgress).toHaveBeenCalledTimes(3);
    // Each call should include the event type in the message payload.
    const msg0 = ctx.sendProgress.mock.calls[0][1] as string;
    expect(msg0).toContain('"event":"agent_run.created"');
    const msg2 = ctx.sendProgress.mock.calls[2][1] as string;
    expect(msg2).toContain('"event":"agent_run.completed"');

    // Final result should be the AgentRun from the completed event.
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe('agent_run_01');
    expect(parsed.status).toBe('completed');
    expect(parsed.output.text).toBe('Final answer');

    // Request must have set Accept: text/event-stream.
    const headers = (fetchSpy.mock.calls[0] as any)[1].headers as Record<string, string>;
    expect(headers['Accept']).toBe('text/event-stream');
  });

  it('honors silent:true (no sendProgress calls)', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        'event: agent_run.created\ndata: {"id":"r1","object":"agent_run","status":"running"}\n\n',
        'event: agent_run.completed\ndata: {"id":"r1","object":"agent_run","status":"completed"}\n\n',
      ]),
    );
    const ctx = makeCtx({ silent: true });

    const result = await agentRuns.create(
      { query: 'x', stream: true },
      fakeExa(),
      ctx,
    );

    expect(ctx.sendProgress).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).status).toBe('completed');
  });

  it('returns aborted:true mid-stream when ctx.signal aborts', async () => {
    const controller = new AbortController();
    // Pre-abort so the first chunk read returns the abort.
    controller.abort();
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        'event: agent_run.created\ndata: {"id":"r1","object":"agent_run","status":"running"}\n\n',
      ]),
    );
    const ctx = makeCtx({ signal: controller.signal });

    const result = await agentRuns.create(
      { query: 'x', stream: true },
      fakeExa(),
      ctx,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.aborted).toBe(true);
  });

  it('surfaces non-200 SSE response as an error', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('Bad request', { status: 400 }),
    );

    const result = await agentRuns.create(
      { query: 'x', stream: true },
      fakeExa(),
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('400');
  });
});

describe('agentRuns.get', () => {
  it('GETs /agent/runs/{id} with the beta header', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'r1', status: 'completed' }));

    const result = await agentRuns.get({ id: 'r1' }, fakeExa());

    expect(result.isError).toBeUndefined();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.exa.ai/agent/runs/r1');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Exa-Beta']).toBe('agent-2026-05-07');
  });

  it('URL-encodes the id', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'has/slash' }));
    await agentRuns.get({ id: 'has/slash' }, fakeExa());
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/agent/runs/has%2Fslash');
  });

  it('requires id', async () => {
    const result = await agentRuns.get({}, fakeExa());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('id');
  });
});

describe('agentRuns.list', () => {
  it('GETs /agent/runs without query params when none provided', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ data: [], nextCursor: null }));

    await agentRuns.list({}, fakeExa());

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.exa.ai/agent/runs');
  });

  it('appends cursor and limit when provided', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await agentRuns.list({ cursor: 'cur_1', limit: 25 }, fakeExa());

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('cursor=cur_1');
    expect(url).toContain('limit=25');
  });
});
