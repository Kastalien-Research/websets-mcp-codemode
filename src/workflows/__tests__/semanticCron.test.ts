import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  expandTemplates,
  resolveEnrichmentDescriptions,
  evaluateCondition,
  evaluateShape,
  joinLensResults,
  evaluateSignal,
  computeDelta,
  buildSnapshot,
  type JoinResult,
  type SignalResult,
} from '../semanticCron.js';
import { TaskStore } from '../../lib/taskStore.js';
import '../semanticCron.js';
import { workflowRegistry } from '../types.js';

// --- Mock helpers ---

function mockRawItem(overrides: {
  id?: string;
  name?: string;
  url?: string;
  entityType?: string;
  enrichments?: Array<{
    enrichmentId: string;
    format: string;
    result: string[] | null;
    status: string;
    object?: string;
  }>;
  evaluations?: Array<{ criterion: string; satisfied: string }>;
  createdAt?: string;
} = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? `item_${Math.random().toString(36).slice(2)}`,
    object: 'webset_item',
    evaluations: overrides.evaluations ?? [{ criterion: 'default', satisfied: 'yes' }],
    enrichments: overrides.enrichments ?? null,
    properties: {
      type: overrides.entityType ?? 'company',
      company: { name: overrides.name ?? 'Test Corp' },
      url: overrides.url ?? 'https://test.com',
    },
    websetId: 'ws_test',
    createdAt: overrides.createdAt ?? '2026-01-15T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
  };
}

function mockWebset(
  id: string,
  enrichmentDefs: Array<{ id: string; description: string; format?: string }>,
): any {
  return {
    id,
    status: 'idle',
    searches: [],
    enrichments: enrichmentDefs.map(d => ({
      id: d.id,
      description: d.description,
      format: d.format ?? 'text',
      status: 'completed',
    })),
  };
}

function createMockExa(
  lensConfigs: Record<
    string,
    {
      webset: any;
      items: any[];
    }
  >,
): any {
  let createCallIndex = 0;
  const lensOrder = Object.keys(lensConfigs);

  return {
    websets: {
      create: vi.fn().mockImplementation(async () => {
        const lensId = lensOrder[createCallIndex++];
        return lensConfigs[lensId].webset;
      }),
      get: vi.fn().mockImplementation(async (id: string) => {
        for (const cfg of Object.values(lensConfigs)) {
          if (cfg.webset.id === id) return cfg.webset;
        }
        return { id, status: 'idle', searches: [], enrichments: [] };
      }),
      cancel: vi.fn(),
      items: {
        listAll: vi.fn().mockImplementation(function (wsId: string) {
          for (const cfg of Object.values(lensConfigs)) {
            if (cfg.webset.id === wsId) {
              return (async function* () {
                for (const item of cfg.items) yield item;
              })();
            }
          }
          return (async function* () {})();
        }),
      },
      monitors: {
        create: vi.fn().mockResolvedValue({ id: 'mon_1' }),
      },
    },
  };
}

// --- Template expansion tests ---

describe('expandTemplates', () => {
  const baseConfig = {
    lenses: [
      {
        id: 'hiring',
        source: {
          query: '{{company}} hiring engineers',
          criteria: [{ description: '{{company}} related' }],
          enrichments: [{ description: 'Number of {{role}} roles' }],
        },
      },
    ],
    shapes: [
      {
        lensId: 'hiring',
        conditions: [{ enrichment: 'Number of {{role}} roles', operator: 'gte', value: 5 }],
        logic: 'all' as const,
      },
    ],
    join: { by: 'entity' as const },
    signal: { requires: { type: 'all' as const } },
  };

  it('replaces template variables in query, criteria, enrichments, and shape conditions', () => {
    const result = expandTemplates(baseConfig, { company: 'Acme', role: 'senior' });
    expect(result.lenses[0].source.query).toBe('Acme hiring engineers');
    expect(result.lenses[0].source.criteria![0].description).toBe('Acme related');
    expect(result.lenses[0].source.enrichments![0].description).toBe('Number of senior roles');
    expect(result.shapes[0].conditions[0].enrichment).toBe('Number of senior roles');
  });

  it('replaces multiple occurrences of same variable', () => {
    const cfg = {
      lenses: [{ id: 'a', source: { query: '{{x}} and {{x}}' } }],
      shapes: [],
      join: { by: 'entity' as const },
      signal: { requires: { type: 'all' as const } },
    };
    const result = expandTemplates(cfg, { x: 'foo' });
    expect(result.lenses[0].source.query).toBe('foo and foo');
  });

  it('throws on unresolved variables', () => {
    expect(() => expandTemplates(baseConfig, { company: 'Acme' })).toThrow(
      'Unresolved template variables',
    );
  });

  it('passes through config without templates when no variables', () => {
    const cfg = {
      lenses: [{ id: 'a', source: { query: 'plain query' } }],
      shapes: [],
      join: { by: 'entity' as const },
      signal: { requires: { type: 'all' as const } },
    };
    const result = expandTemplates(cfg, {});
    expect(result.lenses[0].source.query).toBe('plain query');
  });

  it('does not modify original config', () => {
    const cfg = {
      lenses: [{ id: 'a', source: { query: '{{x}}' } }],
      shapes: [],
      join: { by: 'entity' as const },
      signal: { requires: { type: 'all' as const } },
    };
    const original = JSON.stringify(cfg);
    expandTemplates(cfg, { x: 'replaced' });
    expect(JSON.stringify(cfg)).toBe(original);
  });
});

// --- Enrichment resolver tests ---

describe('resolveEnrichmentDescriptions', () => {
  it('maps enrichmentId to description', () => {
    const items = [
      mockRawItem({
        enrichments: [
          { enrichmentId: 'enr_1', format: 'number', result: ['42'], status: 'completed' },
        ],
      }),
    ];
    const map = new Map([['enr_1', 'Employee count']]);
    const result = resolveEnrichmentDescriptions(items, map);
    expect(result[0].enrichments).toHaveLength(1);
    expect(result[0].enrichments[0].description).toBe('Employee count');
    expect(result[0].enrichments[0].result).toEqual(['42']);
  });

  it('skips enrichments with unknown enrichmentId', () => {
    const items = [
      mockRawItem({
        enrichments: [
          { enrichmentId: 'enr_unknown', format: 'text', result: ['hi'], status: 'completed' },
        ],
      }),
    ];
    const map = new Map([['enr_1', 'Something else']]);
    const result = resolveEnrichmentDescriptions(items, map);
    expect(result[0].enrichments).toHaveLength(0);
  });

  it('returns empty array for null enrichments', () => {
    const items = [mockRawItem({ enrichments: undefined })];
    const map = new Map<string, string>();
    const result = resolveEnrichmentDescriptions(items, map);
    expect(result[0].enrichments).toEqual([]);
  });

  it('handles multiple enrichments on same item', () => {
    const items = [
      mockRawItem({
        enrichments: [
          { enrichmentId: 'enr_1', format: 'number', result: ['100'], status: 'completed' },
          { enrichmentId: 'enr_2', format: 'text', result: ['hello'], status: 'completed' },
        ],
      }),
    ];
    const map = new Map([
      ['enr_1', 'Employee count'],
      ['enr_2', 'Description'],
    ]);
    const result = resolveEnrichmentDescriptions(items, map);
    expect(result[0].enrichments).toHaveLength(2);
    expect(result[0].enrichments[0].description).toBe('Employee count');
    expect(result[0].enrichments[1].description).toBe('Description');
  });
});

