import { describe, it, expect, vi } from 'vitest';
import { executeInSandbox } from '../sandbox.js';

// Minimal mock Exa client
function createMockExa(overrides: Record<string, any> = {}): any {
  return {
    search: vi.fn().mockResolvedValue({ results: [] }),
    websets: {
      create: vi.fn().mockResolvedValue({ id: 'ws_123', status: 'running' }),
      get: vi.fn().mockResolvedValue({ id: 'ws_123', status: 'idle' }),
      ...overrides,
    },
  };
}

describe('executeInSandbox', () => {
  it('executes simple code and returns result', async () => {
    const exa = createMockExa();
    const { result, logs } = await executeInSandbox('return 1 + 2', exa);
    expect(result).toBe(3);
    expect(logs).toEqual([]);
  });

  it('captures console.log output', async () => {
    const exa = createMockExa();
    const { result, logs } = await executeInSandbox(
      'console.log("hello"); console.warn("caution"); return "done"',
      exa,
    );
    expect(result).toBe('done');
    expect(logs).toContain('hello');
    expect(logs).toContain('WARN: caution');
  });

  it('does not expose exa client directly in sandbox', async () => {
    const exa = createMockExa();
    const { result } = await executeInSandbox(
      'return typeof exa === "undefined"',
      exa,
    );
    expect(result).toBe(true);
  });

  it('does not expose require or process', async () => {
    const exa = createMockExa();
    const { result } = await executeInSandbox(
      'return { hasRequire: typeof require !== "undefined", hasProcess: typeof process !== "undefined" }',
      exa,
    );
    expect(result).toEqual({ hasRequire: false, hasProcess: false });
  });

  it('handles async/await code', async () => {
    const exa = createMockExa();
    const { result } = await executeInSandbox(
      `
      const a = await Promise.resolve(10);
      const b = await Promise.resolve(20);
      return a + b;
      `,
      exa,
    );
    expect(result).toBe(30);
  });

  it('propagates errors from code', async () => {
    const exa = createMockExa();
    await expect(
      executeInSandbox('throw new Error("boom")', exa),
    ).rejects.toThrow('boom');
  });

  it('enforces timeout', async () => {
    const exa = createMockExa();
    await expect(
      executeInSandbox(
        'while(true) {}',
        exa,
        { timeoutMs: 100 },
      ),
    ).rejects.toThrow();
  }, 5000);

  it('provides standard builtins', async () => {
    const exa = createMockExa();
    const { result } = await executeInSandbox(
      `
      const arr = [3, 1, 2];
      arr.sort();
      const m = new Map();
      m.set("a", 1);
      return { sorted: arr, mapSize: m.size, date: typeof Date, math: Math.PI > 3 };
      `,
      exa,
    );
    expect(result).toEqual({
      sorted: [1, 2, 3],
      mapSize: 1,
      date: 'function',
      math: true,
    });
  });
});
