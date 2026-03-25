// Exa webhook signature verification.
// Header format: Exa-Signature: t=<unix_timestamp>,v1=<hex_hmac_sha256>
// Signed payload: `${timestamp}.${rawBody}`

import crypto from 'node:crypto';

const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes

export function verifyExaSignature(
  rawBody: Buffer | string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  if (!signatureHeader || !secret) return false;

  // Parse header: t=<timestamp>,v1=<hmac>
  const parts: Record<string, string> = {};
  for (const segment of signatureHeader.split(',')) {
    const eqIdx = segment.indexOf('=');
    if (eqIdx > 0) {
      parts[segment.slice(0, eqIdx).trim()] = segment.slice(eqIdx + 1).trim();
    }
  }

  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  // Reject stale timestamps
  const ts = Number(timestamp);
  if (isNaN(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;

  // Compute expected HMAC
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(bodyBuf)
    .digest('hex');

  // Timing-safe comparison
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

/** Helper to create a valid signature for testing */
export function createExaSignature(
  rawBody: string,
  secret: string,
  timestamp?: number,
): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.`)
    .update(Buffer.from(rawBody))
    .digest('hex');
  return `t=${ts},v1=${hmac}`;
}
