// Yelp Fusion operations — curated, atomic wrappers over the business
// discovery endpoints. Handlers return raw Yelp data; the agent decides which
// match to persist via store.attachYelp.

import { z } from 'zod';
import type { OperationHandler } from './types.js';
import { successResult, errorResult } from './types.js';
import { yelpGet } from '../lib/yelp.js';

export const Schemas = {
  search: z
    .object({
      term: z.string().optional(),
      location: z.string().optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      radius: z.number().int().min(1).max(40000).optional(),
      categories: z.string().optional(),
      price: z.string().optional(),
      open_now: z.boolean().optional(),
      sort_by: z.enum(['best_match', 'rating', 'review_count', 'distance']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .refine(
      (v) => Boolean(v.location) || (v.latitude !== undefined && v.longitude !== undefined),
      { message: 'yelp.search requires either `location` or both `latitude` and `longitude`.' },
    ),
  phoneSearch: z.object({ phone: z.string() }),
  match: z.object({
    name: z.string(),
    address1: z.string(),
    city: z.string(),
    state: z.string(),
    country: z.string(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
  }),
  details: z.object({ businessId: z.string() }),
  reviews: z.object({
    businessId: z.string(),
    limit: z.number().int().min(1).max(50).optional(),
    sort_by: z.enum(['yelp_sort', 'newest']).optional(),
  }),
};

export const search: OperationHandler = async (args) => {
  try {
    return successResult(await yelpGet('/v3/businesses/search', args));
  } catch (error) {
    return errorResult('yelp.search', error);
  }
};

export const phoneSearch: OperationHandler = async (args) => {
  try {
    return successResult(await yelpGet('/v3/businesses/search/phone', { phone: args.phone }));
  } catch (error) {
    return errorResult('yelp.phoneSearch', error);
  }
};

export const match: OperationHandler = async (args) => {
  try {
    return successResult(await yelpGet('/v3/businesses/matches', args));
  } catch (error) {
    return errorResult('yelp.match', error);
  }
};

export const details: OperationHandler = async (args) => {
  try {
    const id = encodeURIComponent(args.businessId as string);
    return successResult(await yelpGet(`/v3/businesses/${id}`));
  } catch (error) {
    return errorResult('yelp.details', error);
  }
};

export const reviews: OperationHandler = async (args) => {
  try {
    const id = encodeURIComponent(args.businessId as string);
    const { businessId: _omit, ...query } = args;
    return successResult(await yelpGet(`/v3/businesses/${id}/reviews`, query));
  } catch (error) {
    return errorResult('yelp.reviews', error);
  }
};