// --- Condition evaluator tests ---

describe('evaluateCondition', () => {
  it('gte: true when value >= threshold', () => {
    expect(evaluateCondition({ enrichment: 'x', operator: 'gte', value: 10 }, ['15'])).toBe(true);
    expect(evaluateCondition({ enrichment: 'x', operator: 'gte', value: 10 }, ['10'])).toBe(true);
  });

  it('gt: true only when value > threshold', () => {
    expect(evaluateCondition({ enrichment: 'x', operator: 'gt', value: 10 }, ['11'])).toBe(true);
    expect(evaluateCondition({ enrichment: 'x', operator: 'gt', value: 10 }, ['10'])).toBe(false);
  });

  it('lte: true when value <= threshold', () => {
    expect(evaluateCondition({ enrichment: 'x', operator: 'lte', value: 10 }, ['5'])).toBe(true);
    expect(evaluateCondition({ enrichment: 'x', operator: 'lte', value: 10 }, ['10'])).toBe(true);
  });

  it('lt: true only when value < threshold', () => {
    expect(evaluateCondition({ enrichment: 'x', operator: 'lt', value: 10 }, ['9'])).toBe(true);
    expect(evaluateCondition({ enrichment: 'x', operator: 'lt', value: 10 }, ['10'])).toBe(false);
  });

  it('eq: true for exact numeric match', () => {
    expect(evaluateCondition({ enrichment: 'x', operator: 'eq', value: 42 }, ['42'])).toBe(true);
    expect(evaluateCondition({ enrichment: 'x', operator: 'eq', value: 42 }, ['43'])).toBe(false);
  });

  it('contains: case-insensitive substring match', () => {
    expect(
      evaluateCondition({ enrichment: 'x', operator: 'contains', value: 'series a' }, ['Series A funding']),
    ).toBe(true);
    expect(
      evaluateCondition({ enrichment: 'x', operator: 'contains', value: 'series b' }, ['Series A funding']),
    ).toBe(false);
  });

  it('matches: regex match', () => {
    expect(
      evaluateCondition({ enrichment: 'x', operator: 'matches', value: '^\\d{4}-\\d{2}' }, ['2025-01-15']),
    ).toBe(true);
    expect(
      evaluateCondition({ enrichment: 'x', operator: 'matches', value: '^\\d{4}-\\d{2}' }, ['Jan 15']),
    ).toBe(false);
  });

  it('oneOf: case-insensitive match against array', () => {
    expect(
      evaluateCondition(
        { enrichment: 'x', operator: 'oneOf', value: ['Series A', 'Series B'] },
        ['series a'],
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { enrichment: 'x', operator: 'oneOf', value: ['Series A', 'Series B'] },
        ['Series C'],
      ),
    ).toBe(false);
  });

  it('exists: true when result is non-null with content', () => {
    expect(evaluateCondition({ enrichment: 'x', operator: 'exists' }, ['hello'])).toBe(true);
    expect(evaluateCondition({ enrichment: 'x', operator: 'exists' }, null)).toBe(false);
    expect(evaluateCondition({ enrichment: 'x', operator: 'exists' }, [''])).toBe(false);
    expect(evaluateCondition({ enrichment: 'x', operator: 'exists' }, [])).toBe(false);
  });

  it('withinDays: true when date is within window', () => {
    const recent = new Date(Date.now() - 2 * 86400000).toISOString(); // 2 days ago
    expect(
      evaluateCondition({ enrichment: 'x', operator: 'withinDays', value: 5 }, [recent]),
    ).toBe(true);

    const old = new Date(Date.now() - 30 * 86400000).toISOString(); // 30 days ago
    expect(
      evaluateCondition({ enrichment: 'x', operator: 'withinDays', value: 5 }, [old]),
    ).toBe(false);
  });

  it('returns false for null result (non-exists operators)', () => {
    expect(evaluateCondition({ enrichment: 'x', operator: 'gte', value: 1 }, null)).toBe(false);
    expect(evaluateCondition({ enrichment: 'x', operator: 'contains', value: 'a' }, null)).toBe(false);
  });

  it('returns false for NaN numeric value', () => {
    expect(evaluateCondition({ enrichment: 'x', operator: 'gte', value: 10 }, ['not-a-number'])).toBe(false);
  });

  it('withinDays returns false for invalid date', () => {
    expect(
      evaluateCondition({ enrichment: 'x', operator: 'withinDays', value: 5 }, ['not-a-date']),
    ).toBe(false);
  });
});

// --- Shape evaluator tests ---

describe('evaluateShape', () => {
  const enrichments = [
    { description: 'Employee count', result: ['150'] as string[] | null, format: 'number' },
    { description: 'Funding stage', result: ['Series B'] as string[] | null, format: 'text' },
  ];

  it('all logic: true when all conditions pass', () => {
    const shape = {
      lensId: 'test',
      conditions: [
        { enrichment: 'Employee count', operator: 'gte', value: 100 },
        { enrichment: 'Funding stage', operator: 'contains', value: 'Series' },
      ],
      logic: 'all' as const,
    };
    expect(evaluateShape(shape, enrichments)).toBe(true);
  });

  it('all logic: false when any condition fails', () => {
    const shape = {
      lensId: 'test',
      conditions: [
        { enrichment: 'Employee count', operator: 'gte', value: 200 }, // fails: 150 < 200
        { enrichment: 'Funding stage', operator: 'contains', value: 'Series' },
      ],
      logic: 'all' as const,
    };
    expect(evaluateShape(shape, enrichments)).toBe(false);
  });

  it('any logic: true when at least one condition passes', () => {
    const shape = {
      lensId: 'test',
      conditions: [
        { enrichment: 'Employee count', operator: 'gte', value: 200 }, // fails
        { enrichment: 'Funding stage', operator: 'contains', value: 'Series' }, // passes
      ],
      logic: 'any' as const,
    };
    expect(evaluateShape(shape, enrichments)).toBe(true);
  });

  it('returns false for missing enrichment', () => {
    const shape = {
      lensId: 'test',
      conditions: [{ enrichment: 'Nonexistent', operator: 'exists' }],
      logic: 'all' as const,
    };
    expect(evaluateShape(shape, enrichments)).toBe(false);
  });

  it('handles empty conditions (vacuously true)', () => {
    const shape = { lensId: 'test', conditions: [], logic: 'all' as const };
    expect(evaluateShape(shape, enrichments)).toBe(true);
  });
});

// --- Join engine tests ---

