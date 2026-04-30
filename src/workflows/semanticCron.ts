import type { Exa } from 'exa-js';
import type { TaskStore } from '../lib/taskStore.js';
import { registerWorkflow, type WorkflowMeta } from './types.js';
import {
  createStepTracker,
  isCancelled,
  pollUntilIdle,
  collectItems,
  withSummary,
  WorkflowError,
} from './helpers.js';
import { projectItem } from '../lib/projections.js';
import { diceCoefficient } from './convergent.js';
import { insertSnapshot, getLatestSnapshot, saveWebhookSecret } from '../store/db.js';
import { webhookEventBus, createEvent } from '../webhooks/eventBus.js';

// --- Types ---

interface SemanticCronConfig {
  name?: string;
  proxy?: string;
  lenses: LensConfig[];
  shapes: ShapeConfig[];
  join: JoinConfig;
  signal: SignalConfig;
  monitor?: { cron: string; timezone?: string };
  /** URL of the MCP server for auto-registering Exa webhooks */
  webhookUrl?: string;
  /** Event types to subscribe to (defaults to item.created, item.enriched, idle) */
  webhookEvents?: string[];
}

interface LensConfig {
  id: string;
  source: {
    query?: string;
    websetId?: string;
    entity?: { type: string };
    criteria?: Array<{ description: string }>;
    enrichments?: Array<{
      description: string;
      format?: string;
      options?: Array<{ label: string }>;
    }>;
    count?: number;
  };
}

interface ShapeConfig {
  lensId: string;
  conditions: Condition[];
  logic: 'all' | 'any';
}

interface Condition {
  enrichment: string; // matches enrichment description
  operator: string; // gte|gt|lte|lt|eq|contains|matches|oneOf|exists|withinDays
  value?: number | string | string[];
}

interface JoinConfig {
  by: 'entity' | 'temporal' | 'entity+temporal' | 'cooccurrence';
  entityMatch?: { method?: string; nameThreshold?: number };
  temporal?: { window?: string; days?: number };
  minLensOverlap?: number;
  /**
   * Optional: join on a shaped enrichment value (keyed by description) instead of
   * the canonical Exa-extracted entity name. Items lacking the enrichment value
   * are excluded from the join. Used when canonical entity extraction is
   * unreliable but a strong derivable field exists in enrichments — e.g. when
   * Exa returns publisher companies as the entity but each item carries an
   * extracted "Model name" enrichment that's the real join axis.
   */
  keyEnrichment?: string;
}

interface SignalConfig {
  proxy?: string;
  requires: {
    type: 'all' | 'any' | 'threshold' | 'combination';
    min?: number;
    sufficient?: string[][];
  };
}

// Internal result types

interface LensResult {
  lensId: string;
  websetId: string;
  totalItems: number;
  shapedItems: ShapedItem[];
}

interface ShapedItem {
  id: string;
  name: string;
  url: string;
  entityType: string;
  enrichments: Record<string, unknown>; // description → result value
  createdAt: string;
  projected: Record<string, unknown>;
}

interface JoinedEntity {
  entity: string;
  url: string;
  presentInLenses: string[];
  lensCount: number;
  shapes: Record<string, Record<string, unknown>>; // lensId → enrichment values
}

export interface JoinResult {
  type: string;
  entities: JoinedEntity[];
  lensesWithEvidence: string[];
}

export interface SignalResult {
  fired: boolean;
  satisfiedBy: string[];
  rule: string;
  matchedCombination?: string[];
  entities: string[];
}

interface SnapshotData {
  evaluatedAt: string;
  lenses: Record<
    string,
    {
      websetId: string;
      totalItems: number;
      shapedCount: number;
      shapes: Array<{ name: string; url: string; enrichments: Record<string, unknown> }>;
    }
  >;
  join: JoinResult;
  signal: SignalResult;
}

interface Delta {
  newShapedItems: Record<string, number>;
  newJoins: string[];
  lostJoins: string[];
  signalTransition: {
    was: boolean;
    now: boolean;
    changed: boolean;
    newEntities: string[];
    lostEntities: string[];
  };
  timeSinceLastEval: string;
}

// --- 1. Template Expander ---

export function expandTemplates(
  config: SemanticCronConfig,
  variables: Record<string, string>,
): SemanticCronConfig {
  const json = JSON.stringify(config);
  let expanded = json;
  for (const [key, value] of Object.entries(variables)) {
    expanded = expanded.replaceAll(`{{${key}}}`, value);
  }

  // Check for unresolved templates
  const unresolved = expanded.match(/\{\{[^}]+\}\}/g);
  if (unresolved) {
    throw new WorkflowError(
      `Unresolved template variables: ${[...new Set(unresolved)].join(', ')}`,
      'validate',
    );
  }

  return JSON.parse(expanded) as SemanticCronConfig;
}

// --- 2. Enrichment Resolver + Shape Evaluator ---

export interface ResolvedEnrichment {
  description: string;
  result: string[] | null;
  format: string;
}

export function resolveEnrichmentDescriptions(
  items: Record<string, unknown>[],
  enrichmentMap: Map<string, string>, // enrichmentId → description
): Array<{ item: Record<string, unknown>; enrichments: ResolvedEnrichment[] }> {
  return items.map(item => {
    const rawEnrichments = item.enrichments as
      | Array<{
          enrichmentId: string;
          format: string;
          result: string[] | null;
          status: string;
        }>
      | undefined
      | null;

    if (!rawEnrichments) {
      return { item, enrichments: [] };
    }

    const resolved: ResolvedEnrichment[] = [];
    for (const e of rawEnrichments) {
      const description = enrichmentMap.get(e.enrichmentId);
      if (description) {
        resolved.push({ description, result: e.result, format: e.format });
      }
    }
    return { item, enrichments: resolved };
  });
}

