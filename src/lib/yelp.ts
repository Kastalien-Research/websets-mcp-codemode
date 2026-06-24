// Yelp Fusion API client — authenticated GET access to business endpoints.
// Standalone (no handler logic) so a future OpenAPI generator can reuse it.

const YELP_BASE_URL = 'https://api.yelp.com';

export class YelpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'YelpError';
  }
}

function apiKey(): string {
  const key = process.env.YELP_API_KEY;
  if (!key) {
    throw new Error(
      'YELP_API_KEY is not set. Add it to your environment (.env) to use yelp.* operations.',
    );
  }
  return key;
}

export async function yelpGet(
  path: string,
  query: Record<string, unknown> = {},
): Promise<unknown> {
  const url = new URL(path, YELP_BASE_URL);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      Accept: 'application/json',
    },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new YelpError(
      `Yelp request failed (${res.status}) for ${path}`,
      res.status,
      path,
      body,
    );
  }
  return body;
}