describe('joinLensResults — entity', () => {
  it('joins by URL exact match', () => {
    const lensResults = [
      {
        lensId: 'hiring',
        websetId: 'ws_1',
        totalItems: 2,
        shapedItems: [
          { id: '1', name: 'Acme', url: 'https://acme.com', entityType: 'company', enrichments: { x: 1 }, createdAt: '2026-01-15T00:00:00Z', projected: {} },
        ],
      },
      {
        lensId: 'funding',
        websetId: 'ws_2',
        totalItems: 2,
        shapedItems: [
          { id: '2', name: 'Acme Corp', url: 'https://acme.com', entityType: 'company', enrichments: { y: 2 }, createdAt: '2026-01-16T00:00:00Z', projected: {} },
        ],
      },
    ];

    const result = joinLensResults(lensResults, { by: 'entity' });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].entity).toBe('Acme');
    expect(result.entities[0].presentInLenses).toContain('hiring');
    expect(result.entities[0].presentInLenses).toContain('funding');
    expect(result.entities[0].lensCount).toBe(2);
  });

  it('joins by fuzzy name match', () => {
    const lensResults = [
      {
        lensId: 'a',
        websetId: 'ws_1',
        totalItems: 1,
        shapedItems: [
          { id: '1', name: 'Acme Corporation', url: 'https://a.com', entityType: 'company', enrichments: {}, createdAt: '2026-01-15T00:00:00Z', projected: {} },
        ],
      },
      {
        lensId: 'b',
        websetId: 'ws_2',
        totalItems: 1,
        shapedItems: [
          { id: '2', name: 'Acme Corporation', url: 'https://b.com', entityType: 'company', enrichments: {}, createdAt: '2026-01-15T00:00:00Z', projected: {} },
        ],
      },
    ];

    const result = joinLensResults(lensResults, { by: 'entity' });
    // Same name, different URLs → fuzzy match should succeed (dice coefficient = 1.0)
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].lensCount).toBe(2);
  });

  it('respects minLensOverlap', () => {
    const lensResults = [
      {
        lensId: 'a',
        websetId: 'ws_1',
        totalItems: 1,
        shapedItems: [
          { id: '1', name: 'Solo', url: 'https://solo.com', entityType: 'company', enrichments: {}, createdAt: '2026-01-15T00:00:00Z', projected: {} },
        ],
      },
      {
        lensId: 'b',
        websetId: 'ws_2',
        totalItems: 1,
        shapedItems: [
          { id: '2', name: 'Different', url: 'https://diff.com', entityType: 'company', enrichments: {}, createdAt: '2026-01-15T00:00:00Z', projected: {} },
        ],
      },
    ];

    const result = joinLensResults(lensResults, { by: 'entity', minLensOverlap: 2 });
    expect(result.entities).toHaveLength(0);
  });

  it('entity+temporal filters by time window', () => {
    const lensResults = [
      {
        lensId: 'a',
        websetId: 'ws_1',
        totalItems: 1,
        shapedItems: [
          { id: '1', name: 'Acme', url: 'https://acme.com', entityType: 'company', enrichments: {}, createdAt: '2026-01-01T00:00:00Z', projected: {} },
        ],
      },
      {
        lensId: 'b',
        websetId: 'ws_2',
        totalItems: 1,
        shapedItems: [
          { id: '2', name: 'Acme', url: 'https://acme.com', entityType: 'company', enrichments: {}, createdAt: '2026-06-01T00:00:00Z', projected: {} },
        ],
      },
    ];

    // 7-day window: items are 5 months apart → should NOT match
    const result = joinLensResults(lensResults, {
      by: 'entity+temporal',
      temporal: { days: 7 },
    });
    expect(result.entities).toHaveLength(0);
  });

  it('entity+temporal passes when items within window', () => {
    const lensResults = [
      {
        lensId: 'a',
        websetId: 'ws_1',
        totalItems: 1,
        shapedItems: [
          { id: '1', name: 'Acme', url: 'https://acme.com', entityType: 'company', enrichments: {}, createdAt: '2026-01-15T00:00:00Z', projected: {} },
        ],
      },
      {
        lensId: 'b',
        websetId: 'ws_2',
        totalItems: 1,
        shapedItems: [
          { id: '2', name: 'Acme', url: 'https://acme.com', entityType: 'company', enrichments: {}, createdAt: '2026-01-17T00:00:00Z', projected: {} },
        ],
      },
    ];

    const result = joinLensResults(lensResults, {
      by: 'entity+temporal',
      temporal: { days: 7 },
    });
    expect(result.entities).toHaveLength(1);
  });

  it('deduplicates entities across multiple lenses', () => {
    const lensResults = [
      {
        lensId: 'a', websetId: 'ws_1', totalItems: 2,
        shapedItems: [
          { id: '1', name: 'Acme', url: 'https://acme.com', entityType: 'company', enrichments: {}, createdAt: '2026-01-15T00:00:00Z', projected: {} },
          { id: '2', name: 'Beta', url: 'https://beta.com', entityType: 'company', enrichments: {}, createdAt: '2026-01-15T00:00:00Z', projected: {} },
        ],
      },
      {
        lensId: 'b', websetId: 'ws_2', totalItems: 1,
        shapedItems: [
          { id: '3', name: 'Acme', url: 'https://acme.com', entityType: 'company', enrichments: {}, createdAt: '2026-01-15T00:00:00Z', projected: {} },
        ],
      },
      {
        lensId: 'c', websetId: 'ws_3', totalItems: 1,
        shapedItems: [
          { id: '4', name: 'Acme', url: 'https://acme.com', entityType: 'company', enrichments: {}, createdAt: '2026-01-15T00:00:00Z', projected: {} },
        ],
      },
    ];

    const result = joinLensResults(lensResults, { by: 'entity', minLensOverlap: 2 });
    // Acme in all 3, Beta only in 1 → filtered out at overlap 2
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].entity).toBe('Acme');
    expect(result.entities[0].lensCount).toBe(3);
  });
});

