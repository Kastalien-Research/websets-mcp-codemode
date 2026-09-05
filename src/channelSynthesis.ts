// Pure helpers shared by channel delivery and its offline tests.
export type ChannelEvent = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  /** Server-resolved definitions; null/absent means unknown, not zero enrichments. */
  expectedEnrichmentIds?: string[] | null;
};

export const SYNTHETIC_ITEM_READY = 'webset.item.ready';

type ReadyDecision =
  | { emit: true; syntheticType: typeof SYNTHETIC_ITEM_READY }
  | { emit: false; reason: 'invalid_item' | 'criteria_rejected' | 'unknown_definitions' | 'incomplete_enrichments' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Readiness is relative to the definitions observed by the server for this event.
 * A quiet stream alone does not establish completion. Unclear evaluations remain
 * eligible for subsequent verification, while missing evaluations are unknown.
 */
export function decideItemReady(event: ChannelEvent): ReadyDecision {
  const data = event.payload?.data;
  if (!isRecord(data) || typeof data.id !== 'string' || !data.id.trim()
    || typeof data.websetId !== 'string' || !data.websetId.trim()
    || !Array.isArray(data.evaluations)
    || !data.evaluations.every(e => isRecord(e) && typeof e.criterion === 'string'
      && ['yes', 'no', 'unclear'].includes(e.satisfied as string))
    || !(Array.isArray(data.enrichments) || data.enrichments === null)) {
    return { emit: false, reason: 'invalid_item' };
  }
  if (data.evaluations.some(e => e.satisfied === 'no')) {
    return { emit: false, reason: 'criteria_rejected' };
  }
  const expected = event.expectedEnrichmentIds;
  if (!Array.isArray(expected) || !expected.every(id => typeof id === 'string' && id.trim())
    || new Set(expected).size !== expected.length) {
    return { emit: false, reason: 'unknown_definitions' };
  }
  const enrichments = data.enrichments ?? [];
  if (!expected.every(id => {
    const matches = enrichments.filter(e => isRecord(e) && e.enrichmentId === id);
    return matches.length === 1 && matches[0].status === 'completed';
  })) {
    return { emit: false, reason: 'incomplete_enrichments' };
  }
  return { emit: true, syntheticType: SYNTHETIC_ITEM_READY };
}

/** Select one notification, preserving explicitly enabled raw events even if non-ready. */
export function selectItemNotification(
  latest: ChannelEvent,
  rawByType: ReadonlyMap<string, ChannelEvent>,
  allowed: (event: ChannelEvent, requireExplicit: boolean) => boolean,
): ChannelEvent | undefined {
  const decision = decideItemReady(latest);
  if (decision.emit) {
    const synthetic = { ...latest, type: decision.syntheticType };
    if (allowed(synthetic, false)) return synthetic;
  }
  for (const type of ['webset.item.enriched', 'webset.item.created']) {
    const raw = rawByType.get(type);
    if (raw && allowed(raw, true)) return raw;
  }
  return undefined;
}
