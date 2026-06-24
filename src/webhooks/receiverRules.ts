// Receiver rules: processes webhook events into company records, lens hits, and scores.

import type { WebhookEvent } from './eventBus.js';
import {
  normalizeDomain,
  upsertCompany,
  recordLensHit,
  updateScore,
  getDb,
} from '../store/db.js';
import type { LensHitRow, CompanyRow } from '../store/db.js';

export interface CompactCandidate {
  action: 'claim_and_research' | 'queue_for_review' | 'monitor';
  company: string;
  companyDomain: string;
  lensHits: string[];
  score: number;
  primaryUrl: string;
  summary: string;
  // Item identity, so a downstream consumer (e.g. the channel) can target this
  // exact item — kicking /sweep-webset with { items: [{ itemId, websetId }] }
  // rather than re-deriving it. Both are already in scope at build time below.
  itemId: string;
  websetId: string;
}

/**
 * Process a webhook item event: dedup company, record lens hit, compute score.
 * Returns a CompactCandidate if score >= 7, null otherwise (still persisted as monitor).
 */
export function processWebhookItem(
  event: WebhookEvent,
  websetLensMap: Map<string, string>,
): CompactCandidate | null {
  const data = event.payload.data as Record<string, unknown> | undefined;
  if (!data) return null;

  const props = (data.properties ?? {}) as Record<string, unknown>;
  const company = props.company as Record<string, unknown> | undefined;
  const person = props.person as Record<string, unknown> | undefined;
  const article = props.article as Record<string, unknown> | undefined;
  const custom = props.custom as Record<string, unknown> | undefined;

  const entityName = (
    company?.name ?? person?.name ?? article?.title ??
    custom?.title ?? props.description ?? ''
  ) as string;

  const url = ((props.url ?? data.url ?? '') as string);
  if (!url && !entityName) return null;

  const domain = url ? normalizeDomain(url) : normalizeDomain(entityName);
  if (!domain) return null;

  // Dedup: upsert company
  upsertCompany(domain, entityName || domain);

  // Determine which lens fired
  const websetId = (data.websetId ?? '') as string;
  const lensId = websetLensMap.get(websetId);
  if (!lensId) return null;

  // Extract enrichment summary
  const enrichments = (data.enrichments as Array<Record<string, unknown>> | undefined)
    ?.filter((e) => e.status === 'completed' && (e.result as unknown[] | null)?.length) ?? [];

  const evidenceSummary = enrichments
    .map((e) => `${e.description ?? e.enrichmentId ?? 'info'}: ${(e.result as unknown[])[0]}`)
    .join('; ');

  const itemId = (data.id ?? '') as string;

  recordLensHit(domain, lensId, {
    websetId,
    itemId,
    strength: 'medium',
    evidenceUrl: url,
    evidenceSummary: evidenceSummary || undefined,
  });

  // Recompute score
  const { score, components, verdict } = computeScore(domain);

  // Build candidate if score warrants action
  const d = getDb();
  const hits = d.prepare(
    'SELECT lens_id FROM lens_hits WHERE company_domain = ?'
  ).all(domain) as Array<{ lens_id: string }>;

  const action = verdict as CompactCandidate['action'];

  const candidate: CompactCandidate = {
    action,
    company: entityName || domain,
    companyDomain: domain,
    lensHits: hits.map(h => h.lens_id),
    score,
    primaryUrl: url,
    summary: evidenceSummary || `${entityName} detected via ${lensId}`,
    itemId,
    websetId,
  };

  // Only emit for actionable candidates (score >= 7)
  if (score >= 7) return candidate;

  return null;
}

/**
 * Compute a company's score from its lens hits and company record.
 * Persists the score and returns it.
 */
export function computeScore(domain: string): {
  score: number;
  components: Record<string, number>;
  verdict: string;
} {
  const d = getDb();

  const companyRow = d.prepare(
    'SELECT * FROM company_records WHERE domain = ?'
  ).get(domain) as CompanyRow | undefined;

  const lensHits = d.prepare(
    'SELECT * FROM lens_hits WHERE company_domain = ?'
  ).all(domain) as LensHitRow[];

  const components: Record<string, number> = {};
  let score = 0;

  // +5 if lens `control_pain` has a hit
  if (lensHits.some(h => h.lens_id === 'control_pain')) {
    components.control_pain = 5;
    score += 5;
  }

  // +4 if company appears in 2+ lenses
  if (lensHits.length >= 2) {
    components.multi_lens = 4;
    score += 4;
  }

  // +3 if lens `trigger_event` has a hit AND evidence is within 30 days
  const triggerHit = lensHits.find(h => h.lens_id === 'trigger_event');
  if (triggerHit) {
    const hitDate = new Date(triggerHit.first_seen);
    const daysSince = (Date.now() - hitDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince <= 30) {
      components.recent_trigger = 3;
      score += 3;
    }
  }

  // +3 if evidence comes from docs / changelog / engineering post
  const techPatterns = /\/(docs|changelog|blog|engineering|release|updates)\b/i;
  if (lensHits.some(h => h.evidence_url && techPatterns.test(h.evidence_url))) {
    components.tech_evidence = 3;
    score += 3;
  }

  // +2 if enrichments mention a buyer role
  const buyerPatterns = /\b(head of ai|platform engineer|vp eng|cto|ml platform|developer productivity|security lead)\b/i;
  if (lensHits.some(h => h.evidence_summary && buyerPatterns.test(h.evidence_summary))) {
    components.buyer_visible = 2;
    score += 2;
  }

  // +2 if employee count signal suggests 20-3000
  if (companyRow?.employee_count_signal) {
    const empMatch = companyRow.employee_count_signal.match(/(\d+)/);
    if (empMatch) {
      const count = parseInt(empMatch[1], 10);
      if (count >= 20 && count <= 3000) {
        components.size_fit = 2;
        score += 2;
      }
    }
  }

  // -4 if sector matches agency/consultancy
  if (companyRow?.sector && /\b(agency|consultancy|consulting|services)\b/i.test(companyRow.sector)) {
    components.agency_penalty = -4;
    score -= 4;
  }

  // -3 if sector matches consumer-only
  if (companyRow?.sector && /\b(consumer|b2c|social media)\b/i.test(companyRow.sector)) {
    components.consumer_penalty = -3;
    score -= 3;
  }

  // -3 if evidence is generic AI PR
  const genericAiPatterns = /\b(ai-powered|leveraging ai|artificial intelligence solutions|cutting-edge ai)\b/i;
  if (lensHits.every(h => h.evidence_summary && genericAiPatterns.test(h.evidence_summary)) && lensHits.length > 0) {
    components.generic_ai_penalty = -3;
    score -= 3;
  }

  // -2 if evidence is older than 90 days
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
  if (lensHits.length > 0 && lensHits.every(h => new Date(h.first_seen).getTime() < ninetyDaysAgo)) {
    components.stale_penalty = -2;
    score -= 2;
  }

  // Determine verdict
  let verdict: string;
  if (score >= 10) {
    verdict = 'claim_and_research';
  } else if (score >= 7) {
    verdict = 'queue_for_review';
  } else {
    verdict = 'monitor';
  }

  updateScore(domain, score, components, verdict);

  return { score, components, verdict };
}
