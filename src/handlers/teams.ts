import type { Exa } from 'exa-js';
import { z } from 'zod';
import { OperationHandler, successResult, errorResult } from './types.js';

// `/v0/teams/me` — returns the authenticated team plus current
// concurrency usage and limits. No SDK client exposes it directly;
// drop to `exa.rawRequest`.

export const Schemas = {
  me: z.object({}),
};

function projectTeam(team: Record<string, unknown>): Record<string, unknown> {
  // Pass through unchanged — the spec's shape is small and useful as-is
  // (typically team + concurrency + limits fields). Wrapping for shape
  // stability in case future fields are added.
  return team;
}

export const me: OperationHandler = async (_args, exa) => {
  try {
    const response = await (exa as any).rawRequest('/v0/teams/me', 'GET');
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`teams.me failed: ${response.status} ${body.slice(0, 200)}`);
    }
    const json = await response.json();
    return successResult(projectTeam(json as Record<string, unknown>));
  } catch (error) {
    return errorResult('teams.me', error);
  }
};
