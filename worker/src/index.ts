/**
 * Durable webhook buffer for Exa Websets events.
 *
 * Design note: this Worker deliberately does NOT hold the Exa webhook secret and
 * does NOT verify the `Exa-Signature` HMAC. The secret lives only in the local
 * SQLite store (`webhook_secrets`) on the machine that created the webhook.
 * The Worker stores the raw body verbatim alongside the signature header; the
 * puller verifies the HMAC locally at pull time and discards anything that
 * fails. Verification is therefore just as strict, but the secret never leaves
 * the box that minted it.
 *
 * Consequence: the ingest endpoint is unauthenticated (Exa cannot send a bearer
 * token). Junk can be POSTed by anyone who learns the URL, so it is capped by
 * size and swept by retention, and it is discarded at pull time by the signature
 * check. The read side IS authenticated — PULL_TOKEN gates every read.
 */

export interface Env {
  DB: D1Database;
  PULL_TOKEN: string;
}

const MAX_BODY_BYTES = 128 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Constant-time string compare, so the pull token can't be probed by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(req: Request, env: Env): boolean {
  const header = req.headers.get('authorization');
  if (!header || !env.PULL_TOKEN) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(header.slice(prefix.length), env.PULL_TOKEN);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === '/health') {
      return json({ ok: true, service: 'websets-webhook-buffer' });
    }

    // --- Ingest: Exa posts here. Unauthenticated by necessity; see file header.
    if (pathname === '/webhooks/exa' && req.method === 'POST') {
      const body = await req.text();

      if (body.length > MAX_BODY_BYTES) {
        // Return 200 so Exa does not enter a retry loop over a payload we will
        // never accept. Oversized bodies are not something a retry can fix.
        return json({ received: false, reason: 'payload too large' });
      }

      const signature = req.headers.get('exa-signature');

      await env.DB.prepare(
        'INSERT INTO events (received_at, signature, body) VALUES (?, ?, ?)',
      )
        .bind(Date.now(), signature, body)
        .run();

      // Sweep old rows after responding, so retention never delays the 200 that
      // tells Exa the delivery succeeded.
      ctx.waitUntil(
        env.DB.prepare('DELETE FROM events WHERE received_at < ?')
          .bind(Date.now() - RETENTION_MS)
          .run()
          .then(() => undefined)
          .catch((err) => {
            console.error('retention sweep failed:', err);
          }),
      );

      return json({ received: true });
    }

    // --- Read side: everything below requires the pull token.
    if (!authorized(req, env)) {
      return json({ error: 'unauthorized' }, 401);
    }

    // Pull events after a cursor. At-least-once: rows survive until acked.
    if (pathname === '/events' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? '0') || 0;
      const requested = Number(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT));
      const limit = Math.min(Math.max(requested || DEFAULT_LIMIT, 1), MAX_LIMIT);

      const { results } = await env.DB.prepare(
        'SELECT seq, received_at, signature, body FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
      )
        .bind(after, limit)
        .all();

      const rows = results ?? [];
      return json({
        events: rows,
        count: rows.length,
        cursor: rows.length ? (rows[rows.length - 1] as { seq: number }).seq : after,
      });
    }

    // Ack through a sequence number — deletes everything at or below it.
    if (pathname === '/events/ack' && req.method === 'POST') {
      const payload = (await req.json().catch(() => ({}))) as { through?: number };
      const through = Number(payload.through);
      if (!Number.isFinite(through) || through <= 0) {
        return json({ error: 'through must be a positive sequence number' }, 400);
      }

      const res = await env.DB.prepare('DELETE FROM events WHERE seq <= ?')
        .bind(through)
        .run();

      return json({ acked: true, through, deleted: res.meta?.changes ?? 0 });
    }

    // Queue depth, for monitoring a long unattended run.
    if (pathname === '/events/stats' && req.method === 'GET') {
      const row = await env.DB.prepare(
        'SELECT COUNT(*) AS pending, MIN(seq) AS min_seq, MAX(seq) AS max_seq, MIN(received_at) AS oldest FROM events',
      ).first();
      return json(row ?? {});
    }

    return json({ error: 'not found' }, 404);
  },
};
