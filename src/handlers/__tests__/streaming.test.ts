import { describe, it, expect, vi } from 'vitest';
import type { Exa } from 'exa-js';
import * as exaHandlers from '../exa.js';
import * as researchHandlers from '../research.js';
import type { OperationContext } from '../types.js';

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext & {
  sendProgress: ReturnType<typeof vi.fn>;
} {
  return {
    sendProgress: vi.fn().mockResolvedValue(undefined),
    silent: false,
    ...overrides,
  } as any;
}

describe('exa.answer streaming', () => {
  it('emits sendProgress per chunk and returns accumulated answer', async () => {
    async function* fakeStream() {
      yield { content: 'Model ', citations: [{ id: 'c1', url: 'a' }] };
      yield { content: 'Context ', citations: [{ id: 'c2', url: 'b' }] };
      yield { content: 'Protocol.' };
    }
    const exa = { streamAnswer: vi.fn().mockReturnValue(fakeStream()) } as unknown as Exa;
    const ctx = makeCtx();

    const result = await exaHandlers.answer({ query: 'What is MCP?', stream: true }, exa, ctx);

    expect(result.isError).toBeUndefined();
    expect(ctx.sendProgress).toHaveBeenCalledTimes(3);
    expect(ctx.sendProgress).toHaveBeenNthCalledWith(1, 0, expect.stringContaining('Model'));
    expect(ctx.sendProgress).toHaveBeenNthCalledWith(2, 1, expect.stringContaining('Context'));
    expect(ctx.sendProgress).toHaveBeenNthCalledWith(3, 2, expect.stringContaining('Protocol.'));

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.content).toBe('Model Context Protocol.');
    expect(parsed.citations).toHaveLength(2);
  });

  it('honors silent:true (no sendProgress calls)', async () => {
    async function* fakeStream() {
      yield { content: 'a' };
      yield { content: 'b' };
    }
    const exa = { streamAnswer: vi.fn().mockReturnValue(fakeStream()) } as unknown as Exa;
    const ctx = makeCtx({ silent: true });

    const result = await exaHandlers.answer({ query: 'x', stream: true }, exa, ctx);

    expect(ctx.sendProgress).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.content).toBe('ab');
  });

  it('falls back to non-streaming when stream is not set', async () => {
    const exa = {
      streamAnswer: vi.fn(),
      answer: vi.fn().mockResolvedValue({ answer: '42', citations: [] }),
    } as unknown as Exa;
    const ctx = makeCtx();

    const result = await exaHandlers.answer({ query: 'meaning?' }, exa, ctx);

    expect((exa as any).streamAnswer).not.toHaveBeenCalled();
    expect((exa as any).answer).toHaveBeenCalledWith('meaning?', undefined);
    expect(ctx.sendProgress).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.answer).toBe('42');
  });

  it('aborts mid-stream when ctx.signal.aborted', async () => {
    const controller = new AbortController();
    async function* fakeStream() {
      yield { content: 'first ' };
      controller.abort();
      yield { content: 'second ' };
      yield { content: 'third' };
    }
    const exa = { streamAnswer: vi.fn().mockReturnValue(fakeStream()) } as unknown as Exa;
    const ctx = makeCtx({ signal: controller.signal });

    const result = await exaHandlers.answer({ query: 'x', stream: true }, exa, ctx);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.aborted).toBe(true);
    expect(parsed.content).toBe('first ');
  });

  it('continues iterating when sendProgress throws', async () => {
    async function* fakeStream() {
      yield { content: 'a' };
      yield { content: 'b' };
      yield { content: 'c' };
    }
    const exa = { streamAnswer: vi.fn().mockReturnValue(fakeStream()) } as unknown as Exa;
    const sendProgress = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('transport closed'))
      .mockResolvedValueOnce(undefined);
    const ctx: OperationContext = { sendProgress, silent: false };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await exaHandlers.answer({ query: 'x', stream: true }, exa, ctx);

    expect(sendProgress).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.content).toBe('abc');

    warnSpy.mockRestore();
  });

  it('falls back to non-streaming when stream yields zero chunks', async () => {
    async function* emptyStream() {
      // yields nothing
    }
    const nonStreamingResult = { answer: 'The fallback answer', citations: [{ id: 'f1' }] };
    const exa = {
      streamAnswer: vi.fn().mockReturnValue(emptyStream()),
      answer: vi.fn().mockResolvedValue(nonStreamingResult),
    } as unknown as Exa;
    const ctx = makeCtx();

    const result = await exaHandlers.answer({ query: 'x', stream: true }, exa, ctx);

    expect((exa as any).streamAnswer).toHaveBeenCalledTimes(1);
    expect((exa as any).answer).toHaveBeenCalledTimes(1);
    expect(ctx.sendProgress).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.answer).toBe('The fallback answer');
    expect(parsed.citations).toHaveLength(1);
  });
});

