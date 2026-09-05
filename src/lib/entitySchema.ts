import { z } from 'zod';

/** Entity variants from the Exa Websets provider contract. */
export const EntitySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('company') }),
  z.object({ type: z.literal('person') }),
  z.object({ type: z.literal('article') }),
  z.object({ type: z.literal('research_paper') }),
  z.object({ type: z.literal('custom'), description: z.string().min(1) }),
]);
