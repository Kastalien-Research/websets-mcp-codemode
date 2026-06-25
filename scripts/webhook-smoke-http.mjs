#!/usr/bin/env node
// HTTP-only smoke client for the webhook receiver.
//
// Assumes the server is reachable at http://localhost:7860 and that a known
// secret has already been seeded into webhook_secrets (e.g. via
// `docker compose exec websets-codemode node -e ...`).

import crypto from 'node:crypto';

const TEST_SECRET = process.env.TEST_SECRET || 'test_secret_known_to_db';
const WRONG_SECRET = 'test_secret_NOT_known_to_db';
const BASE = process.env.BASE_URL || 'http://localhost:7860';

function sign(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const hmac = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(Buffer.from(rawBody))
    .digest('hex');
  return `t=${timestamp},v1=${hmac}`;
}

const post = async (label, headers, body) => {
  const res = await fetch(`${BASE}/webhooks/exa`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  const text = await res.text();
  console.log(`  ${label}: HTTP ${res.status} ${text}`);
  return res.status;
};

const payload = JSON.stringify({
  id: `evt_smoke_${Date.now()}`,
  object: 'event',
  type: 'webset.item.created',
  data: { id: 'item_smoke', websetId: 'ws_smoke', properties: {} },
  createdAt: new Date().toISOString(),
});

console.log('--- Status before ---');
const statusRes = await fetch(`${BASE}/webhooks/status`);
console.log('  ', await statusRes.text());

console.log('\n--- 1. Correctly signed ---');
const s1 = await post('signed-correct', { 'exa-signature': sign(payload, TEST_SECRET) }, payload);

console.log('\n--- 2. Unsigned ---');
const s2 = await post('unsigned', {}, payload);

console.log('\n--- 3. Wrong-secret signed ---');
const s3 = await post('signed-wrong', { 'exa-signature': sign(payload, WRONG_SECRET) }, payload);

console.log('\n--- Result summary ---');
const expect = (label, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}: got ${got}, want ${want}`);
  return ok;
};
const allOk = [
  expect('correctly signed → 200', s1, 200),
  expect('unsigned → 401', s2, 401),
  expect('wrong-secret signed → 401', s3, 401),
].every(Boolean);
process.exit(allOk ? 0 : 1);
