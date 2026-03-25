import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '../../server.js';
import type { Server as HttpServer } from 'node:http';

describe('Health endpoint', () => {
  let httpServer: HttpServer;
  let baseUrl: string;

  beforeAll(async () => {
    const { app } = createServer({ exaApiKey: '', host: '127.0.0.1' });
    httpServer = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('No address');
    baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('GET /health returns 200 with status ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('GET /health returns JSON content-type', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});

describe('Tool registration (no API key required)', () => {
  let httpServer: HttpServer;
  let baseUrl: string;

  beforeAll(async () => {
    const { app } = createServer({ exaApiKey: '', host: '127.0.0.1' });
    httpServer = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('No address');
    baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('tools/list returns all three tools', async () => {
    const client = new Client({ name: 'health-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    try {
      await client.connect(transport);
      const result = await client.listTools();
      expect(result.tools).toHaveLength(3);
      const names = result.tools.map(t => t.name).sort();
      expect(names).toEqual(['execute', 'search', 'status']);
    } finally {
      await client.close();
    }
  });

  it('search tool works without API key', async () => {
    const client = new Client({ name: 'health-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'search',
        arguments: { query: 'create', limit: 3 },
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0].text);
      expect(data.total).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('execute tool runs pure code without API key', async () => {
    const client = new Client({ name: 'health-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'execute',
        arguments: { code: 'return 42' },
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0].text);
      expect(data.result).toBe(42);
    } finally {
      await client.close();
    }
  });
});