describe('joinLensResults — keyEnrichment', () => {
  it('joins items by an enrichment value when canonical entity differs', () => {
    const lensResults = [
      {
        lensId: 'twitter',
        websetId: 'ws_1',
        totalItems: 1,
        shapedItems: [
          {
            id: '1',
            name: 'some twitter handle',
            url: 'https://x.com/a/status/1',
            entityType: 'company',
            enrichments: { 'Model name': 'claude-opus-4-7' },
            createdAt: '2026-04-25T00:00:00Z',
            projected: {},
          },
        ],
      },
      {
        lensId: 'github',
        websetId: 'ws_2',
        totalItems: 1,
        shapedItems: [
          {
            id: '2',
            name: 'BerriAI/litellm Issue #26529',
            url: 'https://github.com/BerriAI/litellm/issues/26529',
            entityType: 'company',
            enrichments: { 'Model name': 'claude-opus-4-7' },
            createdAt: '2026-04-26T00:00:00Z',
            projected: {},
          },
        ],
      },
    ];

    const result = joinLensResults(lensResults, {
      by: 'entity',
      keyEnrichment: 'Model name',
    });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].entity).toBe('claude-opus-4-7');
    expect(result.entities[0].lensCount).toBe(2);
    expect(result.entities[0].presentInLenses.sort()).toEqual(['github', 'twitter']);
  });

  it('skips items without the keyEnrichment value', () => {
    const lensResults = [
      {
        lensId: 'a',
        websetId: 'ws_1',
        totalItems: 2,
        shapedItems: [
          {
            id: '1',
            name: 'item 1',
            url: 'https://a.com/1',
            entityType: 'company',
            enrichments: { 'Model name': 'claude-opus-4-7' },
            createdAt: '2026-04-25T00:00:00Z',
            projected: {},
          },
          {
            id: '2',
            name: 'item 2',
            url: 'https://a.com/2',
            entityType: 'company',
            enrichments: { 'Model name': null },
            createdAt: '2026-04-25T00:00:00Z',
            projected: {},
          },
        ],
      },
      {
        lensId: 'b',
        websetId: 'ws_2',
        totalItems: 1,
        shapedItems: [
          {
            id: '3',
            name: 'item 3',
            url: 'https://b.com/3',
            entityType: 'company',
            enrichments: { 'Model name': 'claude-opus-4-7' },
            createdAt: '2026-04-25T00:00:00Z',
            projected: {},
          },
        ],
      },
    ];

    const result = joinLensResults(lensResults, {
      by: 'entity',
      keyEnrichment: 'Model name',
      minLensOverlap: 2,
    });
    // Item 2 has no Model name → skipped. Items 1 + 3 share key → 1 joined entity.
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].entity).toBe('claude-opus-4-7');
    expect(result.entities[0].lensCount).toBe(2);
  });

  it('matches alias variants via fuzzy when case-insensitive equality fails', () => {
    // Aliased pairs that DON'T collapse under case-insensitive equality —
    // exercises the diceCoefficient branch, not the `a === b` short-circuit.
    const lensResults = [
      {
        lensId: 'a',
        websetId: 'ws_1',
        totalItems: 1,
        shapedItems: [
          {
            id: '1',
            name: 'item 1',
            url: 'https://a.com/1',
            entityType: 'company',
            enrichments: { 'Model name': 'opus 4.7' },
            createdAt: '2026-04-25T00:00:00Z',
            projected: {},
          },
        ],
      },
      {
        lensId: 'b',
        websetId: 'ws_2',
        totalItems: 1,
        shapedItems: [
          {
            id: '2',
            name: 'item 2',
            url: 'https://b.com/2',
            entityType: 'company',
            enrichments: { 'Model name': 'Opus 4.7 model' },
            createdAt: '2026-04-25T00:00:00Z',
            projected: {},
          },
        ],
      },
    ];

    const fuzzy = joinLensResults(lensResults, {
      by: 'entity',
      keyEnrichment: 'Model name',
      entityMatch: { method: 'fuzzy', nameThreshold: 0.6 },
    });
    expect(fuzzy.entities).toHaveLength(1);
    expect(fuzzy.entities[0].lensCount).toBe(2);

    // Counter-check: with method:'exact' the same inputs must NOT match,
    // proving the assertion above is doing real work on the fuzzy branch.
    const exact = joinLensResults(lensResults, {
      by: 'entity',
      keyEnrichment: 'Model name',
      entityMatch: { method: 'exact' },
      minLensOverlap: 2,
    });
    expect(exact.entities).toHaveLength(0);
  });

  it('case-insensitive equality matches without engaging fuzzy', () => {
    // Pure case difference — handled by the `a === b` lowercase short-circuit
    // before fuzz is consulted. method:'exact' must still match here, since
    // case-insensitive equality is intentionally always-on for keyEnrichment.
    const lensResults = [
      {
        lensId: 'a',
        websetId: 'ws_1',
        totalItems: 1,
        shapedItems: [
          {
            id: '1',
            name: 'item 1',
            url: 'https://a.com/1',
            entityType: 'company',
            enrichments: { 'Model name': 'Claude Opus 4.7' },
            createdAt: '2026-04-25T00:00:00Z',
            projected: {},
          },
        ],
      },
      {
        lensId: 'b',
        websetId: 'ws_2',
        totalItems: 1,
        shapedItems: [
          {
            id: '2',
            name: 'item 2',
            url: 'https://b.com/2',
            entityType: 'company',
            enrichments: { 'Model name': 'claude opus 4.7' },
            createdAt: '2026-04-25T00:00:00Z',
            projected: {},
          },
        ],
      },
    ];

    const result = joinLensResults(lensResults, {
      by: 'entity',
      keyEnrichment: 'Model name',
      entityMatch: { method: 'exact' },
    });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].lensCount).toBe(2);
  });
});

describe('joinLensResults — cooccurrence/temporal', () => {
  it('cooccurrence: lists lenses with shaped items', () => {
    const lensResults = [
      { lensId: 'a', websetId: 'ws_1', totalItems: 5, shapedItems: [
        { id: '1', name: 'X', url: '', entityType: '', enrichments: {}, createdAt: '2026-01-15T00:00:00Z', projected: {} },
      ] },
      { lensId: 'b', websetId: 'ws_2', totalItems: 5, shapedItems: [] },
      { lensId: 'c', websetId: 'ws_3', totalItems: 5, shapedItems: [
        { id: '2', name: 'Y', url: '', entityType: '', enrichments: {}, createdAt: '2026-01-15T00:00:00Z', projected: {} },
      ] },
    ];

    const result = joinLensResults(lensResults, { by: 'cooccurrence' });
    expect(result.entities).toEqual([]);
    expect(result.lensesWithEvidence).toContain('a');
    expect(result.lensesWithEvidence).toContain('c');
    expect(result.lensesWithEvidence).not.toContain('b');
  });

  it('temporal: joins lenses with overlapping timestamps', () => {
    const lensResults = [
      { lensId: 'a', websetId: 'ws_1', totalItems: 1, shapedItems: [
        { id: '1', name: 'X', url: '', entityType: '', enrichments: {}, createdAt: '2026-01-15T00:00:00Z', projected: {} },
      ] },
      { lensId: 'b', websetId: 'ws_2', totalItems: 1, shapedItems: [
        { id: '2', name: 'Y', url: '', entityType: '', enrichments: {}, createdAt: '2026-01-16T00:00:00Z', projected: {} },
      ] },
      { lensId: 'c', websetId: 'ws_3', totalItems: 1, shapedItems: [
        { id: '3', name: 'Z', url: '', entityType: '', enrichments: {}, createdAt: '2026-06-01T00:00:00Z', projected: {} },
      ] },
    ];

    const result = joinLensResults(lensResults, { by: 'temporal', temporal: { days: 7 } });
    expect(result.lensesWithEvidence).toContain('a');
    expect(result.lensesWithEvidence).toContain('b');
    // c is 5+ months away, should not be included
    expect(result.lensesWithEvidence).not.toContain('c');
  });

  it('cooccurrence with temporal window filters by time', () => {
    const lensResults = [
      { lensId: 'a', websetId: 'ws_1', totalItems: 1, shapedItems: [
        { id: '1', name: 'X', url: '', entityType: '', enrichments: {}, createdAt: '2026-01-15T00:00:00Z', projected: {} },
      ] },
      { lensId: 'b', websetId: 'ws_2', totalItems: 1, shapedItems: [
        { id: '2', name: 'Y', url: '', entityType: '', enrichments: {}, createdAt: '2026-12-01T00:00:00Z', projected: {} },
      ] },
    ];

    const result = joinLensResults(lensResults, {
      by: 'cooccurrence',
      temporal: { days: 7 },
    });
    // Only lens 'a' is within 7 days of the earliest timestamp (itself)
    expect(result.lensesWithEvidence).toContain('a');
    expect(result.lensesWithEvidence).not.toContain('b');
  });

  it('empty lenses produce empty result', () => {
    const result = joinLensResults([], { by: 'cooccurrence' });
    expect(result.entities).toEqual([]);
    expect(result.lensesWithEvidence).toEqual([]);
  });
});

