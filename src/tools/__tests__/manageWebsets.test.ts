import { describe, it, expect, vi } from 'vitest';
import { dispatchOperation } from '../operations.js';

describe('dispatchOperation', () => {
  it('applies safe compat coercions and returns metadata', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      id: 'search_1',
      status: 'completed',
      query: 'ai startups',
    });

    const exa = {
      websets: {
        searches: {
          create: createSpy,
        },
      },
    } as any;

    const result = await dispatchOperation(
      'searches.create',
      {
        compat: { mode: 'safe' },
        websetId: 'ws_1',
        query: 'ai startups',
        entity: 'company',
        criteria: ['has funding'],
        count: '25',
      },
      exa,
      'strict',
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith('ws_1', {
      query: 'ai startups',
      count: 25,
      entity: { type: 'company' },
      criteria: [{ description: 'has funding' }],
    });

    const body = JSON.parse(result.content[0].text);
    expect(body._coercions).toHaveLength(3);
    expect(body._coercions.map((c: { path: string }) => c.path)).toEqual([
      'args.entity',
      'args.criteria',
      'args.count',
    ]);
  });

  it('accepts valid args without coercion', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      id: 'search_1',
      status: 'completed',
      query: 'ai startups',
    });

    const exa = {
      websets: {
        searches: {
          create: createSpy,
        },
      },
    } as any;

    await dispatchOperation(
      'searches.create',
      {
        websetId: 'ws_1',
        query: 'ai startups',
        entity: { type: 'company' },
        criteria: [{ description: 'has funding' }],
      },
      exa,
      'strict',
    );

    expect(createSpy).toHaveBeenCalledWith('ws_1', {
      query: 'ai startups',
      entity: { type: 'company' },
      criteria: [{ description: 'has funding' }],
    });
  });

  it('fails validation in strict mode for uncoerced compatibility formats', async () => {
    const createSpy = vi.fn();

    const exa = {
      websets: {
        searches: {
          create: createSpy,
        },
      },
    } as any;

    const result = await dispatchOperation(
      'searches.create',
      {
        websetId: 'ws_1',
        query: 'ai startups',
        entity: 'company',
      },
      exa,
      'strict',
    );

    expect(createSpy).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error in searches.create: Validation failed');
  });

  it('reports warning for unsupported compat mode', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      id: 'search_1',
      status: 'completed',
      query: 'ai startups',
    });

    const exa = {
      websets: {
        searches: {
          create: createSpy,
        },
      },
    } as any;

    const result = await dispatchOperation(
      'searches.create',
      {
        compat: { mode: 'aggressive' as any },
        websetId: 'ws_1',
        query: 'ai startups',
      },
      exa,
      'strict',
    );

    const body = JSON.parse(result.content[0].text);
    expect(body._warnings).toEqual(['Unsupported compat mode "aggressive"; ignored.']);
  });

  it('honors safe default compat mode and per-call strict override', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      id: 'search_1',
      status: 'completed',
      query: 'ai startups',
    });

    const exa = {
      websets: {
        searches: {
          create: createSpy,
        },
      },
    } as any;

    // Safe mode default — entity coercion fires
    await dispatchOperation(
      'searches.create',
      {
        websetId: 'ws_1',
        query: 'ai startups',
        entity: 'company',
      },
      exa,
      'safe',
    );

    expect(createSpy).toHaveBeenNthCalledWith(1, 'ws_1', {
      query: 'ai startups',
      entity: { type: 'company' },
    });

    // Per-call strict override — entity coercion does NOT fire
    const strictResult = await dispatchOperation(
      'searches.create',
      {
        compat: { mode: 'strict' },
        websetId: 'ws_1',
        query: 'ai startups',
        entity: 'company',
      },
      exa,
      'safe',
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(strictResult.isError).toBe(true);
    expect(strictResult.content[0].text).toContain('Error in searches.create: Validation failed');
  });

  it('returns preview without executing handler when compat.preview=true', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      id: 'search_1',
      status: 'completed',
      query: 'ai startups',
    });

    const exa = {
      websets: {
        searches: {
          create: createSpy,
        },
      },
    } as any;

    const result = await dispatchOperation(
      'searches.create',
      {
        compat: { mode: 'safe', preview: true },
        websetId: 'ws_1',
        query: 'ai startups',
        entity: 'company',
      },
      exa,
      'strict',
    );

    expect(createSpy).not.toHaveBeenCalled();
    const body = JSON.parse(result.content[0].text);
    expect(body.preview).toBe(true);
    expect(body.execution).toBe('skipped');
    expect(body.effectiveCompatMode).toBe('safe');
    expect(body.normalizedArgs).toEqual({
      websetId: 'ws_1',
      query: 'ai startups',
      entity: { type: 'company' },
    });
    expect(body._coercions).toHaveLength(1);
  });

  it('preserves enrichment options when creating websets', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      id: 'ws_1',
      status: 'ready',
      search: { query: 'ai startups' },
    });

    const exa = {
      websets: {
        create: createSpy,
      },
    } as any;

    await dispatchOperation(
      'websets.create',
      {
        searchQuery: 'ai startups',
        enrichments: [
          {
            description: 'Company stage',
            format: 'options',
            options: [{ label: 'Seed' }, { label: 'Series A' }],
          },
        ],
      },
      exa,
      'strict',
    );

    expect(createSpy).toHaveBeenCalledWith({
      search: {
        query: 'ai startups',
        count: 10,
      },
      enrichments: [
        {
          description: 'Company stage',
          format: 'options',
          options: [{ label: 'Seed' }, { label: 'Series A' }],
        },
      ],
    });
  });

  it('returns error for unknown operation', async () => {
    const exa = {} as any;
    const result = await dispatchOperation('nonexistent.op', {}, exa, 'strict');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown operation: nonexistent.op');
  });
});
