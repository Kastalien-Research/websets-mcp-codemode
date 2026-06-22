import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { processWebhookItem, computeScore } from '../receiverRules.js';
import type { WebhookEvent } from '../eventBus.js';
import {
  getDb, closeDb,
  upsertCompany, recordLensHit, getCompany,
} from '../../store/db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let testDbPath: string;

const websetLensMap = new Map<string, string>([
  ['ws_agent_buildout', 'agent_buildout'],
  ['ws_control_pain', 'control_pain'],
  ['ws_trigger_event', 'trigger_event'],
]);

function makeEvent(overrides: Partial<{
  id: string;
  type: string;
  websetId: string;
  itemId: string;
  companyName: string;
  url: string;
  enrichments: Array<Record<string, unknown>>;
}>): WebhookEvent {
  return {
    id: overrides.id ?? 'evt_test',
    type: overrides.type ?? 'webset.item.enriched',
    receivedAt: new Date().toISOString(),
    payload: {
      type: overrides.type ?? 'webset.item.enriched',
      data: {
        id: overrides.itemId ?? 'item_test',
        websetId: overrides.websetId ?? 'ws_agent_buildout',
        properties: {
          type: 'company',
          url: overrides.url ?? 'https://vercel.com',
          company: { name: overrides.companyName ?? 'Vercel' },
        },
        enrichments: overrides.enrichments ?? [
          { enrichmentId: 'e1', description: 'short company description', status: 'completed', result: ['Developer platform'] },
          { enrichmentId: 'e2', description: 'one-sentence summary of the AI/agent initiative', status: 'completed', result: ['Launched AI SDK for agent workflows'] },
        ],
        evaluations: [{ satisfied: 'yes' }],
      },
    },
  };
}

beforeEach(() => {
  testDbPath = path.join(os.tmpdir(), `receiver-test-${Date.now()}.db`);
  closeDb();
  process.env.WEBSETS_DB_PATH = testDbPath;
  getDb(testDbPath);
});

afterEach(() => {
  closeDb();
  try { fs.unlinkSync(testDbPath); } catch {}
  delete process.env.WEBSETS_DB_PATH;
});

describe('processWebhookItem', () => {
  it('creates company record and lens hit', () => {
    processWebhookItem(makeEvent({}), websetLensMap);

    const result = getCompany('vercel.com');
    expect(result).not.toBeNull();
    expect(result!.company.canonical_name).toBe('Vercel');
    expect(result!.lensHits).toHaveLength(1);
    expect(result!.lensHits[0].lens_id).toBe('agent_buildout');
  });

  it('deduplicates companies across events', () => {
    processWebhookItem(makeEvent({ websetId: 'ws_agent_buildout' }), websetLensMap);
    processWebhookItem(makeEvent({ websetId: 'ws_control_pain', id: 'evt_2', itemId: 'item_2' }), websetLensMap);

    const result = getCompany('vercel.com');
    expect(result!.lensHits).toHaveLength(2);
    expect(result!.lensHits.map(h => h.lens_id).sort()).toEqual(['agent_buildout', 'control_pain']);
  });

  it('returns null for unknown webset', () => {
    const result = processWebhookItem(
      makeEvent({ websetId: 'ws_unknown' }),
      websetLensMap,
    );
    expect(result).toBeNull();
  });

  it('returns null for events without data', () => {
    const event: WebhookEvent = {
      id: 'evt_empty',
      type: 'webset.item.created',
      receivedAt: new Date().toISOString(),
      payload: {},
    };
    expect(processWebhookItem(event, websetLensMap)).toBeNull();
  });

  it('returns candidate when score >= 7', () => {
    // Set up a company with control_pain first to get a higher base score
    upsertCompany('vercel.com', 'Vercel');
    recordLensHit('vercel.com', 'control_pain', { evidenceUrl: 'https://vercel.com/docs/evals' });

    const candidate = processWebhookItem(
      makeEvent({ websetId: 'ws_agent_buildout' }),
      websetLensMap,
    );

    // control_pain(5) + multi_lens(4) + tech_evidence(3) = 12
    expect(candidate).not.toBeNull();
    expect(candidate!.score).toBeGreaterThanOrEqual(7);
    expect(candidate!.companyDomain).toBe('vercel.com');
    expect(candidate!.lensHits).toContain('agent_buildout');
    expect(candidate!.lensHits).toContain('control_pain');
    // Item identity is carried through so the channel can target this exact item
    // when kicking /sweep-webset.
    expect(candidate!.itemId).toBe('item_test');
    expect(candidate!.websetId).toBe('ws_agent_buildout');
  });
});