// --- Signal evaluator tests ---

describe('evaluateSignal', () => {
  const allLensIds = ['hiring', 'funding', 'patents'];

  describe('with entities', () => {
    const joinResult: JoinResult = {
      type: 'entity',
      entities: [
        { entity: 'Acme', url: 'https://acme.com', presentInLenses: ['hiring', 'funding'], lensCount: 2, shapes: {} },
        { entity: 'Beta', url: 'https://beta.com', presentInLenses: ['hiring', 'funding', 'patents'], lensCount: 3, shapes: {} },
      ],
      lensesWithEvidence: ['hiring', 'funding', 'patents'],
    };

    it('all: finds entities in all lenses', () => {
      const result = evaluateSignal(joinResult, { requires: { type: 'all' } }, allLensIds);
      expect(result.fired).toBe(true);
      expect(result.entities).toContain('Beta');
      expect(result.entities).not.toContain('Acme'); // only in 2 of 3
    });

    it('any: fires if any entity exists', () => {
      const result = evaluateSignal(joinResult, { requires: { type: 'any' } }, allLensIds);
      expect(result.fired).toBe(true);
      expect(result.entities).toHaveLength(2);
    });

    it('threshold: fires when entities meet minimum', () => {
      const result = evaluateSignal(joinResult, { requires: { type: 'threshold', min: 3 } }, allLensIds);
      expect(result.fired).toBe(true);
      expect(result.entities).toEqual(['Beta']);
    });

    it('combination: fires when any combo is satisfied', () => {
      const result = evaluateSignal(
        joinResult,
        { requires: { type: 'combination', sufficient: [['hiring', 'patents']] } },
        allLensIds,
      );
      expect(result.fired).toBe(true);
      expect(result.matchedCombination).toEqual(['hiring', 'patents']);
      expect(result.entities).toContain('Beta');
    });
  });

  describe('with evidence (cooccurrence)', () => {
    const joinResult: JoinResult = {
      type: 'cooccurrence',
      entities: [],
      lensesWithEvidence: ['hiring', 'funding'],
    };

    it('all: requires all lenses to have evidence', () => {
      const result = evaluateSignal(joinResult, { requires: { type: 'all' } }, allLensIds);
      expect(result.fired).toBe(false); // patents missing
    });

    it('any: fires with any evidence', () => {
      const result = evaluateSignal(joinResult, { requires: { type: 'any' } }, allLensIds);
      expect(result.fired).toBe(true);
    });

    it('threshold: checks minimum lenses with evidence', () => {
      const result = evaluateSignal(joinResult, { requires: { type: 'threshold', min: 2 } }, allLensIds);
      expect(result.fired).toBe(true);

      const result2 = evaluateSignal(joinResult, { requires: { type: 'threshold', min: 3 } }, allLensIds);
      expect(result2.fired).toBe(false);
    });

    it('combination: checks if combo is covered by evidence', () => {
      const result = evaluateSignal(
        joinResult,
        { requires: { type: 'combination', sufficient: [['hiring', 'funding']] } },
        allLensIds,
      );
      expect(result.fired).toBe(true);
      expect(result.matchedCombination).toEqual(['hiring', 'funding']);
    });
  });

  it('throws on invalid lens ID in combination', () => {
    const joinResult: JoinResult = { type: 'entity', entities: [], lensesWithEvidence: [] };
    expect(() =>
      evaluateSignal(
        joinResult,
        { requires: { type: 'combination', sufficient: [['nonexistent']] } },
        allLensIds,
      ),
    ).toThrow('Unknown lens ID "nonexistent"');
  });
});

// --- Delta computer tests ---

