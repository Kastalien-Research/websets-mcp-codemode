import { z } from 'zod';

export const RetrievalBalanceSchema = z.enum(['thesis-heavy', 'antithesis-heavy', 'mixed', 'sparse']);
export type RetrievalBalance = z.infer<typeof RetrievalBalanceSchema>;

const common = {
  timestamp: z.string().optional(),
  blindSpots: z.array(z.string()).optional(),
  websetIds: z.array(z.string()).optional(),
};

/** Legacy runs retain their original meaning; new retrieval runs cannot claim verdict/confidence. */
export const NotebookRunInputSchema = z.union([
  z.object({
    ...common, kind: z.literal('legacy').optional(),
    verdict: z.string(), confidence: z.number(),
    evidenceFor: z.array(z.string()).default([]), evidenceAgainst: z.array(z.string()).default([]),
  }).strict(),
  z.object({
    ...common, kind: z.literal('retrieval'),
    retrievalBalance: RetrievalBalanceSchema, retrievalScore: z.number().min(0).max(1),
    thesisQueryDomains: z.number().int().nonnegative(), antithesisQueryDomains: z.number().int().nonnegative(),
    thesisQueryShare: z.number().min(0).max(1),
    thesisQueryResults: z.array(z.string()).default([]), antithesisQueryResults: z.array(z.string()).default([]),
  }).strict(),
]);
export type NotebookRun = z.infer<typeof NotebookRunInputSchema> & { timestamp: string };
