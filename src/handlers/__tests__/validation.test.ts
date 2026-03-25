import { describe, it, expect } from 'vitest';
import { requireParams, validationError, errorResult } from '../types.js';

describe('requireParams', () => {
  it('returns null when all params present', () => {
    const result = requireParams('websets.get', { id: 'ws_123' }, 'id');
    expect(result).toBeNull();
  });

  it('returns null when multiple params all present', () => {
    const result = requireParams('searches.get', { websetId: 'ws_1', searchId: 's_1' }, 'websetId', 'searchId');
    expect(result).toBeNull();
  });

  it('returns error for single missing param', () => {
    const result = requireParams('websets.get', {}, 'id');
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toBe('Missing required parameter(s) for websets.get: id');
  });

  it('returns error listing multiple missing params', () => {
    const result = requireParams('searches.get', {}, 'websetId', 'searchId');
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toBe('Missing required parameter(s) for searches.get: websetId, searchId');
  });

  it('returns error only for missing params when some are present', () => {
    const result = requireParams('searches.get', { websetId: 'ws_1' }, 'websetId', 'searchId');
    expect(result).not.toBeNull();
    expect(result!.content[0].text).toBe('Missing required parameter(s) for searches.get: searchId');
  });

  it('treats null as missing', () => {
    const result = requireParams('websets.get', { id: null }, 'id');
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
  });

  it('does NOT treat 0 as missing', () => {
    const result = requireParams('test.op', { count: 0 }, 'count');
    expect(result).toBeNull();
  });

  it('does NOT treat false as missing', () => {
    const result = requireParams('test.op', { flag: false }, 'flag');
    expect(result).toBeNull();
  });

  it('does NOT treat empty string as missing', () => {
    const result = requireParams('test.op', { name: '' }, 'name');
    expect(result).toBeNull();
  });
});

describe('validationError', () => {
  it('returns error ToolResult with message', () => {
    const result = validationError('Too many options: 200. Maximum is 150 options.');
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('Too many options: 200. Maximum is 150 options.');
  });
});

describe('errorResult with hints', () => {
  it('appends hints after double newline', () => {
    const result = errorResult('searches.create', new Error('bad request'), 'Hint: check your params');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error in searches.create: bad request\n\nHint: check your params');
  });

  it('works without hints (backward compatible)', () => {
    const result = errorResult('websets.get', new Error('something went wrong'));
    expect(result.content[0].text).toBe('Error in websets.get: something went wrong');
  });

  it('auto-detects not-found pattern and appends hint', () => {
    const result = errorResult('websets.get', new Error('not found'));
    expect(result.content[0].text).toContain('Error in websets.get: not found');
    expect(result.content[0].text).toContain('Resource not found');
  });
});