export function evaluateCondition(
  condition: Condition,
  enrichmentResult: string[] | null,
): boolean {
  if (condition.operator === 'exists') {
    return (
      enrichmentResult !== null &&
      enrichmentResult !== undefined &&
      enrichmentResult.length > 0 &&
      enrichmentResult[0].length > 0
    );
  }

  if (
    enrichmentResult === null ||
    enrichmentResult === undefined ||
    enrichmentResult.length === 0
  ) {
    return false;
  }

  const raw = enrichmentResult[0];

  switch (condition.operator) {
    case 'gte':
    case 'gt':
    case 'lte':
    case 'lt':
    case 'eq': {
      const num = Number(raw);
      if (isNaN(num)) return false;
      const target = condition.value as number;
      switch (condition.operator) {
        case 'gte':
          return num >= target;
        case 'gt':
          return num > target;
        case 'lte':
          return num <= target;
        case 'lt':
          return num < target;
        case 'eq':
          return num === target;
      }
      break;
    }
    case 'contains':
      return raw.toLowerCase().includes((condition.value as string).toLowerCase());
    case 'matches':
      return new RegExp(condition.value as string).test(raw);
    case 'oneOf': {
      const options = condition.value as string[];
      return options.some(opt => opt.toLowerCase() === raw.toLowerCase());
    }
    case 'withinDays': {
      const parsed = new Date(raw).getTime();
      if (isNaN(parsed)) return false;
      const days = condition.value as number;
      return Math.abs(Date.now() - parsed) <= days * 86400000;
    }
    default:
      return false;
  }
  return false;
}

export function evaluateShape(
  shape: ShapeConfig,
  enrichments: ResolvedEnrichment[],
): boolean {
  const results = shape.conditions.map(cond => {
    const match = enrichments.find(e => e.description === cond.enrichment);
    return evaluateCondition(cond, match?.result ?? null);
  });

  return shape.logic === 'all' ? results.every(Boolean) : results.some(Boolean);
}

// --- 3. Join Engine ---

function normalizeEnrichmentKey(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed || null;
  }
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

export function joinLensResults(
  lensResults: LensResult[],
  joinConfig: JoinConfig,
): JoinResult {
  const threshold = joinConfig.entityMatch?.nameThreshold ?? 0.85;
  const minOverlap = joinConfig.minLensOverlap ?? 2;
  const temporalDays = joinConfig.temporal?.days;

  if (joinConfig.by === 'cooccurrence') {
    return joinByCooccurrence(lensResults, temporalDays);
  }

  if (joinConfig.by === 'temporal') {
    return joinByTemporal(lensResults, temporalDays ?? 7);
  }

  // Entity or entity+temporal
  const entityMap = new Map<
    string,
    {
      entity: string;
      url: string;
      lenses: Set<string>;
      shapes: Record<string, Record<string, unknown>>;
      timestamps: Array<{ lensId: string; createdAt: string }>;
    }
  >();

  const keyEnrichment = joinConfig.keyEnrichment;
  const fuzzyEnabled = joinConfig.entityMatch?.method !== 'exact';

  for (const lr of lensResults) {
    for (const si of lr.shapedItems) {
      // Derive the join key. In keyEnrichment mode, items missing the value are skipped.
      let joinKey: string | null;
      if (keyEnrichment) {
        joinKey = normalizeEnrichmentKey(si.enrichments[keyEnrichment]);
        if (!joinKey) continue;
      } else {
        joinKey = si.name;
      }

      let matched = false;

      for (const [, existing] of entityMap) {
        if (keyEnrichment) {
          // Match on the enrichment value: case-insensitive exact, plus optional fuzzy.
          const a = joinKey!.toLowerCase();
          const b = existing.entity.toLowerCase();
          const isMatch =
            a === b ||
            (fuzzyEnabled && diceCoefficient(joinKey!, existing.entity) > threshold);
          if (isMatch) {
            existing.lenses.add(lr.lensId);
            existing.shapes[lr.lensId] = si.enrichments;
            existing.timestamps.push({ lensId: lr.lensId, createdAt: si.createdAt });
            matched = true;
            break;
          }
          continue;
        }

        // Default mode: URL exact match
        if (si.url && existing.url && si.url === existing.url) {
          existing.lenses.add(lr.lensId);
          existing.shapes[lr.lensId] = si.enrichments;
          existing.timestamps.push({ lensId: lr.lensId, createdAt: si.createdAt });
          matched = true;
          break;
        }
        // Default mode: name fuzzy match
        if (si.name && existing.entity && diceCoefficient(si.name, existing.entity) > threshold) {
          existing.lenses.add(lr.lensId);
          existing.shapes[lr.lensId] = si.enrichments;
          existing.timestamps.push({ lensId: lr.lensId, createdAt: si.createdAt });
          matched = true;
          break;
        }
      }

      if (!matched) {
        const mapKey = keyEnrichment ? joinKey! : (si.url || si.name || si.id);
        entityMap.set(mapKey, {
          entity: keyEnrichment ? joinKey! : si.name,
          url: si.url,
          lenses: new Set([lr.lensId]),
          shapes: { [lr.lensId]: si.enrichments },
          timestamps: [{ lensId: lr.lensId, createdAt: si.createdAt }],
        });
      }
    }
  }

  let entities: JoinedEntity[] = [...entityMap.values()].map(e => ({
    entity: e.entity,
    url: e.url,
    presentInLenses: [...e.lenses],
    lensCount: e.lenses.size,
    shapes: e.shapes,
  }));

  // entity+temporal: filter by temporal window
  if (joinConfig.by === 'entity+temporal' && temporalDays) {
    const windowMs = temporalDays * 86400000;
    entities = entities.filter(ent => {
      // Find underlying timestamps from entityMap
      const entry = [...entityMap.values()].find(
        e => e.entity === ent.entity && e.url === ent.url,
      );
      if (!entry) return false;

      // Check if any two items from different lenses are within window
      const ts = entry.timestamps;
      for (let i = 0; i < ts.length; i++) {
        for (let j = i + 1; j < ts.length; j++) {
          if (ts[i].lensId !== ts[j].lensId) {
            const diff = Math.abs(
              new Date(ts[i].createdAt).getTime() - new Date(ts[j].createdAt).getTime(),
            );
            if (diff <= windowMs) return true;
          }
        }
      }
      return false;
    });
  }

  // Filter by minLensOverlap
  entities = entities.filter(e => e.lensCount >= minOverlap);

  const lensesWithEvidence = [...new Set(entities.flatMap(e => e.presentInLenses))];

  return { type: joinConfig.by, entities, lensesWithEvidence };
}

