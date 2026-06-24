// Pure helpers used by the channel bridge (src/channel.ts). Lives in its
// own module so unit tests can import it without triggering channel.ts's
// startup side effects (server.connect, watchFile, connectSSE loop).

export type ChannelEvent = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
};

// Synthetic event type the bridge emits at the end of a per-item
// coalescence window when the item passes the criteria gate. See
// channel.ts for the full pipeline contract.
export const SYNTHETIC_ITEM_READY = 'webset.item.ready';

/**
 * Decide whether and how to emit a per-item event at the end of its
 * coalescence window.
 *
 * Permissive filter policy: items pass when no evaluation has
 * `satisfied: "no"`. `"yes"` and `"unclear"` both pass — Stage-2 verifiers
 * (e.g. agentRuns.verifyItem) resolve the ambiguity downstream.
 *
 * Returns:
 *   { emit: false }                — item failed the criteria gate; drop silently
 *   { emit: true, syntheticType }  — emit with this synthetic event_type
 */
export function decideItemReady(
  event: ChannelEvent,
): { emit: false } | { emit: true; syntheticType: string } {
  const data = (event.payload?.data ?? {}) as Record<string, unknown>;
  const evals = data.evaluations as Array<{ satisfied?: string }> | undefined;
  if (Array.isArray(evals) && evals.some(e => e?.satisfied === 'no')) {
    return { emit: false };
  }
  return { emit: true, syntheticType: SYNTHETIC_ITEM_READY };
}
