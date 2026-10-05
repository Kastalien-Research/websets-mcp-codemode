// Vitest setup file for the contract's offline suite (invariant G3).
// Runs before each test file's imports, so clients that capture global fetch at
// module load (exa-js does) capture this guard. Non-loopback requests are
// blocked and appended to CONTRACT_NET_LOG; the invariant requires that log to
// stay empty even when a test swallows the resulting error.

import { appendFileSync } from 'node:fs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const log = process.env.CONTRACT_NET_LOG;
const realFetch = globalThis.fetch;

function targetOf(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = targetOf(input);
  if (!LOOPBACK.has(url.hostname)) {
    if (log) appendFileSync(log, `${url.origin}${url.pathname}\n`);
    throw new Error(`[contract net-guard] blocked outbound request to ${url.origin}`);
  }
  return realFetch(input, init);
}) as typeof fetch;