describe('exa.search streaming', () => {
  it('emits sendProgress per chunk and returns accumulated result', async () => {
    async function* fakeStream() {
      yield { content: 'one ', citations: [{ id: 's1' }] };
      yield { content: 'two', citations: [{ id: 's2' }] };
    }
    const exa = { streamSearch: vi.fn().mockReturnValue(fakeStream()) } as unknown as Exa;
    const ctx = makeCtx();

    const result = await exaHandlers.search(
      { query: 'MCP servers', stream: true, outputSchema: { type: 'object' } },
      exa,
      ctx,
    );

    expect(ctx.sendProgress).toHaveBeenCalledTimes(2);
    expect((exa as any).streamSearch).toHaveBeenCalledTimes(1);
    const [calledQuery, calledOpts] = (exa as any).streamSearch.mock.calls[0];
    expect(calledQuery).toBe('MCP servers');
    expect(calledOpts).toMatchObject({ outputSchema: { type: 'object' } });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.content).toBe('one two');
    expect(parsed.citations).toHaveLength(2);
  });

  it('falls back to non-streaming when stream is not set', async () => {
    const exa = {
      streamSearch: vi.fn(),
      search: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as Exa;
    const ctx = makeCtx();

    await exaHandlers.search({ query: 'x' }, exa, ctx);

    expect((exa as any).streamSearch).not.toHaveBeenCalled();
    expect((exa as any).search).toHaveBeenCalled();
  });

  it('falls back to non-streaming when stream yields zero chunks', async () => {
    async function* emptyStream() {
      // yields nothing — observed behavior of Exa /search streaming today
    }
    const nonStreamingResult = {
      requestId: 'req_1',
      results: [
        { id: 'r1', title: 'Real Result 1', url: 'https://x' },
        { id: 'r2', title: 'Real Result 2', url: 'https://y' },
      ],
    };
    const exa = {
      streamSearch: vi.fn().mockReturnValue(emptyStream()),
      search: vi.fn().mockResolvedValue(nonStreamingResult),
    } as unknown as Exa;
    const ctx = makeCtx();

    const result = await exaHandlers.search(
      { query: 'MCP servers', stream: true, outputSchema: { type: 'object' } },
      exa,
      ctx,
    );

    expect((exa as any).streamSearch).toHaveBeenCalledTimes(1);
    expect((exa as any).search).toHaveBeenCalledTimes(1);
    // Fallback must pass the same query + opts as the streaming call.
    const [fallbackQuery, fallbackOpts] = (exa as any).search.mock.calls[0];
    expect(fallbackQuery).toBe('MCP servers');
    expect(fallbackOpts).toMatchObject({ outputSchema: { type: 'object' } });
    expect(ctx.sendProgress).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.requestId).toBe('req_1');
  });
});

describe('research.get streaming', () => {
  it('returns the research-output event in `output` and full event list', async () => {
    async function* fakeStream() {
      yield { eventType: 'research-definition', researchId: 'r1' };
      yield { eventType: 'task-definition', taskId: 't1' };
      yield { eventType: 'research-output', output: { findings: ['x', 'y'] } };
    }
    // research.get returns Promise<AsyncGenerator<...>> when stream:true
    const exa = {
      research: {
        get: vi.fn().mockResolvedValue(fakeStream()),
      },
    } as unknown as Exa;
    const ctx = makeCtx();

    const result = await researchHandlers.get({ researchId: 'r1', stream: true }, exa, ctx);

    expect(ctx.sendProgress).toHaveBeenCalledTimes(3);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.researchId).toBe('r1');
    expect(parsed.events).toHaveLength(3);
    expect(parsed.output).toMatchObject({
      eventType: 'research-output',
      output: { findings: ['x', 'y'] },
    });

    const [, getOpts] = (exa as any).research.get.mock.calls[0];
    expect(getOpts).toMatchObject({ stream: true });
  });

  it('aborts mid-stream and returns events collected so far', async () => {
    const controller = new AbortController();
    async function* fakeStream() {
      yield { eventType: 'research-definition' };
      controller.abort();
      yield { eventType: 'research-output', output: {} };
    }
    const exa = {
      research: { get: vi.fn().mockResolvedValue(fakeStream()) },
    } as unknown as Exa;
    const ctx = makeCtx({ signal: controller.signal });

    const result = await researchHandlers.get({ researchId: 'r1', stream: true }, exa, ctx);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.aborted).toBe(true);
    expect(parsed.events).toHaveLength(1);
  });

  it('falls back to non-streaming when stream is not set', async () => {
    const exa = {
      research: {
        get: vi.fn().mockResolvedValue({ researchId: 'r1', status: 'completed' }),
      },
    } as unknown as Exa;
    const ctx = makeCtx();

    const result = await researchHandlers.get({ researchId: 'r1' }, exa, ctx);

    expect(ctx.sendProgress).not.toHaveBeenCalled();
    // Non-streaming returns the projection — researchId should be present.
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.researchId).toBe('r1');
  });
});