describe('computeDelta', () => {
  const baseLens = {
    websetId: 'ws_1',
    totalItems: 10,
    shapedCount: 3,
    shapes: [{ name: 'Acme', url: 'https://acme.com', enrichments: {} }],
  };

  const baseSignal: SignalResult = {
    fired: false,
    satisfiedBy: [],
    rule: 'all',
    entities: [],
  };

  const baseJoin: JoinResult = {
    type: 'entity',
    entities: [],
    lensesWithEvidence: [],
  };

  it('detects new shaped items', () => {
    const previous: any = {
      evaluatedAt: '2026-01-15T00:00:00Z',
      lenses: { hiring: { ...baseLens, shapedCount: 2 } },
      join: baseJoin,
      signal: baseSignal,
    };
    const current: any = {
      evaluatedAt: '2026-01-16T00:00:00Z',
      lenses: { hiring: { ...baseLens, shapedCount: 5 } },
      join: baseJoin,
      signal: baseSignal,
    };

    const delta = computeDelta(current, previous);
    expect(delta.newShapedItems.hiring).toBe(3);
  });

  it('detects new joins', () => {
    const previous: any = {
      evaluatedAt: '2026-01-15T00:00:00Z',
      lenses: {},
      join: { type: 'entity', entities: [{ entity: 'Acme', url: 'https://acme.com', presentInLenses: ['a'], lensCount: 1, shapes: {} }], lensesWithEvidence: [] },
      signal: baseSignal,
    };
    const current: any = {
      evaluatedAt: '2026-01-16T00:00:00Z',
      lenses: {},
      join: {
        type: 'entity',
        entities: [
          { entity: 'Acme', url: 'https://acme.com', presentInLenses: ['a'], lensCount: 1, shapes: {} },
          { entity: 'Beta', url: 'https://beta.com', presentInLenses: ['a', 'b'], lensCount: 2, shapes: {} },
        ],
        lensesWithEvidence: [],
      },
      signal: baseSignal,
    };

    const delta = computeDelta(current, previous);
    expect(delta.newJoins).toEqual(['https://beta.com']);
    expect(delta.lostJoins).toEqual([]);
  });

  it('detects lost joins', () => {
    const previous: any = {
      evaluatedAt: '2026-01-15T00:00:00Z',
      lenses: {},
      join: {
        type: 'entity',
        entities: [
          { entity: 'Acme', url: 'https://acme.com', presentInLenses: ['a'], lensCount: 1, shapes: {} },
          { entity: 'Gone', url: 'https://gone.com', presentInLenses: ['a'], lensCount: 1, shapes: {} },
        ],
        lensesWithEvidence: [],
      },
      signal: baseSignal,
    };
    const current: any = {
      evaluatedAt: '2026-01-16T00:00:00Z',
      lenses: {},
      join: { type: 'entity', entities: [{ entity: 'Acme', url: 'https://acme.com', presentInLenses: ['a'], lensCount: 1, shapes: {} }], lensesWithEvidence: [] },
      signal: baseSignal,
    };

    const delta = computeDelta(current, previous);
    expect(delta.lostJoins).toEqual(['https://gone.com']);
  });

  it('detects signal transition false→true', () => {
    const previous: any = {
      evaluatedAt: '2026-01-15T00:00:00Z',
      lenses: {},
      join: baseJoin,
      signal: { fired: false, satisfiedBy: [], rule: 'all', entities: [] },
    };
    const current: any = {
      evaluatedAt: '2026-01-16T00:00:00Z',
      lenses: {},
      join: baseJoin,
      signal: { fired: true, satisfiedBy: ['a', 'b'], rule: 'all', entities: ['Acme'] },
    };

    const delta = computeDelta(current, previous);
    expect(delta.signalTransition.was).toBe(false);
    expect(delta.signalTransition.now).toBe(true);
    expect(delta.signalTransition.changed).toBe(true);
    expect(delta.signalTransition.newEntities).toEqual(['Acme']);
  });

  it('clamps shaped item count difference to zero', () => {
    const previous: any = {
      evaluatedAt: '2026-01-15T00:00:00Z',
      lenses: { hiring: { ...baseLens, shapedCount: 10 } },
      join: baseJoin,
      signal: baseSignal,
    };
    const current: any = {
      evaluatedAt: '2026-01-16T00:00:00Z',
      lenses: { hiring: { ...baseLens, shapedCount: 5 } },
      join: baseJoin,
      signal: baseSignal,
    };

    const delta = computeDelta(current, previous);
    expect(delta.newShapedItems.hiring).toBe(0);
  });

  it('formats time duration correctly', () => {
    const previous: any = {
      evaluatedAt: '2026-01-15T00:00:00Z',
      lenses: {},
      join: baseJoin,
      signal: baseSignal,
    };
    const current: any = {
      evaluatedAt: '2026-01-22T02:30:00Z', // 7 days, 2 hours, 30 minutes later
      lenses: {},
      join: baseJoin,
      signal: baseSignal,
    };

    const delta = computeDelta(current, previous);
    expect(delta.timeSinceLastEval).toBe('7d 2h 30m');
  });
});

// --- Snapshot builder tests ---

describe('buildSnapshot', () => {
  it('assembles snapshot structure', () => {
    const lensResults = [
      {
        lensId: 'hiring',
        websetId: 'ws_1',
        totalItems: 10,
        shapedItems: [
          { id: '1', name: 'Acme', url: 'https://acme.com', entityType: 'company', enrichments: { roles: '15' }, createdAt: '2026-01-15T00:00:00Z', projected: {} },
        ],
      },
    ];
    const joinResult: JoinResult = {
      type: 'entity',
      entities: [{ entity: 'Acme', url: 'https://acme.com', presentInLenses: ['hiring'], lensCount: 1, shapes: {} }],
      lensesWithEvidence: ['hiring'],
    };
    const signalResult: SignalResult = { fired: true, satisfiedBy: ['hiring'], rule: 'any', entities: ['Acme'] };

    const snapshot = buildSnapshot(lensResults, joinResult, signalResult, { hiring: 'ws_1' });

    expect(snapshot.evaluatedAt).toBeDefined();
    expect(snapshot.lenses.hiring.websetId).toBe('ws_1');
    expect(snapshot.lenses.hiring.totalItems).toBe(10);
    expect(snapshot.lenses.hiring.shapedCount).toBe(1);
    expect(snapshot.lenses.hiring.shapes[0].name).toBe('Acme');
    expect(snapshot.join).toBe(joinResult);
    expect(snapshot.signal).toBe(signalResult);
  });
});

// --- Full workflow tests ---