describe('computeScore', () => {
  it('scores +5 for control_pain hit', () => {
    upsertCompany('test.com', 'Test');
    recordLensHit('test.com', 'control_pain');

    const { score, components } = computeScore('test.com');
    expect(components.control_pain).toBe(5);
    expect(score).toBeGreaterThanOrEqual(5);
  });

  it('scores +4 for multi-lens', () => {
    upsertCompany('test.com', 'Test');
    recordLensHit('test.com', 'agent_buildout');
    recordLensHit('test.com', 'trigger_event');

    const { components } = computeScore('test.com');
    expect(components.multi_lens).toBe(4);
  });

  it('scores +3 for tech evidence URLs', () => {
    upsertCompany('test.com', 'Test');
    recordLensHit('test.com', 'agent_buildout', {
      evidenceUrl: 'https://test.com/docs/agents',
    });

    const { components } = computeScore('test.com');
    expect(components.tech_evidence).toBe(3);
  });

  it('penalizes agency/consultancy', () => {
    upsertCompany('agency.com', 'Agency Co', 'consulting agency');
    recordLensHit('agency.com', 'agent_buildout');

    const { components } = computeScore('agency.com');
    expect(components.agency_penalty).toBe(-4);
  });

  it('penalizes consumer-only', () => {
    upsertCompany('social.com', 'Social App', 'consumer b2c');
    recordLensHit('social.com', 'agent_buildout');

    const { components } = computeScore('social.com');
    expect(components.consumer_penalty).toBe(-3);
  });

  it('verdict claim_and_research for score >= 10', () => {
    upsertCompany('test.com', 'Test');
    recordLensHit('test.com', 'control_pain', {
      evidenceUrl: 'https://test.com/docs/evals',
    });
    recordLensHit('test.com', 'agent_buildout', {
      evidenceUrl: 'https://test.com/changelog/agents',
    });

    // control_pain(5) + multi_lens(4) + tech_evidence(3) = 12
    const { score, verdict } = computeScore('test.com');
    expect(score).toBeGreaterThanOrEqual(10);
    expect(verdict).toBe('claim_and_research');
  });

  it('verdict queue_for_review for score 7-9', () => {
    upsertCompany('test.com', 'Test');
    recordLensHit('test.com', 'control_pain');
    recordLensHit('test.com', 'agent_buildout');

    // control_pain(5) + multi_lens(4) = 9
    const { score, verdict } = computeScore('test.com');
    expect(score).toBeGreaterThanOrEqual(7);
    expect(score).toBeLessThan(10);
    expect(verdict).toBe('queue_for_review');
  });

  it('verdict monitor for score < 7', () => {
    upsertCompany('test.com', 'Test');
    recordLensHit('test.com', 'agent_buildout');

    const { verdict } = computeScore('test.com');
    expect(verdict).toBe('monitor');
  });

  it('persists score to database', () => {
    upsertCompany('test.com', 'Test');
    recordLensHit('test.com', 'control_pain');

    computeScore('test.com');

    const result = getCompany('test.com');
    expect(result!.score).not.toBeNull();
    expect(result!.score!.score).toBeGreaterThanOrEqual(5);
  });
});
