import type { Exa } from 'exa-js';

/**
 * Operations a pinned run (`execute` with `asOf`) may call. Every other
 * operation is refused at dispatch: it reaches live data (Websets, agents,
 * answers, external APIs, local state built from live results) that Exa
 * Snapshot cannot bound to a past instant.
 */
export const PINNABLE_OPERATIONS: ReadonlySet<string> = new Set(['exa.search', 'exa.getContents']);

export class TemporalBoundaryError extends Error {
  readonly code = 'TEMPORAL_BOUNDARY';
  constructor(message: string) {
    super(`TEMPORAL_BOUNDARY: ${message}`);
    this.name = 'TemporalBoundaryError';
  }
}

export class TemporalLeakError extends Error {
  readonly code = 'TEMPORAL_LEAK';
  constructor(message: string) {
    super(`TEMPORAL_LEAK: ${message}`);
    this.name = 'TemporalLeakError';
  }
}

export function refusalMessage(operation: string, asOf: string): string {
  return `${operation} cannot run in a run pinned to ${asOf}: it reaches live data that Exa Snapshot cannot bound to a past instant. `
    + `Pinnable operations: ${[...PINNABLE_OPERATIONS].join(', ')}. To use ${operation}, call it from an execute run without asOf.`;
}

/** Options Exa rejects alongside snapshotAsOf: they reach the live web or expand to other pages. */
const LIVE_CONTENT_OPTIONS = ['livecrawl', 'livecrawlTimeout', 'maxAgeHours', 'subpages'];
const DEEP_SEARCH_TYPES = new Set(['deep-lite', 'deep', 'deep-reasoning']);

const DISCOVERY_NOTE =
  "Which pages were returned, and their order, came from Exa's current index and ranking, which can reflect information "
  + 'from after snapshotAsOf. Treat these results as evidence bounded by snapshotAsOf, not as what a search would have returned then.';

