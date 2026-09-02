// Perplexity Sonar API client — chat-completions access with usage-based cost
// estimation. Standalone (no handler logic), mirroring lib/yelp.ts so the same
// client backs both the perplexity.* operations and the Effect CLI.

const PPLX_BASE_URL = 'https://api.perplexity.ai';

export type PerplexityModel =
  | 'sonar'
  | 'sonar-pro'
  | 'sonar-reasoning-pro'
  | 'sonar-deep-research';

export class PerplexityError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'PerplexityError';
  }
}

function apiKey(): string {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) {
    throw new Error(
      'PERPLEXITY_API_KEY is not set. Add it to your environment (.env) to use perplexity.* operations.',
    );
  }
  return key;
}

// Pricing verified against docs.perplexity.ai/getting-started/pricing on
// 2026-08-15. Token rates are per MILLION tokens; requestFee is the per-request
// search fee at LOW search-context size, per 1k requests (medium/high tiers
// cost more — we default to low). sonar-deep-research bills per search query
// instead; its estimate here covers tokens only and is marked partial.
const PRICING: Record<PerplexityModel, { inPerM: number; outPerM: number; requestFeePer1k: number | null }> = {
  'sonar': { inPerM: 1, outPerM: 1, requestFeePer1k: 5 },
  'sonar-pro': { inPerM: 3, outPerM: 15, requestFeePer1k: 6 },
  'sonar-reasoning-pro': { inPerM: 2, outPerM: 8, requestFeePer1k: 6 },
  'sonar-deep-research': { inPerM: 2, outPerM: 8, requestFeePer1k: null },
};

export interface PerplexityUsage {
  promptTokens: number;
  completionTokens: number;
  estCostDollars: number;
  estIsPartial: boolean;
}

export interface PerplexityAnswer {
  model: string;
  content: string;
  citations: string[];
  usage: PerplexityUsage;
}

export interface AskOptions {
  model?: PerplexityModel;
  systemPrompt?: string;
  maxTokens?: number; // API minimum is 16
  temperature?: number;
}

export function estimateCost(
  model: PerplexityModel,
  promptTokens: number,
  completionTokens: number,
): { dollars: number; partial: boolean } {
  const p = PRICING[model] ?? PRICING['sonar'];
  const tokens = (promptTokens / 1e6) * p.inPerM + (completionTokens / 1e6) * p.outPerM;
  if (p.requestFeePer1k === null) return { dollars: tokens, partial: true };
  return { dollars: tokens + p.requestFeePer1k / 1000, partial: false };
}

export async function perplexityAsk(
  question: string,
  opts: AskOptions = {},
): Promise<PerplexityAnswer> {
  const model = opts.model ?? 'sonar';
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt });
  messages.push({ role: 'user', content: question });

  const res = await fetch(`${PPLX_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      // The API rejects max_tokens below 16.
      max_tokens: Math.max(16, opts.maxTokens ?? 1024),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }),
  });

  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    throw new PerplexityError(
      `Perplexity request failed (${res.status}): ${body?.error?.message ?? 'unknown error'}`,
      res.status,
      body,
    );
  }

  const promptTokens = body?.usage?.prompt_tokens ?? 0;
  const completionTokens = body?.usage?.completion_tokens ?? 0;
  const est = estimateCost(model, promptTokens, completionTokens);

  return {
    model: body?.model ?? model,
    content: body?.choices?.[0]?.message?.content ?? '',
    // The API has returned citations both top-level and per-message over time.
    citations: body?.citations ?? body?.choices?.[0]?.message?.citations ?? [],
    usage: {
      promptTokens,
      completionTokens,
      estCostDollars: +est.dollars.toFixed(6),
      estIsPartial: est.partial,
    },
  };
}
