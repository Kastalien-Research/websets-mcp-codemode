import { describe, it, expect } from 'vitest';
import {
  projectItem,
  filterAndProjectItems,
  projectWebset,
  projectSearch,
  projectEnrichment,
  projectMonitor,
  projectMonitorRun,
  projectWebhook,
  projectWebhookAttempt,
  projectImport,
  projectEvent,
  projectResearch,
} from '../projections.js';

// --- Fixtures ---

function makeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'item-1',
    object: 'webset_item',
    websetId: 'ws-1',
    sourceId: 'src-1',
    source: 'search',
    createdAt: '2024-01-01T00:00:00Z',
    properties: {
      type: 'company',
      url: 'https://acme.com',
      description: 'A company that makes everything',
      company: {
        name: 'Acme Corp',
        domain: 'acme.com',
        industry: 'Manufacturing',
      },
      content: 'Very long content string that takes up lots of context window...',
    },
    evaluations: [
      {
        criterion: 'Is a technology company',
        satisfied: 'yes',
        reasoning: 'The company develops technology products...',
        references: ['https://acme.com/about'],
      },
      {
        criterion: 'Has over 100 employees',
        satisfied: 'no',
        reasoning: 'Could not determine employee count...',
        references: [],
      },
    ],
    enrichments: [
      {
        enrichmentId: 'enr-1',
        description: 'Annual revenue',
        format: 'number',
        status: 'completed',
        result: ['50000000'],
        reasoning: 'Based on public filings...',
        references: ['https://sec.gov/...'],
        object: 'webset_item_enrichment',
      },
    ],
    ...overrides,
  };
}

function makePersonItem(): Record<string, unknown> {
  return makeItem({
    properties: {
      type: 'person',
      url: 'https://linkedin.com/in/johndoe',
      description: 'Software engineer',
      person: { name: 'John Doe', title: 'Senior Engineer' },
    },
  });
}

function makeArticleItem(): Record<string, unknown> {
  return makeItem({
    properties: {
      type: 'article',
      url: 'https://news.com/article',
      description: 'A news article',
      article: { title: 'Breaking News: AI Advances', publishedDate: '2024-01-01' },
    },
  });
}

function makeResearchPaperItem(): Record<string, unknown> {
  return makeItem({
    properties: {
      type: 'researchPaper',
      url: 'https://arxiv.org/paper',
      description: 'Research paper on ML',
      researchPaper: { title: 'Attention Is All You Need', authors: ['Vaswani et al.'] },
    },
  });
}

function makeCustomItem(): Record<string, unknown> {
  return makeItem({
    properties: {
      type: 'custom',
      url: 'https://example.com/custom',
      description: 'A custom entity',
      custom: { title: 'Custom Entity', data: { key: 'value' } },
    },
  });
}

// --- Item projection tests ---

describe('projectItem', () => {
  it('extracts company name and strips noise', () => {
    const result = projectItem(makeItem());
    expect(result).toEqual({
      id: 'item-1',
      name: 'Acme Corp',
      url: 'https://acme.com',
      entityType: 'company',
      description: 'A company that makes everything',
      evaluations: [
        { criterion: 'Is a technology company', satisfied: 'yes' },
        { criterion: 'Has over 100 employees', satisfied: 'no' },
      ],
      enrichments: [
        { description: 'Annual revenue', format: 'number', result: ['50000000'] },
      ],
    });
  });

  it('strips content, reasoning, references, enrichmentId, status, object', () => {
    const result = projectItem(makeItem());
    const text = JSON.stringify(result);
    expect(text).not.toContain('Very long content');
    expect(text).not.toContain('reasoning');
    expect(text).not.toContain('references');
    expect(text).not.toContain('enrichmentId');
    expect(text).not.toContain('websetId');
    expect(text).not.toContain('sourceId');
    expect(text).not.toContain('createdAt');
    expect(text).not.toContain('"object"');
  });

  it('extracts person name', () => {
    const result = projectItem(makePersonItem());
    expect(result.name).toBe('John Doe');
    expect(result.entityType).toBe('person');
  });

  it('extracts article title', () => {
    const result = projectItem(makeArticleItem());
    expect(result.name).toBe('Breaking News: AI Advances');
    expect(result.entityType).toBe('article');
  });

  it('extracts research paper title', () => {
    const result = projectItem(makeResearchPaperItem());
    expect(result.name).toBe('Attention Is All You Need');
    expect(result.entityType).toBe('researchPaper');
  });

  it('extracts custom entity title', () => {
    const result = projectItem(makeCustomItem());
    expect(result.name).toBe('Custom Entity');
    expect(result.entityType).toBe('custom');
  });

  it('falls back to description when no entity name', () => {
    const item = makeItem({
      properties: { type: 'unknown', url: 'https://x.com', description: 'Fallback desc' },
    });
    const result = projectItem(item);
    expect(result.name).toBe('Fallback desc');
  });

  it('handles missing properties gracefully', () => {
    const result = projectItem({ id: 'bare' });
    expect(result.name).toBe('unknown');
    expect(result.url).toBe('');
    expect(result.entityType).toBe('unknown');
  });

  it('handles missing evaluations and enrichments', () => {
    const item = makeItem();
    delete item.evaluations;
    delete item.enrichments;
    const result = projectItem(item);
    expect(result.evaluations).toBeNull();
    expect(result.enrichments).toBeNull();
  });

  it('projected item is significantly smaller than raw', () => {
    const raw = JSON.stringify(makeItem());
    const projected = JSON.stringify(projectItem(makeItem()));
    expect(projected.length).toBeLessThan(raw.length * 0.7);
  });
});

