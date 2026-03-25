export interface AppliedCoercion {
  path: string;
  from: string;
  to: string;
}

export type CompatMode = 'safe' | 'strict';

export interface CoercionResult {
  args: Record<string, unknown>;
  enabled: boolean;
  preview: boolean;
  effectiveMode: CompatMode;
  coercions: AppliedCoercion[];
  warnings: string[];
}

const KNOWN_ENTITY_TYPES = new Set([
  'company',
  'person',
  'article',
  'research_paper',
  'custom',
]);

const NUMERIC_FIELDS = new Set([
  'count',
  'limit',
  'maxItems',
  'numResults',
  'expandTop',
  'researchLimit',
  'timeout',
  'timeoutMs',
  'pollInterval',
  'pollIntervalMs',
  'duration',
  'size',
  'subpages',
]);

const BOOLEAN_FIELDS = new Set([
  'cleanup',
  'synthesize',
  'critique',
  'excludeSourceDomain',
  'useAutoprompt',
  'moderation',
  'text',
  'highlights',
  'summary',
]);

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return { ...record };
}

function maybeCoerceEntity(
  target: Record<string, unknown>,
  key: string,
  path: string,
  coercions: AppliedCoercion[],
): void {
  const value = target[key];
  if (typeof value !== 'string') return;
  if (!KNOWN_ENTITY_TYPES.has(value)) return;

  target[key] = { type: value };
  coercions.push({
    path,
    from: stringifyValue(value),
    to: stringifyValue(target[key]),
  });
}

function maybeCoerceCriteria(
  target: Record<string, unknown>,
  key: string,
  path: string,
  coercions: AppliedCoercion[],
): void {
  const value = target[key];
  if (!Array.isArray(value) || value.length === 0) return;
  if (!value.every(v => typeof v === 'string' && v.trim().length > 0)) return;

  target[key] = value.map(v => ({ description: (v as string).trim() }));
  coercions.push({
    path,
    from: stringifyValue(value),
    to: stringifyValue(target[key]),
  });
}

function maybeCoerceOptions(
  target: Record<string, unknown>,
  key: string,
  path: string,
  coercions: AppliedCoercion[],
): void {
  const value = target[key];
  if (!Array.isArray(value) || value.length === 0) return;
  if (!value.every(v => typeof v === 'string' && v.trim().length > 0)) return;

  target[key] = value.map(v => ({ label: (v as string).trim() }));
  coercions.push({
    path,
    from: stringifyValue(value),
    to: stringifyValue(target[key]),
  });
}

function maybeCoerceNumber(
  target: Record<string, unknown>,
  key: string,
  path: string,
  coercions: AppliedCoercion[],
): void {
  const value = target[key];
  if (typeof value !== 'string') return;
  if (value.trim() === '') return;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return;

  target[key] = parsed;
  coercions.push({
    path,
    from: stringifyValue(value),
    to: stringifyValue(parsed),
  });
}

function maybeCoerceBoolean(
  target: Record<string, unknown>,
  key: string,
  path: string,
  coercions: AppliedCoercion[],
): void {
  const value = target[key];
  if (value !== 'true' && value !== 'false') return;

  const parsed = value === 'true';
  target[key] = parsed;
  coercions.push({
    path,
    from: stringifyValue(value),
    to: stringifyValue(parsed),
  });
}

function coerceTopLevelFields(
  target: Record<string, unknown>,
  basePath: string,
  coercions: AppliedCoercion[],
): void {
  for (const key of Object.keys(target)) {
    const path = basePath ? `${basePath}.${key}` : key;

    if (key === 'entity') {
      maybeCoerceEntity(target, key, path, coercions);
      continue;
    }

    if (key === 'criteria' || key === 'searchCriteria') {
      maybeCoerceCriteria(target, key, path, coercions);
      continue;
    }

    if (key === 'options') {
      maybeCoerceOptions(target, key, path, coercions);
      continue;
    }

    if (NUMERIC_FIELDS.has(key)) {
      maybeCoerceNumber(target, key, path, coercions);
      continue;
    }

    if (BOOLEAN_FIELDS.has(key)) {
      maybeCoerceBoolean(target, key, path, coercions);
    }
  }
}

function coerceEnrichmentOptions(
  target: Record<string, unknown>,
  basePath: string,
  coercions: AppliedCoercion[],
): void {
  const value = target.enrichments;
  if (!Array.isArray(value)) return;

  for (let i = 0; i < value.length; i += 1) {
    const enrichment = value[i];
    if (!enrichment || typeof enrichment !== 'object') continue;
    const record = enrichment as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, 'options')) continue;

    maybeCoerceOptions(
      record,
      'options',
      `${basePath}.enrichments[${i}].options`,
      coercions,
    );
  }
}

function coerceArgsForOperation(
  operation: string,
  args: Record<string, unknown>,
  coercions: AppliedCoercion[],
): Record<string, unknown> {
  const normalized = cloneRecord(args);

  coerceTopLevelFields(normalized, 'args', coercions);
  coerceEnrichmentOptions(normalized, 'args', coercions);

  if (operation === 'tasks.create') {
    const nested = normalized.args;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const nestedRecord = cloneRecord(nested as Record<string, unknown>);
      coerceTopLevelFields(nestedRecord, 'args.args', coercions);
      coerceEnrichmentOptions(nestedRecord, 'args.args', coercions);
      normalized.args = nestedRecord;
    }
  }

  return normalized;
}

export function applyCompatCoercions(
  operation: string,
  args: Record<string, unknown>,
  defaultMode: CompatMode = 'strict',
): CoercionResult {
  const warnings: string[] = [];
  const coercions: AppliedCoercion[] = [];

  const working = cloneRecord(args);
  const compatRaw = working.compat;
  delete working.compat;

  const mode = (
    compatRaw &&
    typeof compatRaw === 'object' &&
    !Array.isArray(compatRaw)
      ? (compatRaw as Record<string, unknown>).mode
      : undefined
  );
  const previewRaw = (
    compatRaw &&
    typeof compatRaw === 'object' &&
    !Array.isArray(compatRaw)
      ? (compatRaw as Record<string, unknown>).preview
      : undefined
  );
  let preview = false;
  if (previewRaw === true) {
    preview = true;
  } else if (previewRaw !== undefined && previewRaw !== false) {
    warnings.push(`Invalid compat preview value "${String(previewRaw)}"; expected boolean.`);
  }

  let effectiveMode: CompatMode = defaultMode;
  if (mode === 'safe' || mode === 'strict') {
    effectiveMode = mode;
  } else if (mode !== undefined) {
    warnings.push(`Unsupported compat mode "${String(mode)}"; ignored.`);
    effectiveMode = 'strict';
  }

  if (effectiveMode !== 'safe') {
    return {
      args: working,
      enabled: false,
      preview,
      effectiveMode,
      coercions,
      warnings,
    };
  }

  const normalized = coerceArgsForOperation(operation, working, coercions);
  return {
    args: normalized,
    enabled: true,
    preview,
    effectiveMode,
    coercions,
    warnings,
  };
}
