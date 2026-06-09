import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { parseUpstreamClientEnvs, resolveExaApiKey } from '../auth.js';

function mockRequest(headers: Record<string, string | string[]>): Request {
  return { headers } as Request;
}

describe('parseUpstreamClientEnvs', () => {
  it('parses EXA_API_KEY from x-stainless-mcp-client-envs', () => {
    const req = mockRequest({
      'x-stainless-mcp-client-envs': JSON.stringify({ EXA_API_KEY: 'user-key' }),
    });
    expect(parseUpstreamClientEnvs(req)).toEqual({ EXA_API_KEY: 'user-key' });
  });

  it('returns undefined for malformed JSON', () => {
    const req = mockRequest({ 'x-stainless-mcp-client-envs': 'not-json' });
    expect(parseUpstreamClientEnvs(req)).toBeUndefined();
  });
});

describe('resolveExaApiKey', () => {
  it('prefers stainless client envs over headers and fallback', () => {
    const req = mockRequest({
      'x-stainless-mcp-client-envs': JSON.stringify({ EXA_API_KEY: 'stainless-key' }),
      'x-api-key': 'header-key',
      authorization: 'Bearer bearer-key',
    });
    expect(resolveExaApiKey(req, 'fallback-key')).toBe('stainless-key');
  });

  it('uses x-api-key when stainless envs absent', () => {
    const req = mockRequest({ 'x-api-key': 'header-key' });
    expect(resolveExaApiKey(req, 'fallback-key')).toBe('header-key');
  });

  it('uses Bearer token when only authorization is set', () => {
    const req = mockRequest({ authorization: 'Bearer bearer-key' });
    expect(resolveExaApiKey(req, 'fallback-key')).toBe('bearer-key');
  });

  it('falls back to server default', () => {
    const req = mockRequest({});
    expect(resolveExaApiKey(req, 'fallback-key')).toBe('fallback-key');
  });
});
