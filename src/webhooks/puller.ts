// Pulls buffered Exa webhook deliveries from the Cloudflare Worker buffer and
// republishes them onto the local event bus.
//
// Why a puller instead of a tunnel: a trycloudflare quick tunnel is ephemeral
// and unauthenticated, so an 8-hour unattended run can silently lose deliveries
// when it drops. The Worker holds events in D1 until this process acks them, so
// the box can restart, lose network, or be rebuilt without dropping events.
//
// The Worker never sees the webhook secret. Signature verification happens here,
// against the same `webhook_secrets` rows the direct receiver route uses.

import { verifyExaSignature } from './signature.js';
import { webhookEventBus, createEvent } from './eventBus.js';
import { listWebhookSecrets } from '../store/db.js';

interface BufferedEvent {
  seq: number;
  received_at: number;
  signature: string | null;
  body: string;
}

/**
 * `verifyExaSignature` enforces a 5-minute timestamp tolerance, which is right
 * for a live endpoint but wrong here — a buffered event may legitimately sit in
 * D1 for hours before we pull it. We disable that check inside the HMAC verify
 * and re-impose freshness against the Worker's `received_at` (edge arrival
 * time) instead, which is the timestamp the replay protection actually cares
 * about: was this payload signed shortly before it reached the edge?
 */
const HMAC_TOLERANCE_DISABLED = Number.MAX_SAFE_INTEGER;
const EDGE_FRESHNESS_SECONDS = 300;

const DEFAULT_POLL_MS = 15_000;
const MAX_BACKOFF_MS = 300_000;
const SEEN_CAPACITY = 5_000;

/** Reject events whose signature timestamp is far from when the edge received them. */
function edgeFresh(signatureHeader: string, receivedAtMs: number): boolean {
  const match = /(?:^|,)\s*t=([^,]+)/.exec(signatureHeader);
  if (!match) return false;
  const signedAt = Number(match[1].trim());
  if (!Number.isFinite(signedAt)) return false;
  return Math.abs(receivedAtMs / 1000 - signedAt) <= EDGE_FRESHNESS_SECONDS;
}

export interface PullerOptions {
  bufferUrl: string;
  pullToken: string;
  pollMs?: number;
  envSecret?: string;
}

export function startWebhookPuller(opts: PullerOptions): () => void {
  const base = opts.bufferUrl.replace(/\/+$/, '');
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  let stopped = false;
  let backoffMs = 0;
  let timer: NodeJS.Timeout | undefined;

  // Ack is at-least-once: if we publish and then fail to ack, the Worker hands
  // the same rows back. Dedupe on Exa's own event id so a retry doesn't produce
  // a duplicate bus event. Bounded so it can't grow without limit.
  const seen = new Set<string>();
  const rememberSeen = (id: string) => {
    seen.add(id);
    if (seen.size > SEEN_CAPACITY) {
      const oldest = seen.values().next().value as string | undefined;
      if (oldest !== undefined) seen.delete(oldest);
    }
  };

  const authHeaders = { authorization: `Bearer ${opts.pullToken}` };

  async function drainOnce(): Promise<void> {
    const res = await fetch(`${base}/events?after=0&limit=200`, { headers: authHeaders });
    if (!res.ok) {
      throw new Error(`buffer pull failed: ${res.status} ${await res.text()}`);
    }

    const { events } = (await res.json()) as { events: BufferedEvent[] };
    if (!events?.length) return;

    const secrets = listWebhookSecrets().map((r) => r.secret);
    if (opts.envSecret) secrets.unshift(opts.envSecret);

    let published = 0;
    let rejected = 0;
    let duplicates = 0;

    for (const evt of events) {
      const sig = evt.signature;

      // No known secret means we cannot authenticate anything. Do NOT fall back
      // to accepting unsigned payloads here — unlike the direct receiver, this
      // path reads from a publicly writable ingest endpoint, so an unverified
      // event is attacker-controlled by default.
      if (!sig || secrets.length === 0) {
        rejected++;
        continue;
      }

      if (!edgeFresh(sig, evt.received_at)) {
        rejected++;
        continue;
      }

      const rawBody = Buffer.from(evt.body, 'utf8');
      const ok = secrets.some((s) =>
        verifyExaSignature(rawBody, sig, s, HMAC_TOLERANCE_DISABLED),
      );
      if (!ok) {
        rejected++;
        continue;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(evt.body) as Record<string, unknown>;
      } catch {
        rejected++;
        continue;
      }

      const exaId = typeof payload.id === 'string' ? payload.id : undefined;
      if (exaId && seen.has(exaId)) {
        duplicates++;
        continue;
      }
      if (exaId) rememberSeen(exaId);

      webhookEventBus.publish(createEvent(payload));
      published++;
    }

    // Ack only after publishing. A crash between publish and ack replays the
    // batch, which the dedupe above absorbs.
    const through = events[events.length - 1].seq;
    const ackRes = await fetch(`${base}/events/ack`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ through }),
    });
    if (!ackRes.ok) {
      throw new Error(`buffer ack failed: ${ackRes.status} ${await ackRes.text()}`);
    }

    console.log(
      `[webhook-puller] drained ${events.length} through seq ${through} `
      + `(published ${published}, rejected ${rejected}, duplicate ${duplicates})`,
    );
    if (rejected > 0) {
      console.warn(
        `[webhook-puller] ${rejected} buffered event(s) failed signature or `
        + `freshness checks and were discarded.`,
      );
    }
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    try {
      await drainOnce();
      backoffMs = 0;
    } catch (err) {
      backoffMs = backoffMs ? Math.min(backoffMs * 2, MAX_BACKOFF_MS) : pollMs;
      console.error(
        `[webhook-puller] ${err instanceof Error ? err.message : String(err)} `
        + `— retrying in ${Math.round(backoffMs / 1000)}s`,
      );
    }
    if (stopped) return;
    timer = setTimeout(() => void loop(), backoffMs || pollMs);
    timer.unref?.();
  }

  console.log(`[webhook-puller] polling ${base} every ${pollMs / 1000}s`);
  void loop();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
