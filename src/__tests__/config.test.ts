import { describe, it, expect } from 'vitest';
import { resolveExaApiKey } from '../config.js';

describe('resolveExaApiKey', () => {
  it('returns the key when EXA_API_KEY is set', () => {
    const result = resolveExaApiKey({ EXA_API_KEY: 'exa_real_key' });
    expect(result.apiKey).toBe('exa_real_key');
    expect(result.warning).toBeUndefined();
  });

  it('throws an actionable error when EXA_API_KEY is unset and no escape hatch', () => {
    expect(() => resolveExaApiKey({})).toThrowError(/EXA_API_KEY/);
    // message must point the user at both the missing var and the escape hatch
    try {
      resolveExaApiKey({});
      throw new Error('expected resolveExaApiKey to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('EXA_API_KEY');
      expect(message).toContain('ALLOW_NO_EXA_KEY');
    }
  });

  it('throws when EXA_API_KEY is blank/whitespace', () => {
    expect(() => resolveExaApiKey({ EXA_API_KEY: '   ' })).toThrowError(/EXA_API_KEY/);
  });

  it('allows keyless boot with a warning when ALLOW_NO_EXA_KEY=1', () => {
    const result = resolveExaApiKey({ ALLOW_NO_EXA_KEY: '1' });
    expect(result.apiKey).toBe('');
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('ALLOW_NO_EXA_KEY');
  });

  it('does not treat ALLOW_NO_EXA_KEY values other than "1" as enabled', () => {
    expect(() => resolveExaApiKey({ ALLOW_NO_EXA_KEY: 'true' })).toThrowError(/EXA_API_KEY/);
  });

  it('prefers a real key even when ALLOW_NO_EXA_KEY is set', () => {
    const result = resolveExaApiKey({ EXA_API_KEY: 'exa_real_key', ALLOW_NO_EXA_KEY: '1' });
    expect(result.apiKey).toBe('exa_real_key');
    expect(result.warning).toBeUndefined();
  });
});
