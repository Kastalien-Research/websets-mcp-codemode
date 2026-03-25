import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startE2EServer, stopE2EServer, HAS_API_KEY, type E2EContext } from './setup.js';

describe.skipIf(!HAS_API_KEY)('MCP Transport E2E', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await startE2EServer();
  });

  afterAll(async () => {
    if (ctx) await stopE2EServer(ctx);
  });

  it('ping succeeds', async () => {
    // ping() returns an empty result object on success, throws on failure
    await expect(ctx.client.ping()).resolves.toBeDefined();
  });

  it('tools/list returns all three tools', async () => {
    const result = await ctx.client.listTools();
    expect(result.tools).toHaveLength(3);
    const names = result.tools.map(t => t.name).sort();
    expect(names).toEqual(['execute', 'search', 'status']);
  });

  // --- search (Code Mode discovery) ---

  it('search: returns results for keyword query', async () => {
    const result = await ctx.client.callTool({
      name: 'search',
      arguments: { query: 'create', detail: 'brief', limit: 5 },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.total).toBeGreaterThan(0);
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results[0]).toHaveProperty('name');
    expect(data.results[0]).toHaveProperty('summary');
  });

  it('search: domain filter restricts results', async () => {
    const result = await ctx.client.callTool({
      name: 'search',
      arguments: { query: '', domain: 'enrichments' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.total).toBeGreaterThanOrEqual(5); // enrichments has 5 ops
    for (const r of data.results) {
      expect(r.name).toMatch(/^enrichments\./);
    }
  });

  it('search: detailed level returns params', async () => {
    const result = await ctx.client.callTool({
      name: 'search',
      arguments: { query: 'websets.create', detail: 'detailed', limit: 1 },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.results[0]).toHaveProperty('params');
    expect(Array.isArray(data.results[0].params)).toBe(true);
  });

  // --- execute (Code Mode execution) ---

  it('execute: runs simple code and returns result', async () => {
    const result = await ctx.client.callTool({
      name: 'execute',
      arguments: { code: 'return 1 + 2' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.result).toBe(3);
  });

  it('execute: callOperation dispatches to websets.list', async () => {
    const result = await ctx.client.callTool({
      name: 'execute',
      arguments: {
        code: `
          const data = await callOperation('websets.list', { limit: 1 });
          return { type: typeof data, hasData: data !== null };
        `,
      },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.result.hasData).toBe(true);
  });

  it('execute: full lifecycle via callOperation', async () => {
    const result = await ctx.client.callTool({
      name: 'execute',
      arguments: {
        code: `
          const ws = await callOperation('websets.create', {
            searchQuery: 'E2E test', searchCount: 5,
            entity: { type: 'company' }
          });
          const got = await callOperation('websets.get', { id: ws.id });
          await callOperation('websets.cancel', { id: ws.id });
          await callOperation('websets.delete', { id: ws.id });
          return { created: ws.id, verified: got.id === ws.id };
        `,
      },
    });
    expect(result.isError).toBeFalsy();
  });

  it('execute: captures console output', async () => {
    const result = await ctx.client.callTool({
      name: 'execute',
      arguments: { code: 'console.log("hello from sandbox"); return "done"' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.result).toBe('done');
    expect(data.logs).toContain('hello from sandbox');
  });

  it('execute: returns error for invalid operation', async () => {
    const result = await ctx.client.callTool({
      name: 'execute',
      arguments: {
        code: 'return await callOperation("nonexistent.op", {})',
      },
    });
    expect(result.isError).toBeTruthy();
  });

  it('execute: respects timeout', async () => {
    const result = await ctx.client.callTool({
      name: 'execute',
      arguments: { code: 'while(true) {}', timeout: 200 },
    });
    expect(result.isError).toBeTruthy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toMatch(/timed out/i);
  });
});