function joinByCooccurrence(
  lensResults: LensResult[],
  temporalDays?: number,
): JoinResult {
  let lensesWithEvidence: string[];

  if (temporalDays) {
    // Only count lenses whose shaped items fall within the window relative to earliest
    const allTimestamps: Array<{ lensId: string; time: number }> = [];
    for (const lr of lensResults) {
      for (const si of lr.shapedItems) {
        allTimestamps.push({ lensId: lr.lensId, time: new Date(si.createdAt).getTime() });
      }
    }

    if (allTimestamps.length === 0) {
      return { type: 'cooccurrence', entities: [], lensesWithEvidence: [] };
    }

    const earliest = Math.min(...allTimestamps.map(t => t.time));
    const windowMs = temporalDays * 86400000;
    const qualifying = allTimestamps.filter(t => t.time - earliest <= windowMs);
    lensesWithEvidence = [...new Set(qualifying.map(t => t.lensId))];
  } else {
    lensesWithEvidence = lensResults
      .filter(lr => lr.shapedItems.length > 0)
      .map(lr => lr.lensId);
  }

  return { type: 'cooccurrence', entities: [], lensesWithEvidence };
}

function joinByTemporal(
  lensResults: LensResult[],
  days: number,
): JoinResult {
  const windowMs = days * 86400000;
  const lensTimes = new Map<string, number[]>();

  for (const lr of lensResults) {
    const times = lr.shapedItems.map(si => new Date(si.createdAt).getTime());
    if (times.length > 0) {
      lensTimes.set(lr.lensId, times);
    }
  }

  const qualifying = new Set<string>();
  const lensIds = [...lensTimes.keys()];

  for (let i = 0; i < lensIds.length; i++) {
    for (let j = i + 1; j < lensIds.length; j++) {
      const timesA = lensTimes.get(lensIds[i])!;
      const timesB = lensTimes.get(lensIds[j])!;

      for (const ta of timesA) {
        for (const tb of timesB) {
          if (Math.abs(ta - tb) <= windowMs) {
            qualifying.add(lensIds[i]);
            qualifying.add(lensIds[j]);
          }
        }
      }
    }
  }

  return { type: 'temporal', entities: [], lensesWithEvidence: [...qualifying] };
}

// --- 4. Signal Evaluator ---

export function evaluateSignal(
  joinResult: JoinResult,
  signalConfig: SignalConfig,
  allLensIds: string[],
): SignalResult {
  // Validate combination lens IDs
  if (signalConfig.requires.type === 'combination') {
    const combos = signalConfig.requires.sufficient;
    if (!combos || combos.length === 0) {
      throw new WorkflowError(
        'signal.requires.sufficient must be provided for combination type',
        'validate',
      );
    }
    for (const combo of combos) {
      for (const lensId of combo) {
        if (!allLensIds.includes(lensId)) {
          throw new WorkflowError(
            `Unknown lens ID "${lensId}" in signal.requires.sufficient. Available: ${allLensIds.join(', ')}`,
            'validate',
          );
        }
      }
    }
  }

  const hasEntities = joinResult.entities.length > 0;

  if (hasEntities) {
    return evaluateSignalWithEntities(joinResult, signalConfig, allLensIds);
  }
  return evaluateSignalWithEvidence(joinResult, signalConfig, allLensIds);
}

function evaluateSignalWithEntities(
  joinResult: JoinResult,
  signalConfig: SignalConfig,
  allLensIds: string[],
): SignalResult {
  const { type, min, sufficient } = signalConfig.requires;

  let matchingEntities: JoinedEntity[];

  switch (type) {
    case 'all':
      matchingEntities = joinResult.entities.filter(
        e => allLensIds.every(id => e.presentInLenses.includes(id)),
      );
      break;
    case 'any':
      matchingEntities = joinResult.entities;
      break;
    case 'threshold':
      matchingEntities = joinResult.entities.filter(e => e.lensCount >= (min ?? 2));
      break;
    case 'combination': {
      matchingEntities = [];
      let matchedCombo: string[] | undefined;
      for (const combo of sufficient!) {
        const matching = joinResult.entities.filter(e =>
          combo.every(lensId => e.presentInLenses.includes(lensId)),
        );
        if (matching.length > 0) {
          matchingEntities = matching;
          matchedCombo = combo;
          break;
        }
      }
      const fired = matchingEntities.length > 0;
      return {
        fired,
        satisfiedBy: [...new Set(matchingEntities.flatMap(e => e.presentInLenses))],
        rule: type,
        matchedCombination: matchedCombo,
        entities: matchingEntities.map(e => e.entity),
      };
    }
  }

  const fired = matchingEntities.length > 0;
  return {
    fired,
    satisfiedBy: [...new Set(matchingEntities.flatMap(e => e.presentInLenses))],
    rule: type,
    entities: matchingEntities.map(e => e.entity),
  };
}