// --- filterAndProjectItems tests ---

describe('filterAndProjectItems', () => {
  it('includes items with at least one satisfied evaluation', () => {
    const items = [makeItem()];
    const result = filterAndProjectItems(items);
    expect(result.included).toBe(1);
    expect(result.excluded).toBe(0);
    expect(result.total).toBe(1);
  });

  it('excludes items where no evaluation is satisfied', () => {
    const item = makeItem({
      evaluations: [
        { criterion: 'Is a tech company', satisfied: 'no', reasoning: '...' },
        { criterion: 'Has funding', satisfied: 'no', reasoning: '...' },
      ],
    });
    const result = filterAndProjectItems([item]);
    expect(result.included).toBe(0);
    expect(result.excluded).toBe(1);
  });

  it('includes items with no evaluations (no criteria = pass)', () => {
    const item = makeItem({ evaluations: [] });
    const result = filterAndProjectItems([item]);
    expect(result.included).toBe(1);
  });

  it('includes items with undefined evaluations', () => {
    const item = makeItem();
    delete item.evaluations;
    const result = filterAndProjectItems([item]);
    expect(result.included).toBe(1);
  });

  it('filters mixed items correctly', () => {
    const passing = makeItem();
    const failing = makeItem({
      id: 'item-2',
      evaluations: [{ criterion: 'test', satisfied: 'no' }],
    });
    const noEvals = makeItem({ id: 'item-3', evaluations: undefined });
    const result = filterAndProjectItems([passing, failing, noEvals]);
    expect(result.total).toBe(3);
    expect(result.included).toBe(2);
    expect(result.excluded).toBe(1);
    expect(result.data).toHaveLength(2);
  });

  it('projects items in the output', () => {
    const result = filterAndProjectItems([makeItem()]);
    const item = result.data[0] as Record<string, unknown>;
    expect(item.name).toBe('Acme Corp');
    expect(item).not.toHaveProperty('properties');
    expect(item).not.toHaveProperty('websetId');
  });

  it('handles empty array', () => {
    const result = filterAndProjectItems([]);
    expect(result).toEqual({ data: [], total: 0, included: 0, excluded: 0 });
  });
});

// --- Webset projection tests ---

