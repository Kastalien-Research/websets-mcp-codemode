import { WorkflowError } from './helpers.js';

interface SemanticValidationConfig {
  lenses: Array<{ id: string; source: { query?: string; websetId?: string } }>;
  shapes: Array<{ lensId: string }>;
  join: { by: string; minLensOverlap?: number; temporal?: { days?: number } };
  signal: { requires: { type: string; min?: number; sufficient?: string[][] } };
}

/** Shared deterministic checks, run before task insertion and for direct workflow callers. */
export function validateSemanticConfig(config: SemanticValidationConfig, existingWebsets?: Record<string, string>): void {
  // Validate shape lens IDs reference existing lenses
  const lensIds = config.lenses.map(l => l.id);
  for (const shape of config.shapes) {
    if (!lensIds.includes(shape.lensId)) {
      throw new WorkflowError(
        `Shape references unknown lens "${shape.lensId}". Available: ${lensIds.join(', ')}`,
        'validate',
      );
    }
  }

  // Reject configs whose signal/join math is degenerate for the lens count.
  // Targeted at the trap where signal type 'all'/'threshold'/'combination' with
  // a single lens reduces to a vacuous tautology that looks like real cross-lens
  // correlation but isn't. Signal type 'any' is allowed on 1 lens — that's a
  // valid "did anything match shape?" use case, not vacuous.
  const lensCount = config.lenses.length;
  const sigType = config.signal.requires.type;

  if (lensCount < 2 && (sigType === 'all' || sigType === 'threshold' || sigType === 'combination')) {
    throw new WorkflowError(
      `Signal type "${sigType}" requires at least 2 lenses to be meaningful — `
      + `with 1 lens it trivially fires for every shape match. `
      + `Either add a second lens or use signal.requires.type "any".`,
      'validate',
    );
  }

  // Join minLensOverlap is only enforced when the join mode actually produces
  // entities (entity / entity+temporal). cooccurrence and temporal modes return
  // empty entities and don't use minOverlap.
  const joinByEntities = config.join.by === 'entity' || config.join.by === 'entity+temporal';
  if (joinByEntities) {
    const minOverlap = config.join.minLensOverlap ?? 2;
    if (minOverlap > lensCount) {
      throw new WorkflowError(
        `join.minLensOverlap (${minOverlap}) exceeds lens count (${lensCount}). `
        + `No entity can ever satisfy this — signal would never fire.`,
        'validate',
      );
    }
    if (minOverlap < 2 && lensCount >= 2) {
      throw new WorkflowError(
        `join.minLensOverlap must be >= 2 when there are multiple lenses. `
        + `minOverlap=1 makes every single-lens entity satisfy the join, defeating cross-lens correlation.`,
        'validate',
      );
    }
  }

  if (sigType === 'threshold') {
    const min = config.signal.requires.min ?? 2;
    if (min > lensCount) {
      throw new WorkflowError(
        `signal.requires.min (${min}) exceeds lens count (${lensCount}). Signal would never fire.`,
        'validate',
      );
    }
    if (min < 2) {
      throw new WorkflowError(
        `signal.requires.min must be >= 2 for threshold signals. min=1 fires for any single-lens match.`,
        'validate',
      );
    }
  }

  if (sigType === 'combination') {
    const combos = config.signal.requires.sufficient;
    if (!combos || combos.length === 0) {
      throw new WorkflowError(
        `signal.requires.sufficient must be a non-empty array of lens-id combinations for combination signals.`,
        'validate',
      );
    }
    for (const combo of combos) {
      if (!combo || combo.length < 2) {
        throw new WorkflowError(
          `Each combination in signal.requires.sufficient must have at least 2 lens IDs. `
          + `Got: ${JSON.stringify(combo)}`,
          'validate',
        );
      }
      for (const id of combo) {
        if (!lensIds.includes(id)) {
          throw new WorkflowError(
            `Unknown lens ID "${id}" in signal.requires.sufficient. Available: ${lensIds.join(', ')}`,
            'validate',
          );
        }
      }
    }
  }


  for (const lens of config.lenses) {
    if (existingWebsets !== undefined ? !existingWebsets[lens.id] : !lens.source.query && !lens.source.websetId) {
      throw new WorkflowError(existingWebsets !== undefined
        ? `existingWebsets must contain a webset ID for lens "${lens.id}"`
        : `Lens "${lens.id}" requires query or existing webset`, 'validate');
    }
  }
  const days = config.join.temporal?.days;
  if (days !== undefined && (!Number.isFinite(days) || days < 0)) {
    throw new WorkflowError('temporal days must be nonnegative and finite', 'validate');
  }
}
