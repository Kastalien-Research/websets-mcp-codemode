import { describe, it, expect } from 'vitest';
import { successResult, errorResult } from '../types.js';

describe('successResult', () => {
  it('wraps data in content array with pretty JSON', () => {
    const result = successResult({ id: 'test_123', status: 'active' });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'test_123', status: 'active' });
    expect(result.isError).toBeUndefined();
  });

  it('handles null', () => {
    const result = successResult(null);
    expect(result.content[0].text).toBe('null');
  });
});

describe('errorResult', () => {
  it('formats Error instances', () => {
    const result = errorResult('websets.create', new Error('API key invalid'));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error in websets.create: API key invalid');
  });

  it('handles non-Error values', () => {
    const result = errorResult('searches.get', 'timeout');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error in searches.get: timeout');
  });

  it('yelp.* 401 hints at YELP_API_KEY', () => {
    const result = errorResult('yelp.search', new Error('401 Unauthorized'));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('YELP_API_KEY');
    expect(result.content[0].text).not.toContain('EXA_API_KEY');
  });

  it('non-yelp 401 hints at EXA_API_KEY', () => {
    const result = errorResult('searches.create', new Error('401 Unauthorized'));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('EXA_API_KEY');
    expect(result.content[0].text).not.toContain('YELP_API_KEY');
  });
});
