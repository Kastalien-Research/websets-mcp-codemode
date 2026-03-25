import { describe, it, expect } from 'vitest';
import { verifyExaSignature, createExaSignature } from '../signature.js';

const SECRET = 'test-webhook-secret-123';

describe('verifyExaSignature', () => {
  it('accepts valid signature', () => {
    const body = '{"type":"webset.item.created","data":{"id":"item_1"}}';
    const header = createExaSignature(body, SECRET);
    expect(verifyExaSignature(body, header, SECRET)).toBe(true);
  });

  it('accepts valid signature with Buffer body', () => {
    const body = '{"type":"webset.item.created"}';
    const header = createExaSignature(body, SECRET);
    expect(verifyExaSignature(Buffer.from(body), header, SECRET)).toBe(true);
  });

  it('rejects invalid HMAC', () => {
    const body = '{"type":"test"}';
    const header = createExaSignature(body, 'wrong-secret');
    expect(verifyExaSignature(body, header, SECRET)).toBe(false);
  });

  it('rejects tampered body', () => {
    const body = '{"type":"test"}';
    const header = createExaSignature(body, SECRET);
    expect(verifyExaSignature('{"type":"tampered"}', header, SECRET)).toBe(false);
  });

  it('rejects expired timestamp', () => {
    const body = '{"type":"test"}';
    const staleTs = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const header = createExaSignature(body, SECRET, staleTs);
    expect(verifyExaSignature(body, header, SECRET)).toBe(false);
  });

  it('accepts timestamp within custom tolerance', () => {
    const body = '{"type":"test"}';
    const ts = Math.floor(Date.now() / 1000) - 400; // 6.7 min ago
    const header = createExaSignature(body, SECRET, ts);
    // Default 300s tolerance → should fail
    expect(verifyExaSignature(body, header, SECRET)).toBe(false);
    // 600s tolerance → should pass
    expect(verifyExaSignature(body, header, SECRET, 600)).toBe(true);
  });

  it('rejects empty header', () => {
    expect(verifyExaSignature('body', '', SECRET)).toBe(false);
  });

  it('rejects malformed header', () => {
    expect(verifyExaSignature('body', 'garbage', SECRET)).toBe(false);
  });

  it('rejects header missing v1', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyExaSignature('body', `t=${ts}`, SECRET)).toBe(false);
  });

  it('rejects header missing timestamp', () => {
    expect(verifyExaSignature('body', 'v1=abc123', SECRET)).toBe(false);
  });
});

describe('createExaSignature', () => {
  it('produces a header with t= and v1= components', () => {
    const header = createExaSignature('test', SECRET);
    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
  });

  it('uses custom timestamp', () => {
    const header = createExaSignature('test', SECRET, 1234567890);
    expect(header).toContain('t=1234567890');
  });
});