export function containsSnapshotAsOf(value: unknown, depth = 0): boolean {
  if (depth > 5 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(v => containsSnapshotAsOf(v, depth + 1));
  return 'snapshotAsOf' in value || Object.values(value).some(v => containsSnapshotAsOf(v, depth + 1));
}

/** The snapshot a request runs under: its own value (never later than the run's), else the run's. */
function effectiveSnapshot(perCall: unknown, asOf: string | undefined): string | undefined {
  if (perCall === undefined) return asOf;
  if (typeof perCall !== 'string' || Number.isNaN(Date.parse(perCall))) {
    throw new TemporalBoundaryError(`snapshotAsOf ${JSON.stringify(perCall)} is not an ISO 8601 instant.`);
  }
  if (asOf !== undefined && Date.parse(perCall) > Date.parse(asOf)) {
    throw new TemporalBoundaryError(`snapshotAsOf ${perCall} is later than this run's asOf ${asOf}; a pinned run cannot look past its own instant.`);
  }
  return perCall;
}

function rejectLiveContentOptions(options: Record<string, unknown>): void {
  const conflicting = LIVE_CONTENT_OPTIONS.filter(key => options[key] !== undefined);
  if (conflicting.length > 0) {
    throw new TemporalBoundaryError(
      `${conflicting.join(', ')} cannot be combined with a snapshot: snapshot requests are served from stored versions only. `
      + `Omit ${LIVE_CONTENT_OPTIONS.join(', ')}.`,
    );
  }
}

/**
 * Checks a snapshot response with every field the API provides and labels how
 * far the bound was verified. Exa does not currently return `snapshotAt`, so
 * most responses are labeled provider-guaranteed; a `snapshotAt` later than the
 * cutoff, or a contents status served from anywhere but the store, is a leak.
 */
function annotate(response: any, snapshotAsOf: string, kind: 'search' | 'contents'): any {
  const results: any[] = Array.isArray(response?.results) ? response.results : [];
  const statuses: any[] = Array.isArray(response?.statuses) ? response.statuses : [];
  const cutoff = Date.parse(snapshotAsOf);
  const leaks: string[] = [];
  let verified = 0;
  for (const result of results) {
    if (result?.snapshotAt === undefined || result?.snapshotAt === null) continue;
    const crawled = typeof result.snapshotAt === 'string' ? Date.parse(result.snapshotAt) : NaN;
    if (Number.isNaN(crawled) || crawled > cutoff) leaks.push(`${result.url ?? result.id} (snapshotAt ${String(result.snapshotAt)})`);
    else verified++;
  }
  for (const status of statuses) {
    if (status?.status === 'success' && status.source !== undefined && status.source !== 'cached') {
      leaks.push(`${status.id} (served from ${String(status.source)}, not a stored version)`);
    }
  }
  if (leaks.length > 0) {
    throw new TemporalLeakError(
      `the response to a request bounded by snapshotAsOf ${snapshotAsOf} included content from after it or from the live web, so it was withheld: ${leaks.join('; ')}.`,
    );
  }

  const allVerified = results.length > 0 && verified === results.length;
  const notStored = statuses
    .filter(status => status?.status === 'error')
    .map(status => ({ id: status.id, reason: status.error?.tag ?? status.tag ?? status.error ?? null }));
  const temporal = {
    snapshotAsOf,
    bound: `Page content comes from the newest version Exa stored at or before ${snapshotAsOf}.`,
    verification: allVerified ? 'verified' : 'provider-guaranteed',
    verificationNote: allVerified
      ? 'Every result reported its crawl time (snapshotAt), and each is at or before snapshotAsOf.'
      : results.length === 0
        ? 'No results were returned.'
        : `${results.length - verified} of ${results.length} results did not report a crawl time (snapshotAt), so the bound rests on Exa's guarantee rather than a check by this server.`,
    ...(kind === 'search' ? { discovery: 'current-ranking', discoveryNote: DISCOVERY_NOTE } : {}),
    ...(notStored.length > 0 ? { notStored } : {}),
  };
  return { temporal, ...response };
}

async function search(exa: Exa, asOf: string | undefined, query: string, options?: Record<string, any>) {
  const contents = options?.contents && typeof options.contents === 'object' ? { ...options.contents } : {};
  const snapshotAsOf = effectiveSnapshot(contents.snapshotAsOf, asOf);
  if (snapshotAsOf === undefined) return exa.search(query, options as any);

  if (DEEP_SEARCH_TYPES.has(options?.type)) {
    throw new TemporalBoundaryError(`search type "${options!.type}" cannot be combined with a snapshot; use auto, fast or instant.`);
  }
  if (options?.category !== undefined) {
    throw new TemporalBoundaryError('category cannot be combined with a snapshot; describe the kind of page in the query instead.');
  }
  rejectLiveContentOptions(contents);
  const response = await exa.search(query, { ...options, contents: { ...contents, snapshotAsOf } } as any);
  return annotate(response, snapshotAsOf, 'search');
}

async function getContents(exa: Exa, asOf: string | undefined, urls: unknown, options?: Record<string, any>) {
  const snapshotAsOf = effectiveSnapshot(options?.snapshotAsOf, asOf);
  if (snapshotAsOf === undefined) return exa.getContents(urls as any, options as any);
  rejectLiveContentOptions(options ?? {});
  const response = await exa.getContents(urls as any, { ...options, snapshotAsOf } as any);
  return annotate(response, snapshotAsOf, 'contents');
}

async function rawRequest(exa: Exa, asOf: string | undefined, endpoint: string, method: string, body?: any, query?: unknown) {
  // A closure, not .bind: the client may itself be a proxy whose members are all callable.
  const raw = (...args: unknown[]) => (exa as any).rawRequest(...args);
  if (endpoint !== '/contents' || method !== 'POST') {
    if (asOf !== undefined) {
      throw new TemporalBoundaryError(`${method} ${endpoint} is not available in a run pinned to ${asOf}; only search and contents can be bound to a past instant.`);
    }
    if (containsSnapshotAsOf(body)) throw new TemporalBoundaryError(`snapshotAsOf is not supported by ${method} ${endpoint}.`);
    return raw(endpoint, method, body, query);
  }

  const snapshotAsOf = effectiveSnapshot(body?.snapshotAsOf, asOf);
  if (snapshotAsOf === undefined) return raw(endpoint, method, body, query);
  rejectLiveContentOptions(body ?? {});
  const response = await raw(endpoint, method, { ...body, snapshotAsOf }, query);
  const text = await response.text();
  if (!response.ok) return new Response(text, { status: response.status });
  return new Response(JSON.stringify(annotate(JSON.parse(text), snapshotAsOf, 'contents')), {
    status: response.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Stand-in for any client member a pinned run may not use: every call throws. */
function boundaryStub(path: string, asOf: string): unknown {
  return new Proxy(function pinned() {}, {
    get(_target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return boundaryStub(`${path}.${prop}`, asOf);
    },
    apply() {
      throw new TemporalBoundaryError(
        `exa.${path} is not available in a run pinned to ${asOf}; only search and getContents can be bound to a past instant.`,
      );
    },
  });
}

/**
 * Wraps the Exa client so snapshot rules hold no matter who calls it (handlers
 * or workflows). Any request carrying `snapshotAsOf` is checked for conflicting
 * options and its response is leak-checked and annotated. With `asOf`, the
 * client is pinned: search and contents inherit `asOf` as their snapshot, may
 * only look further back, and every other member throws TEMPORAL_BOUNDARY.
 */
export function guardSnapshots(exa: Exa, asOf?: string): Exa {
  return new Proxy(exa, {
    get(target, prop) {
      if (prop === 'search') return (query: string, options?: Record<string, any>) => search(target, asOf, query, options);
      if (prop === 'getContents') return (urls: unknown, options?: Record<string, any>) => getContents(target, asOf, urls, options);
      if (prop === 'rawRequest') {
        return (endpoint: string, method: string, body?: unknown, query?: unknown) => rawRequest(target, asOf, endpoint, method, body, query);
      }

      const value = Reflect.get(target, prop, target);
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return value;
      if (asOf !== undefined) return boundaryStub(prop, asOf);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (containsSnapshotAsOf(args)) {
          throw new TemporalBoundaryError(`snapshotAsOf is only supported by search and getContents, not ${prop}.`);
        }
        return Reflect.apply(value, target, args);
      };
    },
  }) as Exa;
}