describe('semantic.cron workflow', () => {
  const workflow = workflowRegistry.get('semantic.cron')!;
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it('is registered', () => {
    expect(workflow).toBeDefined();
  });

  it('validates config.lenses is required', async () => {
    const task = store.create('semantic.cron', { config: {} });
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      'config.lenses is required',
    );
    store.dispose();
  });

  it('validates config.shapes is required', async () => {
    const task = store.create('semantic.cron', {
      config: { lenses: [{ id: 'a', source: { query: 'x' } }] },
    });
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      'config.shapes is required',
    );
    store.dispose();
  });

  it('validates shape lens ID references', async () => {
    const task = store.create('semantic.cron', {
      config: {
        lenses: [{ id: 'a', source: { query: 'x' } }],
        shapes: [{ lensId: 'nonexistent', conditions: [], logic: 'all' }],
        join: { by: 'entity' },
        signal: { requires: { type: 'all' } },
      },
    });
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      'Shape references unknown lens "nonexistent"',
    );
    store.dispose();
  });

  it('runs initial workflow: creates websets, shapes, joins, signals', async () => {
    const ws1 = mockWebset('ws_hiring', [
      { id: 'enr_1', description: 'Open roles count', format: 'number' },
    ]);
    const ws2 = mockWebset('ws_funding', [
      { id: 'enr_2', description: 'Latest funding', format: 'text' },
    ]);

    const items1 = [
      mockRawItem({
        name: 'Acme', url: 'https://acme.com',
        enrichments: [{ enrichmentId: 'enr_1', format: 'number', result: ['25'], status: 'completed' }],
      }),
      mockRawItem({
        name: 'Beta', url: 'https://beta.com',
        enrichments: [{ enrichmentId: 'enr_1', format: 'number', result: ['3'], status: 'completed' }],
      }),
    ];
    const items2 = [
      mockRawItem({
        name: 'Acme', url: 'https://acme.com',
        enrichments: [{ enrichmentId: 'enr_2', format: 'text', result: ['Series B'], status: 'completed' }],
      }),
    ];

    const mockExa = createMockExa({
      hiring: { webset: ws1, items: items1 },
      funding: { webset: ws2, items: items2 },
    });

    const task = store.create('semantic.cron', {
      config: {
        lenses: [
          { id: 'hiring', source: { query: 'hiring engineers' } },
          { id: 'funding', source: { query: 'recent funding' } },
        ],
        shapes: [
          { lensId: 'hiring', conditions: [{ enrichment: 'Open roles count', operator: 'gte', value: 10 }], logic: 'all' },
          { lensId: 'funding', conditions: [{ enrichment: 'Latest funding', operator: 'exists' }], logic: 'all' },
        ],
        join: { by: 'entity' },
        signal: { requires: { type: 'any' } },
      },
    });

    const result = (await workflow(task.id, task.args, mockExa, store)) as any;

    expect(result).toBeDefined();
    expect(result.websetIds.hiring).toBe('ws_hiring');
    expect(result.websetIds.funding).toBe('ws_funding');
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.signal.fired).toBe(true);
    // Acme passes hiring shape (25 >= 10) and funding shape (exists) → joined
    // Beta fails hiring shape (3 < 10) → not joined
    expect(result.snapshot.lenses.hiring.shapedCount).toBe(1); // only Acme
    expect(result.snapshot.lenses.funding.shapedCount).toBe(1);
    expect(result.snapshot.join.entities).toHaveLength(1);
    expect(result.snapshot.join.entities[0].entity).toBe('Acme');
    expect(result._summary).toContain('2 lenses');

    expect(mockExa.websets.create).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it('runs re-eval flow with delta', async () => {
    const ws1 = mockWebset('ws_hiring', [
      { id: 'enr_1', description: 'Open roles count', format: 'number' },
    ]);

    const items1 = [
      mockRawItem({
        name: 'Acme', url: 'https://acme.com',
        enrichments: [{ enrichmentId: 'enr_1', format: 'number', result: ['25'], status: 'completed' }],
      }),
    ];

    const mockExa = createMockExa({ hiring: { webset: ws1, items: items1 } });

    const previousSnapshot = {
      evaluatedAt: '2026-01-15T00:00:00Z',
      lenses: {
        hiring: { websetId: 'ws_hiring', totalItems: 5, shapedCount: 0, shapes: [] },
      },
      join: { type: 'entity', entities: [] as any[], lensesWithEvidence: [] },
      signal: { fired: false, satisfiedBy: [], rule: 'any', entities: [] },
    };

    const task = store.create('semantic.cron', {
      config: {
        lenses: [{ id: 'hiring', source: { query: 'hiring' } }],
        shapes: [
          { lensId: 'hiring', conditions: [{ enrichment: 'Open roles count', operator: 'gte', value: 10 }], logic: 'all' },
        ],
        join: { by: 'cooccurrence' },
        signal: { requires: { type: 'any' } },
      },
      existingWebsets: { hiring: 'ws_hiring' },
      previousSnapshot,
    });

    const result = (await workflow(task.id, task.args, mockExa, store)) as any;

    expect(result.delta).toBeDefined();
    expect(result.delta.newShapedItems.hiring).toBe(1);
    expect(result.delta.signalTransition.was).toBe(false);
    expect(result.delta.signalTransition.now).toBe(true);
    expect(result.delta.signalTransition.changed).toBe(true);
    // Should NOT create new websets
    expect(mockExa.websets.create).not.toHaveBeenCalled();
    store.dispose();
  });

  it('creates monitors when config.monitor is set', async () => {
    const ws1 = mockWebset('ws_1', []);
    const mockExa = createMockExa({ a: { webset: ws1, items: [] } });

    const task = store.create('semantic.cron', {
      config: {
        lenses: [{ id: 'a', source: { query: 'test' } }],
        shapes: [{ lensId: 'a', conditions: [{ enrichment: 'X', operator: 'exists' }], logic: 'all' }],
        join: { by: 'cooccurrence' },
        signal: { requires: { type: 'any' } },
        monitor: { cron: '0 9 * * 1', timezone: 'America/New_York' },
      },
    });

    const result = (await workflow(task.id, task.args, mockExa, store)) as any;
    expect(result).toBeDefined();
    expect(mockExa.websets.monitors.create).toHaveBeenCalledWith('ws_1', {
      schedule: { cron: '0 9 * * 1', timezone: 'America/New_York' },
    });
    store.dispose();
  });

  it('returns null when cancelled', async () => {
    const mockExa = {
      websets: {
        create: vi.fn().mockImplementation(async () => {
          store.cancel(task.id);
          return { id: 'ws_c', status: 'idle', enrichments: [] };
        }),
        get: vi.fn(),
        cancel: vi.fn(),
        items: { listAll: vi.fn() },
        monitors: { create: vi.fn() },
      },
    } as any;

    const task = store.create('semantic.cron', {
      config: {
        lenses: [{ id: 'a', source: { query: 'test' } }],
        shapes: [{ lensId: 'a', conditions: [{ enrichment: 'X', operator: 'exists' }], logic: 'all' }],
        join: { by: 'cooccurrence' },
        signal: { requires: { type: 'any' } },
      },
    });

    const result = await workflow(task.id, task.args, mockExa, store);
    expect(result).toBeNull();
    store.dispose();
  });

  it('handles empty results gracefully', async () => {
    const ws1 = mockWebset('ws_empty', [{ id: 'enr_1', description: 'X', format: 'text' }]);
    const mockExa = createMockExa({ a: { webset: ws1, items: [] } });

    const task = store.create('semantic.cron', {
      config: {
        lenses: [{ id: 'a', source: { query: 'nothing' } }],
        shapes: [{ lensId: 'a', conditions: [{ enrichment: 'X', operator: 'exists' }], logic: 'all' }],
        join: { by: 'cooccurrence' },
        signal: { requires: { type: 'any' } },
      },
    });

    const result = (await workflow(task.id, task.args, mockExa, store)) as any;
    expect(result.snapshot.signal.fired).toBe(false);
    expect(result.snapshot.lenses.a.shapedCount).toBe(0);
    store.dispose();
  });

  it('handles all items failing shape evaluation', async () => {
    const ws1 = mockWebset('ws_1', [{ id: 'enr_1', description: 'Count', format: 'number' }]);
    const items = [
      mockRawItem({
        name: 'Low', url: 'https://low.com',
        enrichments: [{ enrichmentId: 'enr_1', format: 'number', result: ['2'], status: 'completed' }],
      }),
    ];
    const mockExa = createMockExa({ a: { webset: ws1, items } });

    const task = store.create('semantic.cron', {
      config: {
        lenses: [{ id: 'a', source: { query: 'test' } }],
        shapes: [{ lensId: 'a', conditions: [{ enrichment: 'Count', operator: 'gte', value: 100 }], logic: 'all' }],
        join: { by: 'cooccurrence' },
        signal: { requires: { type: 'any' } },
      },
    });

    const result = (await workflow(task.id, task.args, mockExa, store)) as any;
    expect(result.snapshot.lenses.a.shapedCount).toBe(0);
    expect(result.snapshot.signal.fired).toBe(false);
    store.dispose();
  });
});

