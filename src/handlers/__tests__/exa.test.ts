import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Exa } from 'exa-js';
import * as exaHandlers from '../exa.js';

// Mock Exa client with top-level search methods
function createMockExa() {
  return {
    search: vi.fn().mockResolvedValue({ results: [{ title: 'Test', url: 'https://example.com' }] }),
    findSimilar: vi.fn().mockResolvedValue({ results: [{ title: 'Similar', url: 'https://similar.com' }] }),
    getContents: vi.fn().mockResolvedValue({ results: [{ url: 'https://example.com', text: 'Content' }] }),
    answer: vi.fn().mockResolvedValue({ answer: 'The answer is 42', citations: [] }),
  } as unknown as Exa;
}

describe('exa.search', () => {
  let exa: Exa;
  beforeEach(() => { exa = createMockExa(); });

  it('requires query', async () => {
    const result = await exaHandlers.search({}, exa);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing required parameter');
    expect(result.content[0].text).toContain('query');
  });

  it('calls exa.search with query only', async () => {
    const result = await exaHandlers.search({ query: 'test query' }, exa);
    expect(result.isError).toBeUndefined();
    expect((exa.search as any)).toHaveBeenCalledWith('test query', undefined);
  });

  it('passes all options through', async () => {
    // Options reflect the current exa.search schema (curated against the Exa
    // API spec). includeText/excludeText/useAutoprompt are NOT search params
    // (includeText/excludeText live on findSimilar), and `type` uses the
    // current enum (instant/fast/auto/deep-*), not the retired 'neural'.
    await exaHandlers.search({
      query: 'AI startups',
      type: 'auto',
      numResults: 5,
      category: 'company',
      includeDomains: ['example.com'],
      excludeDomains: ['spam.com'],
      startPublishedDate: '2024-01-01T00:00:00.000Z',
      endPublishedDate: '2024-12-31T00:00:00.000Z',
      contents: { text: true, summary: true },
      userLocation: 'US',
      moderation: true,
    }, exa);
    const call = (exa.search as any).mock.calls[0];
    expect(call[0]).toBe('AI startups');
    expect(call[1]).toMatchObject({
      type: 'auto',
      numResults: 5,
      category: 'company',
      includeDomains: ['example.com'],
      excludeDomains: ['spam.com'],
      contents: { text: true, summary: true },
      userLocation: 'US',
      moderation: true,
    });
  });

  it('supports deep search with additionalQueries', async () => {
    await exaHandlers.search({
      query: 'machine learning',
      type: 'deep',
      additionalQueries: ['ML algorithms', 'neural networks'],
    }, exa);
    const opts = (exa.search as any).mock.calls[0][1];
    expect(opts.type).toBe('deep');
    expect(opts.additionalQueries).toEqual(['ML algorithms', 'neural networks']);
  });

  it('returns error with hints on failure', async () => {
    (exa.search as any).mockRejectedValue(new Error('Invalid category'));
    const result = await exaHandlers.search({ query: 'test' }, exa);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid category');
    expect(result.content[0].text).toContain('Common issues');
    expect(result.content[0].text).toContain('additionalQueries only works when type is "deep"');
  });
});

describe('exa.findSimilar', () => {
  let exa: Exa;
  beforeEach(() => { exa = createMockExa(); });

  it('requires url', async () => {
    const result = await exaHandlers.findSimilar({}, exa);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('url');
  });

  it('calls exa.findSimilar with url only', async () => {
    const result = await exaHandlers.findSimilar({ url: 'https://example.com' }, exa);
    expect(result.isError).toBeUndefined();
    expect((exa.findSimilar as any)).toHaveBeenCalledWith('https://example.com', undefined);
  });

  it('passes options through', async () => {
    await exaHandlers.findSimilar({
      url: 'https://example.com',
      numResults: 10,
      excludeSourceDomain: true,
      includeDomains: ['similar.com'],
      contents: { text: true },
      category: 'company',
    }, exa);
    const opts = (exa.findSimilar as any).mock.calls[0][1];
    expect(opts.numResults).toBe(10);
    expect(opts.excludeSourceDomain).toBe(true);
    expect(opts.includeDomains).toEqual(['similar.com']);
    expect(opts.contents).toEqual({ text: true });
    expect(opts.category).toBe('company');
  });

  it('returns error on failure', async () => {
    (exa.findSimilar as any).mockRejectedValue(new Error('URL not found'));
    const result = await exaHandlers.findSimilar({ url: 'https://bad.com' }, exa);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('URL not found');
  });
});

describe('exa.getContents', () => {
  let exa: Exa;
  beforeEach(() => { exa = createMockExa(); });

  it('requires urls', async () => {
    const result = await exaHandlers.getContents({}, exa);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('urls');
  });

  it('accepts a single URL string', async () => {
    await exaHandlers.getContents({ urls: 'https://example.com' }, exa);
    expect((exa.getContents as any)).toHaveBeenCalledWith('https://example.com', undefined);
  });

  it('accepts an array of URLs', async () => {
    const urls = ['https://a.com', 'https://b.com'];
    await exaHandlers.getContents({ urls }, exa);
    expect((exa.getContents as any)).toHaveBeenCalledWith(urls, undefined);
  });

  it('passes content options through', async () => {
    await exaHandlers.getContents({
      urls: ['https://example.com'],
      text: true,
      highlights: true,
      summary: { query: 'summarize this' },
      livecrawl: 'always',
      livecrawlTimeout: 5000,
      maxAgeHours: 24,
      subpages: 3,
      subpageTarget: '/docs',
      extras: { links: 10 },
      context: true,
    }, exa);
    const opts = (exa.getContents as any).mock.calls[0][1];
    expect(opts.text).toBe(true);
    expect(opts.highlights).toBe(true);
    expect(opts.summary).toEqual({ query: 'summarize this' });
    expect(opts.livecrawl).toBe('always');
    expect(opts.subpages).toBe(3);
    expect(opts.extras).toEqual({ links: 10 });
  });

  it('returns error on failure', async () => {
    (exa.getContents as any).mockRejectedValue(new Error('Rate limit'));
    const result = await exaHandlers.getContents({ urls: ['https://x.com'] }, exa);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Rate limit');
  });
});

describe('exa.answer', () => {
  let exa: Exa;
  beforeEach(() => { exa = createMockExa(); });

  it('requires query', async () => {
    const result = await exaHandlers.answer({}, exa);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query');
  });

  it('calls exa.answer with query only', async () => {
    const result = await exaHandlers.answer({ query: 'What is quantum computing?' }, exa);
    expect(result.isError).toBeUndefined();
    expect((exa.answer as any)).toHaveBeenCalledWith('What is quantum computing?', undefined);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.answer).toBe('The answer is 42');
  });

  it('passes all options through', async () => {
    // Options reflect the current exa.answer schema (curated against the Exa
    // API spec): text, outputSchema, userLocation (+ stream). model/systemPrompt
    // are not part of the current answer contract.
    await exaHandlers.answer({
      query: 'Explain AI',
      text: true,
      outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
      userLocation: 'US',
    }, exa);
    const opts = (exa.answer as any).mock.calls[0][1];
    expect(opts.text).toBe(true);
    expect(opts.outputSchema).toEqual({ type: 'object', properties: { summary: { type: 'string' } } });
    expect(opts.userLocation).toBe('US');
  });

  it('returns error on failure', async () => {
    (exa.answer as any).mockRejectedValue(new Error('Model unavailable'));
    const result = await exaHandlers.answer({ query: 'test' }, exa);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Model unavailable');
  });
});
