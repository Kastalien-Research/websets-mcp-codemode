export interface ResolvedExaApiKey {
  apiKey: string;
  /** Set only for keyless boot, to be surfaced as a startup warning. */
  warning?: string;
}

/**
 * Resolve the Exa API key from the environment, failing fast when it is missing.
 *
 * @param env - Environment map (typically `process.env`).
 * @returns The resolved key, or an empty key plus a warning for explicit keyless boot.
 * @throws Error with an actionable message when `EXA_API_KEY` is unset/blank and
 *   `ALLOW_NO_EXA_KEY` is not `"1"`.
 */
export function resolveExaApiKey(env: Record<string, string | undefined>): ResolvedExaApiKey {
  const apiKey = env.EXA_API_KEY?.trim();
  if (apiKey) return { apiKey };

  if (env.ALLOW_NO_EXA_KEY === '1') {
    return {
      apiKey: '',
      warning:
        'EXA_API_KEY is not set; booting without Exa credentials (ALLOW_NO_EXA_KEY=1). '
        + 'Live Exa calls will fail until a key is configured.',
    };
  }

  throw new Error(
    'EXA_API_KEY is not set. Set it in the environment (for example in .env) before '
    + 'starting the server. To boot without credentials for tests or CI, set ALLOW_NO_EXA_KEY=1.',
  );
}