function evaluateSignalWithEvidence(
  joinResult: JoinResult,
  signalConfig: SignalConfig,
  allLensIds: string[],
): SignalResult {
  const evidence = joinResult.lensesWithEvidence;
  const { type, min, sufficient } = signalConfig.requires;

  let fired: boolean;
  let matchedCombination: string[] | undefined;

  switch (type) {
    case 'all':
      fired = allLensIds.every(id => evidence.includes(id));
      break;
    case 'any':
      fired = evidence.length > 0;
      break;
    case 'threshold':
      fired = evidence.length >= (min ?? 2);
      break;
    case 'combination':
      fired = false;
      for (const combo of sufficient!) {
        if (combo.every(lensId => evidence.includes(lensId))) {
          fired = true;
          matchedCombination = combo;
          break;
        }
      }
      break;
  }

  const result: SignalResult = {
    fired,
    satisfiedBy: evidence,
    rule: type,
    entities: [],
  };
  if (matchedCombination) result.matchedCombination = matchedCombination;
  return result;
}

// --- 5. Delta Computer ---

export function computeDelta(
  current: SnapshotData,
  previous: SnapshotData,
): Delta {
  // New shaped items per lens
  const newShapedItems: Record<string, number> = {};
  for (const [lensId, lens] of Object.entries(current.lenses)) {
    const prevCount = previous.lenses[lensId]?.shapedCount ?? 0;
    newShapedItems[lensId] = Math.max(0, lens.shapedCount - prevCount);
  }

  // New/lost joins by entity name (URL fallback)
  const currentEntityKeys = new Set(
    current.join.entities.map(e => e.url || e.entity),
  );
  const previousEntityKeys = new Set(
    previous.join.entities.map(e => e.url || e.entity),
  );

  const newJoins = [...currentEntityKeys].filter(k => !previousEntityKeys.has(k));
  const lostJoins = [...previousEntityKeys].filter(k => !currentEntityKeys.has(k));

  // Signal transition
  const currentEntityNames = new Set(current.signal.entities);
  const previousEntityNames = new Set(previous.signal.entities);

  const signalTransition = {
    was: previous.signal.fired,
    now: current.signal.fired,
    changed: previous.signal.fired !== current.signal.fired,
    newEntities: [...currentEntityNames].filter(n => !previousEntityNames.has(n)),
    lostEntities: [...previousEntityNames].filter(n => !currentEntityNames.has(n)),
  };

  // Time since last eval
  const prevTime = new Date(previous.evaluatedAt).getTime();
  const currTime = new Date(current.evaluatedAt).getTime();
  const diffMs = currTime - prevTime;
  const timeSinceLastEval = formatDuration(diffMs);

  return { newShapedItems, newJoins, lostJoins, signalTransition, timeSinceLastEval };
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

// --- 6. Snapshot Builder ---

export function buildSnapshot(
  lensResults: LensResult[],
  joinResult: JoinResult,
  signalResult: SignalResult,
  websetIds: Record<string, string>,
): SnapshotData {
  const lenses: SnapshotData['lenses'] = {};
  for (const lr of lensResults) {
    lenses[lr.lensId] = {
      websetId: websetIds[lr.lensId],
      totalItems: lr.totalItems,
      shapedCount: lr.shapedItems.length,
      shapes: lr.shapedItems.map(si => ({
        name: si.name,
        url: si.url,
        enrichments: si.enrichments,
      })),
    };
  }

  return {
    evaluatedAt: new Date().toISOString(),
    lenses,
    join: joinResult,
    signal: signalResult,
  };
}

// --- 6b. Signal-state event emission ---

/**
 * Decide whether a signal-state event should be published, and publish it.
 *
 * Fires `semantic-cron.signal-fired` when:
 *   - Previous snapshot was not fired and current is fired (new fire), OR
 *   - Both fired, but current has at least one entity not in the previous (spread).
 *
 * Fires `semantic-cron.signal-resolved` when the signal transitions
 * fired → not fired.
 *
 * Stays silent for steady-state continued fires and steady-state non-fires.
 */
export function emitSignalStateEvents(
  configName: string | undefined,
  current: SnapshotData,
  previous: SnapshotData | undefined,
  taskId: string,
): void {
  const wasFired = previous?.signal?.fired === true;
  const nowFired = current.signal.fired === true;

  // Treat absent previous snapshot as "was: false" — first run with a fire is
  // a new fire from the system's perspective.
  const transitionToFired = !wasFired && nowFired;
  const transitionToResolved = wasFired && !nowFired;

  // Spread detection: still fired, but current has entities the previous didn't.
  let newEntities: string[] = [];
  if (wasFired && nowFired && previous) {
    const prevEntities = new Set(previous.signal.entities ?? []);
    newEntities = (current.signal.entities ?? []).filter(e => !prevEntities.has(e));
  }
  const transitionBySpread = wasFired && nowFired && newEntities.length > 0;

  let reason: 'new-fire' | 'spread' | null = null;
  if (transitionToFired) reason = 'new-fire';
  else if (transitionBySpread) reason = 'spread';

  if (reason) {
    try {
      webhookEventBus.publish(createEvent({
        id: `semantic-cron-fire_${taskId}_${Date.now()}`,
        type: 'semantic-cron.signal-fired',
        configName,
        taskId,
        reason,
        transition: {
          was: wasFired,
          now: nowFired,
          newEntities: reason === 'new-fire'
            ? (current.signal.entities ?? [])
            : newEntities,
          lostEntities: [],
        },
        snapshot: current,
      }));
    } catch {
      // Event-bus failure is non-fatal; the snapshot is still persisted.
    }
    return;
  }

  if (transitionToResolved && previous) {
    const currentEntities = new Set(current.signal.entities ?? []);
    const lostEntities = (previous.signal.entities ?? []).filter(e => !currentEntities.has(e));
    try {
      webhookEventBus.publish(createEvent({
        id: `semantic-cron-resolve_${taskId}_${Date.now()}`,
        type: 'semantic-cron.signal-resolved',
        configName,
        taskId,
        transition: {
          was: wasFired,
          now: nowFired,
          newEntities: [],
          lostEntities,
        },
        snapshot: current,
      }));
    } catch {
      // Non-fatal.
    }
  }
}

// --- 7. Main Workflow ---

async function semanticCronWorkflow(
  taskId: string,
  args: Record<string, unknown>,
  exa: Exa,
  store: TaskStore,
): Promise<unknown> {
  const startTime = Date.now();
  const tracker = createStepTracker();

  const rawConfig = args.config as SemanticCronConfig;
  const variables = args.variables as Record<string, string> | undefined;
  const existingWebsets = args.existingWebsets as Record<string, string> | undefined;
  // Default poll deadline: 60 minutes. Real websets routinely take 10-30
  // minutes on non-trivial queries; the previous 5-minute default would treat
  // most production runs as timeouts. Callers needing a hard cap should pass
  // `timeout` explicitly.
  const timeoutMs = (args.timeout as number) ?? 60 * 60 * 1000;

  // Load previous snapshot from args or SQLite
  let previousSnapshot = args.previousSnapshot as SnapshotData | undefined;
  if (!previousSnapshot && rawConfig.name) {
    try {
      const stored = getLatestSnapshot(rawConfig.name);
      if (stored) previousSnapshot = stored as SnapshotData;
    } catch (err) {
      console.error(
        `[semanticCron] Failed to load previous snapshot for "${rawConfig.name}" `
        + `from SQLite. Continuing without prior state — every fired signal will `
        + `look like a fresh transition.`,
        err,
      );
    }
  }

  // Step: Validate + expand templates
  const step0 = Date.now();
  store.updateProgress(taskId, { step: 'validating', completed: 0, total: 8 });

  if (!rawConfig || !rawConfig.lenses || rawConfig.lenses.length === 0) {
    throw new WorkflowError('config.lenses is required and must be non-empty', 'validate');
  }
  if (!rawConfig.shapes || rawConfig.shapes.length === 0) {
    throw new WorkflowError('config.shapes is required and must be non-empty', 'validate');
  }
  if (!rawConfig.join) {
    throw new WorkflowError('config.join is required', 'validate');
  }
  if (!rawConfig.signal) {
    throw new WorkflowError('config.signal is required', 'validate');
  }

  const config = variables ? expandTemplates(rawConfig, variables) : rawConfig;

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

  // config.name is load-bearing for snapshot persistence, delta computation, and
  // replay. Without it, every run looks like a fresh signal-fired transition.
  // Warn loudly rather than reject — existing demo configs may not set it, and
  // it's easier to fix downstream than to break callers.
  if (!config.name || config.name.trim().length === 0) {
    console.warn(
      `[semanticCron] config.name is unset — snapshot persistence, delta `
      + `computation, and replay will be skipped. Every fired signal will look `
      + `like a fresh transition. Set config.name to a stable string to enable `
      + `state tracking across runs.`,
    );
  }

  tracker.track('validate', step0);

  if (isCancelled(taskId, store)) return null;

  const isReeval = !!existingWebsets;
  const websetIds: Record<string, string> = existingWebsets ? { ...existingWebsets } : {};
  const enrichmentMaps: Record<string, Map<string, string>> = {}; // lensId → Map<enrichmentId, description>

  // Step: Create or fetch websets
  const totalLenses = config.lenses.length;

  if (!isReeval) {
    // Initial run: create websets
    for (let i = 0; i < config.lenses.length; i++) {
      const stepStart = Date.now();
      const lens = config.lenses[i];

      store.updateProgress(taskId, {
        step: `creating lens ${i + 1}/${totalLenses}: ${lens.id}`,
        completed: 1,
        total: 8,
      });

      if (isCancelled(taskId, store)) {
        // Cancel any already-created websets
        for (const id of Object.values(websetIds)) {
          await exa.websets.cancel(id);
        }
        return null;
      }

      let webset: any;

      if (lens.source.websetId) {
        websetIds[lens.id] = lens.source.websetId;
        webset = await exa.websets.get(lens.source.websetId);
      } else {
        const createParams: Record<string, unknown> = {
          search: {
            query: lens.source.query,
            count: lens.source.count ?? 50,
          },
        };

        const search = createParams.search as Record<string, unknown>;
        if (lens.source.entity) search.entity = lens.source.entity;
        if (lens.source.criteria) search.criteria = lens.source.criteria;
        if (lens.source.enrichments) {
          createParams.enrichments = lens.source.enrichments;
        }

        webset = await exa.websets.create(createParams as any);
        websetIds[lens.id] = webset.id;
      }

      // Extract enrichment id → description map
      const enrichmentDefs = webset.enrichments as
        | Array<{ id: string; description: string }>
        | undefined;
      const map = new Map<string, string>();
      if (enrichmentDefs) {
        for (const def of enrichmentDefs) {
          map.set(def.id, def.description);
        }
      }
      enrichmentMaps[lens.id] = map;

      tracker.track(`create-${lens.id}`, stepStart);
    }
  } else {
    // Re-eval: fetch existing websets for enrichment definitions
    for (let i = 0; i < config.lenses.length; i++) {
      const lens = config.lenses[i];
      const wsId = websetIds[lens.id];
      if (!wsId) {
        throw new WorkflowError(
          `existingWebsets missing ID for lens "${lens.id}"`,
          'validate',
        );
      }

      store.updateProgress(taskId, {
        step: `fetching lens ${i + 1}/${totalLenses}: ${lens.id}`,
        completed: 1,
        total: 8,
      });

      const webset = await exa.websets.get(wsId);
      const enrichmentDefs = webset.enrichments as
        | Array<{ id: string; description: string }>
        | undefined;
      const map = new Map<string, string>();
      if (enrichmentDefs) {
        for (const def of enrichmentDefs) {
          map.set(def.id, def.description);
        }
      }
      enrichmentMaps[lens.id] = map;
    }
  }

  // Register Exa webhooks (initial run only, non-fatal). webhookUrl resolves
  // explicit config first, then WEBSETS_PUBLIC_URL env var so callers don't
  // need to pass it on every invocation when the server has a stable
  // publicly-reachable URL (codespace public port, ngrok, prod host, etc).
  const webhookUrl = config.webhookUrl ?? process.env.WEBSETS_PUBLIC_URL;
  if (!isReeval && webhookUrl) {
    const targetUrl = `${webhookUrl}/webhooks/exa`;
    const whEvents = config.webhookEvents ?? [
      'webset.item.created',
      'webset.item.enriched',
      'webset.idle',
    ];
    try {
      // Idempotency: skip creation if a webhook already exists for this URL.
      // This stops every initial run from accumulating duplicate webhooks
      // pointing at the same receiver.
      let alreadyRegistered = false;
      try {
        for await (const existing of exa.websets.webhooks.listAll()) {
          if ((existing as { url?: string }).url === targetUrl) {
            alreadyRegistered = true;
            break;
          }
        }
      } catch (err) {
        console.warn(
          `[semanticCron] Could not list existing Exa webhooks before creating; `
          + `proceeding with create (may duplicate).`,
          err,
        );
      }

      if (!alreadyRegistered) {
        const response = await exa.websets.webhooks.create({
          url: targetUrl,
          events: whEvents,
        } as any);
        const raw = response as unknown as Record<string, unknown>;
        const id = raw.id as string | undefined;
        const secret = raw.secret as string | undefined;
        if (id && secret) {
          saveWebhookSecret(id, secret, raw.url as string | undefined);
        } else {
          console.warn(
            `[semanticCron] webhooks.create returned without an id+secret pair `
            + `(id=${id ?? 'unknown'}). Signature verification will not work `
            + `for events from this webhook.`,
          );
        }
      }
    } catch (err) {
      console.error(
        `Failed to register Exa webhook at ${targetUrl} for events `
        + `${whEvents.join(',')}. Webhook events will not be delivered until this `
        + `is resolved.`,
        err,
      );
    }
  }

  if (isCancelled(taskId, store)) {
    if (!isReeval) {
      for (const id of Object.values(websetIds)) {
        await exa.websets.cancel(id);
      }
    }
    return null;
  }

  // Step: Poll websets (initial run only)
  if (!isReeval) {
    for (let i = 0; i < config.lenses.length; i++) {
      const lens = config.lenses[i];
      if (lens.source.websetId) continue; // pre-existing webset, already idle

      const stepStart = Date.now();
      store.updateProgress(taskId, {
        step: `polling lens ${i + 1}/${totalLenses}: ${lens.id}`,
        completed: 2,
        total: 8,
      });

      const pollResult = await pollUntilIdle({
        exa,
        websetId: websetIds[lens.id],
        taskId,
        store,
        timeoutMs,
        stepNum: 2,
        totalSteps: 8,
      });

      if (pollResult.timedOut) {
        throw new WorkflowError(
          `Lens "${lens.id}" (websetId=${websetIds[lens.id]}) did not reach `
          + `idle within ${Math.round(timeoutMs / 1000)}s. Pass a larger `
          + `\`timeout\` arg if this is expected, or check the webset directly. `
          + `Refusing to proceed with partial item data.`,
          'poll',
        );
      }

      tracker.track(`poll-${lens.id}`, stepStart);

      if (isCancelled(taskId, store)) {
        for (const id of Object.values(websetIds)) {
          await exa.websets.cancel(id);
        }
        return null;
      }
    }
  }

  // Step: Collect items + resolve enrichments + evaluate shapes
  const stepCollect = Date.now();
  store.updateProgress(taskId, { step: 'collecting items', completed: 3, total: 8 });

  const lensResults: LensResult[] = [];

  for (const lens of config.lenses) {
    const wsId = websetIds[lens.id];
    const rawItems = await collectItems(exa, wsId);

    // Filter to items with satisfied evaluation
    const passingItems = rawItems.filter(item => {
      const evaluations = item.evaluations as
        | Array<{ satisfied: string }>
        | undefined;
      if (!evaluations || evaluations.length === 0) return true;
      return evaluations.some(e => e.satisfied === 'yes');
    });

    // Resolve enrichment descriptions
    const resolved = resolveEnrichmentDescriptions(passingItems, enrichmentMaps[lens.id]);

    // Apply shape evaluation
    const shapesForLens = config.shapes.filter(s => s.lensId === lens.id);

    const shapedItems: ShapedItem[] = [];
    for (const { item, enrichments } of resolved) {
      // Check if item passes any of the shapes for this lens
      const passes =
        shapesForLens.length === 0 ||
        shapesForLens.some(shape => evaluateShape(shape, enrichments));

      if (passes) {
        const projected = projectItem(item);
        const enrichmentValues: Record<string, unknown> = {};
        for (const e of enrichments) {
          enrichmentValues[e.description] = e.result?.[0] ?? null;
        }

        shapedItems.push({
          id: (item.id as string) ?? '',
          name: (projected.name as string) ?? '',
          url: (projected.url as string) ?? '',
          entityType: (projected.entityType as string) ?? '',
          enrichments: enrichmentValues,
          createdAt: (item.createdAt as string) ?? new Date().toISOString(),
          projected,
        });
      }
    }

    lensResults.push({
      lensId: lens.id,
      websetId: wsId,
      totalItems: rawItems.length,
      shapedItems,
    });
  }

  tracker.track('collect-shape', stepCollect);

  if (isCancelled(taskId, store)) return null;

  // Step: Join
  const stepJoin = Date.now();
  store.updateProgress(taskId, { step: 'joining lenses', completed: 5, total: 8 });
  const joinResult = joinLensResults(lensResults, config.join);
  tracker.track('join', stepJoin);

  // Step: Evaluate signal
  const stepSignal = Date.now();
  store.updateProgress(taskId, { step: 'evaluating signal', completed: 6, total: 8 });
  const signalResult = evaluateSignal(joinResult, config.signal, lensIds);
  tracker.track('signal', stepSignal);

  // Step: Build snapshot
  const snapshot = buildSnapshot(lensResults, joinResult, signalResult, websetIds);

  // Persist snapshot to SQLite
  if (config.name) {
    try {
      insertSnapshot(config.name, snapshot);
    } catch (err) {
      console.error(
        `[semanticCron] Failed to persist snapshot for "${config.name}" to `
        + `SQLite. The next run will not see this snapshot as the "previous" `
        + `state, so signal transitions may be misreported.`,
        err,
      );
    }
  }

  // Emit signal-state events to the bus.
  // signal-fired is published when:
  //   (a) the signal transitions false → true, or
  //   (b) the signal is true and at least one new entity has joined since the
  //       previous snapshot (substrate spread).
  // signal-resolved is published when the signal transitions true → false.
  // Subscribers (e.g. the websets-channel) can route on these directly.
  emitSignalStateEvents(config.name, snapshot, previousSnapshot, taskId);

  // Step: Create monitors (initial run only, non-fatal)
  if (!isReeval && config.monitor) {
    const stepMon = Date.now();
    store.updateProgress(taskId, { step: 'creating monitors', completed: 7, total: 8 });

    for (const lens of config.lenses) {
      try {
        await (exa.websets.monitors as any).create(websetIds[lens.id], {
          schedule: {
            cron: config.monitor.cron,
            timezone: config.monitor.timezone,
          },
        });
      } catch (err) {
        console.error(
          `[semanticCron] Failed to create monitor for lens "${lens.id}" `
          + `(websetId=${websetIds[lens.id]}) with cron="${config.monitor.cron}". `
          + `This lens will not auto-rerun on schedule.`,
          err,
        );
      }
    }
    tracker.track('monitors', stepMon);
  }

  store.updateProgress(taskId, { step: 'complete', completed: 8, total: 8 });

  const duration = Date.now() - startTime;

  // Build result
  const totalShaped = lensResults.reduce((sum, lr) => sum + lr.shapedItems.length, 0);
  const totalItems = lensResults.reduce((sum, lr) => sum + lr.totalItems, 0);

  const result: Record<string, unknown> = {
    websetIds,
    snapshot,
    duration,
    steps: tracker.steps,
  };

  if (isReeval && previousSnapshot) {
    result.delta = computeDelta(snapshot, previousSnapshot);
  }

  const signalStr = signalResult.fired
    ? `FIRED (${signalResult.entities.length} entities)`
    : 'not fired';

  return withSummary(
    result,
    `${totalLenses} lenses, ${totalItems} items → ${totalShaped} shaped, ${joinResult.entities.length} joined entities, signal: ${signalStr} in ${(duration / 1000).toFixed(0)}s`,
  );
}

const meta: WorkflowMeta = {
  title: 'Semantic Cron',
  description: 'Multi-lens monitoring system. Creates parallel websets (lenses) to observe different facets, evaluates items against shape conditions on enrichment values, joins results across lenses by entity or temporal proximity, and fires a composite signal when conditions are met. Supports template variables, snapshot persistence, delta computation, and webhook auto-registration.',
  category: 'monitoring',
  parameters: [
    { name: 'config', type: 'object', required: true, description: 'Full monitoring config with lenses, shapes, join, signal, and optional monitor/webhook settings' },
    { name: 'variables', type: 'object', required: false, description: 'Template variable substitution for {{var}} placeholders in config' },
    { name: 'existingWebsets', type: 'object', required: false, description: 'Map of lensId to websetId for re-evaluation of existing websets' },
    { name: 'timeout', type: 'number', required: false, description: 'Timeout in milliseconds', default: 300000 },
    { name: 'previousSnapshot', type: 'object', required: false, description: 'Previous snapshot for manual delta computation' },
  ],
  steps: [
    'Validate config and expand template variables',
    'Create or fetch websets for each lens',
    'Register Exa webhooks (initial run only)',
    'Poll all websets until idle',
    'Collect items, resolve enrichment descriptions, evaluate shape conditions',
    'Join lens results by entity, temporal proximity, or cooccurrence',
    'Evaluate composite signal (all/any/threshold/combination)',
    'Build and persist snapshot to SQLite',
    'Create monitors for recurring evaluation (if configured)',
  ],
  output: 'Webset IDs per lens, full snapshot (lenses with shaped items, join result with matched entities, signal result with fired/satisfiedBy), delta against previous snapshot (if re-evaluation), and step timings.',
  example: `await callOperation('tasks.create', {\n  type: 'semantic.cron',\n  args: {\n    config: {\n      name: 'design-partner-radar',\n      lenses: [\n        { id: 'hiring', source: { query: '{{company}} hiring AI engineers', entity: { type: 'company' }, enrichments: [{ description: 'Number of open AI roles', format: 'number' }], count: 30 } },\n        { id: 'funding', source: { query: '{{company}} raised funding 2024', entity: { type: 'company' }, enrichments: [{ description: 'Funding amount', format: 'text' }], count: 30 } },\n      ],\n      shapes: [\n        { lensId: 'hiring', conditions: [{ enrichment: 'Number of open AI roles', operator: 'gte', value: 3 }], logic: 'all' },\n        { lensId: 'funding', conditions: [{ enrichment: 'Funding amount', operator: 'exists' }], logic: 'all' },\n      ],\n      join: { by: 'entity', minLensOverlap: 2 },\n      signal: { requires: { type: 'all' } },\n    },\n    variables: { company: 'AI startup' },\n  }\n});`,
  relatedWorkflows: ['lifecycle.harvest', 'verify.enrichments'],
  tags: ['monitoring', 'cron', 'lenses', 'shapes', 'join', 'signal', 'delta', 'snapshot', 'webhook'],
};

// Register
registerWorkflow('semantic.cron', semanticCronWorkflow, meta);

// --- 8. Replay Workflow ---
// Loads a persisted snapshot and re-publishes `semantic-cron.signal-fired`
// against it as if the cron had just fired. Used for demos / rehearsal where
// you need a deterministic, fast, on-demand fire from real prior data.

async function semanticCronReplayWorkflow(
  taskId: string,
  args: Record<string, unknown>,
  _exa: Exa,
  _store: TaskStore,
): Promise<unknown> {
  const configName = args.configName as string | undefined;
  const inlineSnapshot = args.snapshot as SnapshotData | undefined;

  if (!configName && !inlineSnapshot) {
    throw new WorkflowError(
      'semantic.cron.replay requires either configName or snapshot',
      'validate',
    );
  }

  let snapshot: SnapshotData;
  if (inlineSnapshot) {
    // Demo path: caller supplies the snapshot directly. Useful when SQLite
    // doesn't have one (fresh deployment) or when bundling a known snapshot
    // with a recording for guaranteed reproducibility.
    snapshot = inlineSnapshot;
  } else {
    const snapshotRaw = getLatestSnapshot(configName!);
    if (!snapshotRaw) {
      throw new WorkflowError(
        `no snapshot found for config "${configName}"`,
        'validate',
      );
    }
    snapshot = snapshotRaw as SnapshotData;
  }

  // Treat replay as a fresh fire: prior state is synthetic "not fired", so
  // emitSignalStateEvents publishes signal-fired with reason: "new-fire".
  const effectiveName = configName ?? 'inline-replay';
  emitSignalStateEvents(effectiveName, snapshot, undefined, taskId);

  return withSummary(
    {
      configName: effectiveName,
      replayed: true,
      source: inlineSnapshot ? 'inline' : 'sqlite',
      signal: snapshot.signal,
      joinedEntities: snapshot.join.entities.map(e => e.entity),
    },
    `replayed ${effectiveName} snapshot — signal: ${
      snapshot.signal.fired ? `FIRED (${snapshot.signal.entities.length} entities)` : 'not fired'
    }`,
  );
}

const replayMeta: WorkflowMeta = {
  title: 'Semantic Cron — Replay',
  description: 'Re-publish a signal-fired event from a persisted snapshot. Used for deterministic demos: load the latest stored snapshot for a named config and emit `semantic-cron.signal-fired` to the webhook event bus, so subscribers (channels, action routes) react as if a fresh fire just occurred. Detection is canned (the snapshot was generated by an earlier real run); the action layer runs live.',
  category: 'monitoring',
  parameters: [
    { name: 'configName', type: 'string', required: false, description: 'Config name whose latest snapshot should be loaded from SQLite. Either this or `snapshot` must be provided.' },
    { name: 'snapshot', type: 'object', required: false, description: 'Inline snapshot object (same shape that semantic.cron returns). Bypasses SQLite — useful for self-contained demo bundles. Either this or `configName` must be provided.' },
  ],
  steps: [
    'Load latest snapshot from SQLite for the given configName',
    'Publish semantic-cron.signal-fired event to the webhook event bus with the snapshot in payload',
  ],
  output: 'Confirmation of replay with signal status and joined entity list.',
  example: `await callOperation('tasks.create', {\n  type: 'semantic.cron.replay',\n  args: { configName: 'model-drift-monitor' },\n});`,
  relatedWorkflows: ['semantic.cron'],
  tags: ['monitoring', 'demo', 'replay', 'signal'],
};

registerWorkflow('semantic.cron.replay', semanticCronReplayWorkflow, replayMeta);