describe('projectWebset', () => {
  it('projects webset with all sub-resources', () => {
    const webset = {
      id: 'ws-1',
      object: 'webset',
      status: 'idle',
      title: 'My Webset',
      metadata: { key: 'val' },
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      searches: [{
        id: 's-1',
        status: 'completed',
        query: 'AI startups',
        entity: { type: 'company' },
        criteria: [{ description: 'Has funding' }],
        progress: { found: 10, analyzed: 100, completion: 100, timeLeft: 0 },
        createdAt: '2024-01-01T00:00:00Z',
      }],
      enrichments: [{
        id: 'e-1',
        status: 'completed',
        description: 'Revenue',
        format: 'number',
        options: null,
        createdAt: '2024-01-01T00:00:00Z',
      }],
      monitors: [{
        id: 'm-1',
        status: 'active',
        nextRunAt: '2024-02-01T00:00:00Z',
        cadence: { cron: '0 0 * * *' },
      }],
      imports: [{
        id: 'i-1',
        status: 'completed',
        count: 50,
        title: 'CSV Import',
      }],
    };

    const result = projectWebset(webset);
    expect(result).toEqual({
      id: 'ws-1',
      status: 'idle',
      title: 'My Webset',
      entityType: 'company',
      metadata: { key: 'val' },
      searches: [{
        id: 's-1',
        status: 'completed',
        query: 'AI startups',
        progress: { found: 10, completion: 100, timeLeft: 0 },
      }],
      enrichments: [{
        id: 'e-1',
        status: 'completed',
        description: 'Revenue',
        format: 'number',
      }],
      monitors: [{
        id: 'm-1',
        status: 'active',
        nextRunAt: '2024-02-01T00:00:00Z',
      }],
      imports: [{
        id: 'i-1',
        status: 'completed',
        count: 50,
      }],
    });
  });

  it('strips timestamps, entity config, criteria from searches', () => {
    const result = projectWebset({
      id: 'ws-1',
      status: 'idle',
      createdAt: '2024-01-01',
      searches: [{
        id: 's-1', status: 'completed', query: 'test',
        entity: { type: 'company' }, criteria: [{ description: 'x' }],
        progress: { found: 5, completion: 50, timeLeft: 30 },
      }],
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('"createdAt"');
    expect(text).not.toContain('"entity"');
    expect(text).not.toContain('"criteria"');
  });

  it('promotes entityType from first search', () => {
    const result = projectWebset({
      id: 'ws-1', status: 'idle',
      searches: [
        { id: 's-1', status: 'completed', query: 'q1', entity: { type: 'person' }, progress: null },
        { id: 's-2', status: 'completed', query: 'q2', entity: { type: 'company' }, progress: null },
      ],
    });
    expect(result.entityType).toBe('person');
  });

  it('entityType is null when no searches', () => {
    const result = projectWebset({ id: 'ws-1', status: 'idle' });
    expect(result.entityType).toBeNull();
  });

  it('handles missing sub-resources', () => {
    const result = projectWebset({ id: 'ws-1', status: 'idle' });
    expect(result.searches).toBeNull();
    expect(result.enrichments).toBeNull();
    expect(result.monitors).toBeNull();
    expect(result.imports).toBeNull();
  });
});

// --- Search projection tests ---

describe('projectSearch', () => {
  it('projects search with progress and criteria', () => {
    const search = {
      id: 's-1',
      object: 'webset_search',
      status: 'completed',
      query: 'AI startups',
      metadata: { tag: 'test' },
      entity: { type: 'company' },
      behavior: 'override',
      recall: true,
      createdAt: '2024-01-01T00:00:00Z',
      progress: {
        found: 15,
        analyzed: 200,
        completion: 100,
        timeLeft: 0,
      },
      criteria: [
        { description: 'Has funding', successRate: 45.2 },
        { description: 'In SF', successRate: 22.1 },
      ],
    };

    const result = projectSearch(search);
    expect(result).toEqual({
      id: 's-1',
      status: 'completed',
      query: 'AI startups',
      metadata: { tag: 'test' },
      progress: { found: 15, analyzed: 200, completion: 100, timeLeft: 0 },
      criteria: [
        { description: 'Has funding', successRate: 45.2 },
        { description: 'In SF', successRate: 22.1 },
      ],
    });
  });

  it('strips entity, behavior, recall, timestamps', () => {
    const result = projectSearch({
      id: 's-1', status: 'active', query: 'test',
      entity: { type: 'company' }, behavior: 'override', recall: true,
      createdAt: '2024-01-01',
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('"entity"');
    expect(text).not.toContain('"behavior"');
    expect(text).not.toContain('"recall"');
    expect(text).not.toContain('"createdAt"');
  });

  it('handles missing progress and criteria', () => {
    const result = projectSearch({ id: 's-1', status: 'active', query: 'test' });
    expect(result.progress).toBeNull();
    expect(result.criteria).toBeNull();
  });
});

// --- Enrichment projection tests ---

describe('projectEnrichment', () => {
  it('projects enrichment definition', () => {
    const enrichment = {
      id: 'e-1',
      object: 'webset_enrichment',
      status: 'completed',
      description: 'Annual revenue',
      format: 'number',
      options: [{ label: 'opt1' }],
      metadata: { tag: 'revenue' },
      createdAt: '2024-01-01T00:00:00Z',
    };
    const result = projectEnrichment(enrichment);
    // projectEnrichment intentionally preserves title/websetId/instructions/
    // options/timestamps so callers can verify active options/instructions
    // after create and associate the enrichment with its webset.
    expect(result).toEqual({
      id: 'e-1',
      websetId: null,
      title: null,
      status: 'completed',
      description: 'Annual revenue',
      instructions: null,
      format: 'number',
      options: [{ label: 'opt1' }],
      metadata: { tag: 'revenue' },
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: null,
    });
  });

  it('strips the object envelope but preserves options and timestamps', () => {
    const result = projectEnrichment({
      id: 'e-1', status: 'active', description: 'test', format: 'text',
      options: [{ label: 'a' }], createdAt: '2024-01-01', object: 'webset_enrichment',
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('"object"');   // envelope field not projected
    expect(text).toContain('"options"');        // preserved (active options)
    expect(text).toContain('"createdAt"');       // preserved (timestamps)
  });
});

// --- Monitor projection tests ---

describe('projectMonitor', () => {
  it('projects monitor with lastRun', () => {
    const monitor = {
      id: 'm-1',
      object: 'webset_monitor',
      status: 'active',
      nextRunAt: '2024-02-01T00:00:00Z',
      metadata: { schedule: 'daily' },
      cadence: { cron: '0 0 * * *', timezone: 'UTC' },
      behavior: { type: 'search', config: {} },
      lastRun: {
        id: 'run-1',
        status: 'completed',
        completedAt: '2024-01-31T00:00:00Z',
        startedAt: '2024-01-31T00:00:00Z',
      },
      createdAt: '2024-01-01T00:00:00Z',
    };
    const result = projectMonitor(monitor);
    expect(result).toEqual({
      id: 'm-1',
      status: 'active',
      nextRunAt: '2024-02-01T00:00:00Z',
      metadata: { schedule: 'daily' },
      lastRun: { status: 'completed', completedAt: '2024-01-31T00:00:00Z' },
    });
  });

  it('strips cadence, behavior config', () => {
    const result = projectMonitor({
      id: 'm-1', status: 'active',
      cadence: { cron: '0 0 * * *' }, behavior: { type: 'search' },
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('"cadence"');
    expect(text).not.toContain('"behavior"');
  });

  it('handles missing lastRun', () => {
    const result = projectMonitor({ id: 'm-1', status: 'active' });
    expect(result.lastRun).toBeNull();
  });
});

describe('projectMonitorRun', () => {
  it('projects monitor run', () => {
    const run = {
      id: 'run-1',
      object: 'webset_monitor_run',
      status: 'completed',
      type: 'scheduled',
      completedAt: '2024-01-31T00:00:00Z',
      startedAt: '2024-01-31T00:00:00Z',
      failedReason: null,
    };
    const result = projectMonitorRun(run);
    expect(result).toEqual({
      id: 'run-1',
      status: 'completed',
      type: 'scheduled',
      completedAt: '2024-01-31T00:00:00Z',
      failedReason: null,
    });
  });

  it('includes failedReason when present', () => {
    const result = projectMonitorRun({
      id: 'run-1', status: 'failed', failedReason: 'Timeout exceeded',
    });
    expect(result.failedReason).toBe('Timeout exceeded');
  });
});

// --- Webhook projection tests ---

describe('projectWebhook', () => {
  it('projects webhook', () => {
    const webhook = {
      id: 'wh-1',
      object: 'webhook',
      status: 'active',
      url: 'https://example.com/hook',
      events: ['webset.idle', 'item.created'],
      metadata: { env: 'prod' },
      secret: 'whsec_secret123',
      createdAt: '2024-01-01T00:00:00Z',
    };
    const result = projectWebhook(webhook);
    expect(result).toEqual({
      id: 'wh-1',
      status: 'active',
      url: 'https://example.com/hook',
      events: ['webset.idle', 'item.created'],
      metadata: { env: 'prod' },
    });
  });

  it('strips secret and timestamps', () => {
    const result = projectWebhook({
      id: 'wh-1', status: 'active', url: 'https://x.com', events: [],
      secret: 'whsec_123', createdAt: '2024-01-01',
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('"createdAt"');
  });
});

describe('projectWebhookAttempt', () => {
  it('projects webhook attempt', () => {
    const attempt = {
      id: 'att-1',
      eventType: 'webset.idle',
      successful: true,
      responseStatusCode: 200,
      attemptedAt: '2024-01-31T00:00:00Z',
      requestBody: '{"event": "webset.idle"}',
      responseBody: 'OK',
      headers: { 'content-type': 'application/json' },
    };
    const result = projectWebhookAttempt(attempt);
    // Preserves id (correlate retries) and request/response (debug delivery).
    // The input here uses requestBody/responseBody/headers — not the spec's
    // request/response fields — so those project to null.
    expect(result).toEqual({
      id: 'att-1',
      eventType: 'webset.idle',
      successful: true,
      responseStatusCode: 200,
      attemptedAt: '2024-01-31T00:00:00Z',
      createdAt: null,
      request: null,
      response: null,
    });
  });

  it('strips request/response bodies and headers', () => {
    const result = projectWebhookAttempt({
      eventType: 'item.created', successful: false, responseStatusCode: 500,
      attemptedAt: '2024-01-31', requestBody: '{}', responseBody: 'error',
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('requestBody');
    expect(text).not.toContain('responseBody');
  });
});

// --- Import projection tests ---

describe('projectImport', () => {
  it('projects import', () => {
    const imp = {
      id: 'imp-1',
      object: 'webset_import',
      status: 'completed',
      count: 50,
      title: 'Q1 Companies',
      metadata: { source: 'crm' },
      failedReason: null,
      format: 'csv',
      entity: { type: 'company' },
      createdAt: '2024-01-01T00:00:00Z',
    };
    const result = projectImport(imp);
    expect(result).toEqual({
      id: 'imp-1',
      status: 'completed',
      count: 50,
      title: 'Q1 Companies',
      metadata: { source: 'crm' },
      failedReason: null,
    });
  });

  it('strips format, entity, timestamps', () => {
    const result = projectImport({
      id: 'imp-1', status: 'active', format: 'csv',
      entity: { type: 'company' }, createdAt: '2024-01-01',
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('"format"');
    expect(text).not.toContain('"entity"');
    expect(text).not.toContain('"createdAt"');
  });
});

// --- Event projection tests ---

describe('projectEvent', () => {
  it('projects event', () => {
    const event = {
      id: 'evt-1',
      object: 'event',
      type: 'webset.idle',
      createdAt: '2024-01-31T00:00:00Z',
      data: { websetId: 'ws-1', status: 'idle' },
    };
    const result = projectEvent(event);
    // projectEvent preserves the spec's Event.data payload — stripping it
    // broke channel-bridge routing (channel.ts reads payload.data.websetId).
    expect(result).toEqual({
      id: 'evt-1',
      type: 'webset.idle',
      createdAt: '2024-01-31T00:00:00Z',
      data: { websetId: 'ws-1', status: 'idle' },
    });
  });

  it('preserves the data payload (load-bearing for channel-bridge routing)', () => {
    const result = projectEvent({
      id: 'evt-1', type: 'item.created', createdAt: '2024-01-31',
      data: { itemId: 'item-1', websetId: 'ws-1' },
    });
    expect(result.data).toEqual({ itemId: 'item-1', websetId: 'ws-1' });
  });
});

// --- Research projection tests ---

describe('projectResearch', () => {
  it('projects running research', () => {
    const research = {
      id: 'res-1',
      researchId: 'res-1',
      status: 'running',
      model: 'exa-research',
      createdAt: '2024-01-31T00:00:00Z',
      events: [{ type: 'progress', data: {} }],
    };
    const result = projectResearch(research);
    expect(result).toEqual({
      researchId: 'res-1',
      status: 'running',
      model: 'exa-research',
    });
    expect(result).not.toHaveProperty('events');
    expect(result).not.toHaveProperty('createdAt');
  });

  it('projects completed research with output and cost', () => {
    const research = {
      researchId: 'res-1',
      status: 'completed',
      model: 'exa-research-pro',
      output: { content: 'Research findings...', parsed: { key: 'value' } },
      costDollars: { total: 0.15, input: 0.05, output: 0.10 },
      events: [{ type: 'done' }],
      createdAt: '2024-01-31T00:00:00Z',
    };
    const result = projectResearch(research);
    expect(result).toEqual({
      researchId: 'res-1',
      status: 'completed',
      model: 'exa-research-pro',
      output: { content: 'Research findings...', parsed: { key: 'value' } },
      cost: 0.15,
    });
  });

  it('falls back to id if researchId not present', () => {
    const result = projectResearch({ id: 'res-1', status: 'running' });
    expect(result.researchId).toBe('res-1');
  });

  it('handles completed research without costDollars', () => {
    const result = projectResearch({
      researchId: 'res-1', status: 'completed', model: 'exa-research',
      output: 'text output',
    });
    expect(result.output).toBe('text output');
    expect(result).not.toHaveProperty('cost');
  });
});