describe('semantic.cron — validate-time degenerate-config rejection', () => {
  const workflow = workflowRegistry.get('semantic.cron')!;
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  const baseConfig = (overrides: any = {}) => ({
    name: 'test',
    lenses: [{ id: 'a', source: { query: 'x' } }],
    shapes: [{ lensId: 'a', conditions: [{ enrichment: 'X', operator: 'exists' }], logic: 'all' }],
    join: { by: 'cooccurrence' },
    signal: { requires: { type: 'any' } },
    ...overrides,
  });

  it('rejects 1-lens config with signal type "all"', async () => {
    const task = store.create('semantic.cron', {
      config: baseConfig({ signal: { requires: { type: 'all' } } }),
    });
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      /Signal type "all" requires at least 2 lenses/,
    );
    store.dispose();
  });

  it('rejects 1-lens config with signal type "threshold"', async () => {
    const task = store.create('semantic.cron', {
      config: baseConfig({ signal: { requires: { type: 'threshold', min: 2 } } }),
    });
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      /Signal type "threshold" requires at least 2 lenses/,
    );
    store.dispose();
  });

  it('rejects 1-lens config with signal type "combination"', async () => {
    const task = store.create('semantic.cron', {
      config: baseConfig({
        signal: { requires: { type: 'combination', sufficient: [['a']] } },
      }),
    });
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      /Signal type "combination" requires at least 2 lenses/,
    );
    store.dispose();
  });

  it('allows 1-lens config with signal type "any"', async () => {
    const ws1 = mockWebset('ws_1', [{ id: 'enr_1', description: 'X', format: 'text' }]);
    const mockExa = createMockExa({ a: { webset: ws1, items: [] } });
    const task = store.create('semantic.cron', {
      config: baseConfig({ signal: { requires: { type: 'any' } } }),
    });
    await expect(workflow(task.id, task.args, mockExa, store)).resolves.toBeDefined();
    store.dispose();
  });

  it('rejects minLensOverlap > lensCount on entity join', async () => {
    const task = store.create('semantic.cron', {
      config: baseConfig({
        lenses: [
          { id: 'a', source: { query: 'x' } },
          { id: 'b', source: { query: 'y' } },
        ],
        shapes: [
          { lensId: 'a', conditions: [], logic: 'all' },
          { lensId: 'b', conditions: [], logic: 'all' },
        ],
        join: { by: 'entity', minLensOverlap: 5 },
        signal: { requires: { type: 'any' } },
      }),
    });
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      /minLensOverlap \(5\) exceeds lens count \(2\)/,
    );
    store.dispose();
  });

  it('rejects minLensOverlap=1 with 2+ lenses on entity join', async () => {
    const task = store.create('semantic.cron', {
      config: baseConfig({
        lenses: [
          { id: 'a', source: { query: 'x' } },
          { id: 'b', source: { query: 'y' } },
        ],
        shapes: [
          { lensId: 'a', conditions: [], logic: 'all' },
          { lensId: 'b', conditions: [], logic: 'all' },
        ],
        join: { by: 'entity', minLensOverlap: 1 },
        signal: { requires: { type: 'any' } },
      }),
    });
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      /minLensOverlap must be >= 2 when there are multiple lenses/,
    );
    store.dispose();
  });

  it('does not enforce minLensOverlap on cooccurrence join', async () => {
    // cooccurrence/temporal don't produce entities, so the minOverlap rule
    // shouldn't fire. The test passes if validation does not throw — the
    // workflow may then error at runtime due to no mock exa, but that's fine.
    const task = store.create('semantic.cron', {
      config: baseConfig({
        lenses: [
          { id: 'a', source: { query: 'x' } },
          { id: 'b', source: { query: 'y' } },
        ],
        shapes: [
          { lensId: 'a', conditions: [], logic: 'all' },
          { lensId: 'b', conditions: [], logic: 'all' },
        ],
        join: { by: 'cooccurrence', minLensOverlap: 1 },
        signal: { requires: { type: 'any' } },
      }),
    });
    // Will fail at exa.websets.create (no mock), not at validate
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.not.toThrow(
      /minLensOverlap/,
    );
    store.dispose();
  });

  it('rejects threshold signal with min > lensCount', async () => {
    const task = store.create('semantic.cron', {
      config: baseConfig({
        lenses: [
          { id: 'a', source: { query: 'x' } },
          { id: 'b', source: { query: 'y' } },
        ],
        shapes: [
          { lensId: 'a', conditions: [], logic: 'all' },
          { lensId: 'b', conditions: [], logic: 'all' },
        ],
        signal: { requires: { type: 'threshold', min: 5 } },
      }),
    });
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      /min \(5\) exceeds lens count \(2\)/,
    );
    store.dispose();
  });

  it('rejects threshold signal with min < 2', async () => {
    const task = store.create('semantic.cron', {
      config: baseConfig({
        lenses: [
          { id: 'a', source: { query: 'x' } },
          { id: 'b', source: { query: 'y' } },
        ],
        shapes: [
          { lensId: 'a', conditions: [], logic: 'all' },
          { lensId: 'b', conditions: [], logic: 'all' },
        ],
        signal: { requires: { type: 'threshold', min: 1 } },
      }),
    });
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      /min must be >= 2 for threshold signals/,
    );
    store.dispose();
  });

  it('rejects combination with single-lens combo', async () => {
    const task = store.create('semantic.cron', {
      config: baseConfig({
        lenses: [
          { id: 'a', source: { query: 'x' } },
          { id: 'b', source: { query: 'y' } },
        ],
        shapes: [
          { lensId: 'a', conditions: [], logic: 'all' },
          { lensId: 'b', conditions: [], logic: 'all' },
        ],
        signal: { requires: { type: 'combination', sufficient: [['a']] } },
      }),
    });
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      /Each combination .* must have at least 2 lens IDs/,
    );
    store.dispose();
  });

  it('rejects combination referencing unknown lens id', async () => {
    const task = store.create('semantic.cron', {
      config: baseConfig({
        lenses: [
          { id: 'a', source: { query: 'x' } },
          { id: 'b', source: { query: 'y' } },
        ],
        shapes: [
          { lensId: 'a', conditions: [], logic: 'all' },
          { lensId: 'b', conditions: [], logic: 'all' },
        ],
        signal: { requires: { type: 'combination', sufficient: [['a', 'nonexistent']] } },
      }),
    });
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      /Unknown lens ID "nonexistent"/,
    );
    store.dispose();
  });

  it('rejects combination with empty sufficient array', async () => {
    const task = store.create('semantic.cron', {
      config: baseConfig({
        lenses: [
          { id: 'a', source: { query: 'x' } },
          { id: 'b', source: { query: 'y' } },
        ],
        shapes: [
          { lensId: 'a', conditions: [], logic: 'all' },
          { lensId: 'b', conditions: [], logic: 'all' },
        ],
        signal: { requires: { type: 'combination', sufficient: [] } },
      }),
    });
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      /sufficient must be a non-empty array/,
    );
    store.dispose();
  });

  it('warns but does not throw when config.name is missing', async () => {
    const ws1 = mockWebset('ws_1', [{ id: 'enr_1', description: 'X', format: 'text' }]);
    const mockExa = createMockExa({ a: { webset: ws1, items: [] } });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const task = store.create('semantic.cron', {
      config: {
        // name omitted on purpose
        lenses: [{ id: 'a', source: { query: 'x' } }],
        shapes: [{ lensId: 'a', conditions: [], logic: 'all' }],
        join: { by: 'cooccurrence' },
        signal: { requires: { type: 'any' } },
      },
    });
    await expect(workflow(task.id, task.args, mockExa, store)).resolves.toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/config\.name is unset/),
    );
    warnSpy.mockRestore();
    store.dispose();
  });
});
