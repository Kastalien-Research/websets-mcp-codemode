// Exa Connect provider catalog — curated, static data so the agent can pick
// providers and shape outputSchema without hallucinating IDs. Only doc-verified
// IDs are marked `active`; "contact-us" providers have id: null, status: 'gated'.
//
// All self-serve IDs below were verified against the Exa Connect partner docs
// on 2026-06-26 (https://exa.ai/docs/reference/agent-api/connect/<partner>.md).
// Note: Affiliate.com's provider ID is `affiliate` (NOT `affiliate_com`).

import { z } from 'zod';
import type { OperationHandler } from './types.js';
import { successResult, errorResult } from './types.js';

export interface ProviderEntry {
  id: string | null;
  label: string;
  category: string;
  status: 'active' | 'gated';
  selfServe: boolean;
  pricePerCall: number | null;
  inputKeys: string[];
  bestEntityTypes: string[];
  notes: string;
}

export const PROVIDER_CATALOG: ProviderEntry[] = [
  { id: 'fiber_ai', label: 'Fiber.ai', category: 'firmographics', status: 'active', selfServe: true, pricePerCall: 0.02, inputKeys: ['domain', 'company_name', 'linkedin_url', 'email'], bestEntityTypes: ['company', 'person'], notes: 'B2B company + people database; headcount, funding stage, contacts.' },
  { id: 'similarweb', label: 'Similarweb', category: 'web-analytics', status: 'active', selfServe: true, pricePerCall: 0.03, inputKeys: ['domain'], bestEntityTypes: ['company'], notes: 'Traffic estimates, global rank, competitors for a domain.' },
  { id: 'baselayer', label: 'Baselayer', category: 'kyb', status: 'active', selfServe: true, pricePerCall: 0.022, inputKeys: ['company_name', 'state'], bestEntityTypes: ['company'], notes: 'US business verification: officers, registrations, risk signals.' },
  { id: 'financial_datasets', label: 'Financial Datasets', category: 'finance-news', status: 'active', selfServe: true, pricePerCall: 0.01, inputKeys: ['ticker'], bestEntityTypes: ['company', 'article'], notes: 'Ticker-based news for US public companies.' },
  { id: 'particle_news', label: 'Particle', category: 'media', status: 'active', selfServe: true, pricePerCall: 0.015, inputKeys: ['person_name', 'topic'], bestEntityTypes: ['person'], notes: 'Podcast transcript search with speaker attribution.' },
  { id: 'affiliate', label: 'Affiliate.com', category: 'commerce', status: 'active', selfServe: true, pricePerCall: 0.015, inputKeys: ['product'], bestEntityTypes: [], notes: 'Product catalog search. Weak fit for entity enrichment.' },
  { id: 'jinko', label: 'Jinko', category: 'travel', status: 'active', selfServe: true, pricePerCall: 0.005, inputKeys: ['airport', 'budget'], bestEntityTypes: [], notes: 'Travel destination discovery. Weak fit for entity enrichment.' },
  { id: 'harmonic', label: 'Harmonic', category: 'startup-intel', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['domain', 'company_name', 'founder'], bestEntityTypes: ['company', 'person'], notes: 'Startup signals: hiring, funding, leadership. ID published; requires activation.' },
  { id: null, label: 'Crunchbase', category: 'private-markets', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['domain', 'company_name'], bestEntityTypes: ['company'], notes: 'Funding, investors, M&A, leadership. Contact Exa to set up.' },
  { id: null, label: 'ZoomInfo', category: 'sales-intel', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['domain', 'company_name', 'email'], bestEntityTypes: ['company', 'person'], notes: 'Contact + firmographic data. Contact Exa to set up.' },
  { id: null, label: 'Intellizence', category: 'market-monitoring', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['company_name'], bestEntityTypes: ['company'], notes: 'Company event signals (M&A, funding, layoffs). Contact Exa.' },
  { id: null, label: 'Kernel', category: 'entity-graph', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['domain', 'company_name'], bestEntityTypes: ['company'], notes: 'Persistent entity IDs + corporate hierarchies. Contact Exa.' },
  { id: null, label: 'DefinitiveHealthcare', category: 'healthcare', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['org_name', 'person_name'], bestEntityTypes: ['company', 'person'], notes: 'Healthcare providers/facilities/physicians. Contact Exa.' },
  { id: null, label: 'Faraday', category: 'consumer-intel', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['person_name'], bestEntityTypes: ['person'], notes: 'Consumer identity + prediction data. Contact Exa.' },
  { id: null, label: 'OpenAlex', category: 'scholarly', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['doi', 'title', 'author'], bestEntityTypes: ['research_paper', 'person'], notes: 'Strongest research_paper/author enricher when ID is available. Contact Exa.' },
  { id: null, label: 'Alpha Vantage', category: 'finance', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['ticker'], bestEntityTypes: ['company'], notes: 'Stock/forex/crypto data. Contact Exa.' },
  { id: null, label: 'DataBento', category: 'market-data', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['ticker'], bestEntityTypes: [], notes: 'Institutional market data (instruments, not entities). Contact Exa.' },
  { id: null, label: 'Traject Data', category: 'serp-commerce', status: 'gated', selfServe: false, pricePerCall: null, inputKeys: ['query'], bestEntityTypes: [], notes: 'SERP + ecommerce data. Weak entity fit. Contact Exa.' },
];

export const Schemas = {
  providers: z.object({
    status: z.enum(['active', 'gated']).optional(),
    entityType: z.string().optional(),
  }),
};

export const providers: OperationHandler = async (args) => {
  try {
    let list = PROVIDER_CATALOG;
    if (args.status) list = list.filter((p) => p.status === args.status);
    if (args.entityType) list = list.filter((p) => p.bestEntityTypes.includes(args.entityType as string));
    return successResult({ count: list.length, providers: list });
  } catch (error) {
    return errorResult('connect.providers', error);
  }
};
