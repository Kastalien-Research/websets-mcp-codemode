// Pure notification formatters used by the channel bridge (src/channel.ts).
// Lives in its own module (like channelSynthesis.ts) so unit tests can import
// it without triggering channel.ts startup side effects.
//
// Two prototypes are implemented here, each backed by an acceptance contract:
//
//   Prototype 1 — Evidence-complete payload: the semantic-cron content carries
//   the per-entity cross-lens evidence matrix (join.entities[].shapes), so a
//   consumer can render an incident summary from the notification alone, with
//   zero callbacks.
//
//   Prototype 2 — Decision-ready routing in the trusted layer: the bridge
//   pre-resolves the matching route from workflow-configs.json and stamps the
//   resolved route / steps / action / message into `meta` (the trusted layer),
//   never into `content` (which stays pure data). The agent no longer has to
//   re-read config and re-run the dispatch protocol on every event.

import type { ChannelEvent } from './channelSynthesis.js';

// --- workflow-configs.json shape (subset we consume) ----------------------
export interface RouteEventEntry {
  steps?: string[];
  params?: Record<string, string>;
  gate?: unknown;
}
export interface RouteMatch {
  event_type?: string;
  config_name?: string;
  webset_id?: string;
}
export interface RouteDef {
  name?: string;
  channel?: string;
  match?: RouteMatch;
  on?: Record<string, RouteEventEntry>;
}
export interface StepDef {
  type?: string;
  workflow?: string;
  description?: string;
  params_template?: Record<string, string>;
  gate_output?: unknown;
}
export interface WorkflowConfig {
  routes?: Record<string, RouteDef>;
  steps?: Record<string, StepDef>;
}

// Context values available for {{variable}} substitution. Mirrors the sources
// the dispatch protocol documents (event payload fields + route params) so the
// bridge's pre-resolution matches what the agent would compute by hand.
export type SubstitutionContext = Record<string, string>;

// The resolved, decision-ready directive the bridge stamps into meta.
export interface RouteDirective {
  /** Matched route key, or '' when no route matches. */
  route: string;
  /** Ordered step names the route would run, comma-joined ('' when no match). */
  steps: string;
  /**
   * Coarse action label derived from the matched steps' types:
   *   'report'   — every step is a notify step (just surface to the user)
   *   'dispatch' — at least one step runs a server-workflow
   *   'default'  — no route matched (P2-5 explicit no-match marker)
   */
  action: 'report' | 'dispatch' | 'default';
  /** Route-level notify message with {{variables}} resolved (no literal leaks). */
  message: string;
  /**
   * A ready-to-run command hint when the route dispatches a workflow, else ''.
   * Lets the consumer act without reading config.steps definitions.
   */
  command: string;
  /** Variable tokens that could not be resolved from context, comma-joined. */
  unresolved_vars: string;
}

const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Substitute {{token}} placeholders from `ctx`. Resolved tokens are replaced
 * with their value; unresolved tokens are removed (so no literal `{{...}}`
 * ever leaks into the consumer's context — P2-6) and collected into `unresolved`.
 */
export function substitute(
  template: string,
  ctx: SubstitutionContext,
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const text = template.replace(TOKEN_RE, (_m, token: string) => {
    if (Object.prototype.hasOwnProperty.call(ctx, token) && ctx[token] !== undefined) {
      return ctx[token];
    }
    unresolved.push(token);
    return '';
  });
  return { text, unresolved };
}

/**
 * Pre-resolve the matching route for an event into a decision-ready directive.
 *
 * Matching mirrors the documented dispatch protocol (P2-3):
 *   - A route with an explicit `match` object matches when its event_type,
 *     config_name, and webset_id constraints (those present) all hold.
 *   - Otherwise the route key is treated as a webset_id and matches when it
 *     equals the event's webset_id.
 * The route must additionally have an `on[event.type]` entry to be actionable.
 *
 * Returns an explicit no-match directive ({ route:'', action:'default' }) when
 * nothing matches, so absence-of-route is distinguishable from unprocessed (P2-5).
 */
export function resolveRouteDirective(
  event: ChannelEvent,
  config: WorkflowConfig | undefined,
  ctx: SubstitutionContext,
): RouteDirective {
  const NO_MATCH: RouteDirective = {
    route: '',
    steps: '',
    action: 'default',
    message: '',
    command: '',
    unresolved_vars: '',
  };

  const routes = config?.routes;
  if (!routes) return NO_MATCH;

  const websetId = ctx.webset_id || '';
  const configName = ctx.config_name || '';

  for (const [key, route] of Object.entries(routes)) {
    let matched = false;
    if (route.match) {
      const m = route.match;
      matched =
        (!m.event_type || m.event_type === event.type) &&
        (!m.config_name || m.config_name === configName) &&
        (!m.webset_id || m.webset_id === websetId);
    } else {
      // Route key is a webset id.
      matched = key === websetId;
    }
    if (!matched) continue;

    const entry = route.on?.[event.type];
    if (!entry) continue; // route matches the entity but not this event type

    const steps = entry.steps ?? [];
    const stepDefs = steps.map(s => config?.steps?.[s]);
    const allNotify =
      stepDefs.length > 0 && stepDefs.every(d => d?.type === 'notify');
    const action: RouteDirective['action'] = allNotify ? 'report' : 'dispatch';

    // Command hint: first server-workflow step → a tasks.create call the
    // consumer can run as-is.
    let command = '';
    for (const d of stepDefs) {
      if (d?.type === 'server-workflow' && d.workflow) {
        command = `callOperation('tasks.create', { type: '${d.workflow}', args: { websetId: '${websetId}' } })`;
        break;
      }
    }

    const { text, unresolved } = substitute(entry.params?.message ?? '', ctx);

    return {
      route: key,
      steps: steps.join(','),
      action,
      message: text,
      command,
      unresolved_vars: Array.from(new Set(unresolved)).join(','),
    };
  }

  return NO_MATCH;
}

/**
 * Build the decision-ready directive meta keys for ANY event type, given a
 * substitution context. Used by the item/idle and candidate formatters so
 * every notification carries the pre-resolved route directive in meta (not just
 * semantic-cron). Returns only the directive keys; callers merge them with the
 * event's own meta. On no route match the keys carry the explicit no-match
 * markers (route:'', action:'default').
 */
export function directiveMeta(
  event: ChannelEvent,
  config: WorkflowConfig | undefined,
  ctx: SubstitutionContext,
): Record<string, string> {
  const d = resolveRouteDirective(event, config, ctx);
  return {
    route: d.route,
    steps: d.steps,
    action: d.action,
    command: d.command,
    directive_message: d.message,
    unresolved_vars: d.unresolved_vars,
  };
}

// --- semantic-cron notification (Prototype 1 + Prototype 2) ----------------

type Shape = Record<string, unknown>;
interface JoinEntity {
  entity?: string;
  url?: string;
  lensCount?: number;
  presentInLenses?: string[];
  shapes?: Record<string, Shape>;
}

/**
 * Build the pure-data content for a semantic-cron event. Prototype 1: each
 * joined entity carries its per-lens `evidence` matrix (from join.shapes), so
 * the consumer can render the incident summary without a callback. Entities
 * with no shapes keep an explicit empty `evidence: {}` marker (P1-4). Only the
 * joined/shaped subset is included — size scales with shapedCount, not
 * totalItems (P1-3).
 */
export function buildSemanticCronContent(event: ChannelEvent): Record<string, unknown> {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const snapshot = (p.snapshot ?? {}) as Record<string, unknown>;
  const signal = (snapshot.signal ?? {}) as Record<string, unknown>;
  const join = (snapshot.join ?? {}) as Record<string, unknown>;
  const transition = (p.transition ?? {}) as Record<string, unknown>;

  const entities = (join.entities as JoinEntity[] | undefined) ?? [];

  return {
    configName: p.configName,
    taskId: p.taskId,
    reason: p.reason,
    signal: {
      fired: signal.fired,
      rule: signal.rule,
      entities: signal.entities,
    },
    transition: {
      was: transition.was,
      now: transition.now,
      newEntities: transition.newEntities,
      lostEntities: transition.lostEntities,
    },
    joinedEntities: entities.map(e => ({
      entity: e.entity,
      url: e.url ?? '',
      lensCount: e.lensCount,
      lenses: e.presentInLenses ?? [],
      // Prototype 1: per-lens cross-evidence matrix, preserved (not stripped).
      evidence: e.shapes ?? {},
    })),
  };
}

/**
 * Derive the substitution context for a semantic-cron event, exposing the
 * variables the route/step templates reference ({{config_name}}, {{reason}},
 * {{joined_entities}}, {{entity_count}}, {{new_entities}}, {{lost_entities}}).
 */
export function semanticCronContext(event: ChannelEvent): SubstitutionContext {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const snapshot = (p.snapshot ?? {}) as Record<string, unknown>;
  const join = (snapshot.join ?? {}) as Record<string, unknown>;
  const transition = (p.transition ?? {}) as Record<string, unknown>;
  const entities = (join.entities as JoinEntity[] | undefined) ?? [];
  const names = entities.map(e => e.entity).filter(Boolean) as string[];
  const newE = (transition.newEntities as string[] | undefined) ?? [];
  const lostE = (transition.lostEntities as string[] | undefined) ?? [];

  return {
    event_type: event.type,
    config_name: (p.configName ?? '') as string,
    task_id: (p.taskId ?? '') as string,
    reason: (p.reason ?? '') as string,
    webset_id: firstLensWebsetId(snapshot),
    joined_entities: names.join(', '),
    entity_count: String(names.length),
    new_entities: newE.join(', '),
    lost_entities: lostE.join(', '),
  };
}

function firstLensWebsetId(snapshot: Record<string, unknown>): string {
  const lenses = (snapshot.lenses ?? {}) as Record<string, { websetId?: string }>;
  for (const lens of Object.values(lenses)) {
    if (lens?.websetId) return lens.websetId;
  }
  return '';
}

/**
 * Full notification (content + meta) for a semantic-cron signal event,
 * combining Prototype 1 (evidence-complete content) and Prototype 2
 * (decision-ready route directive in meta). `content` stays pure data; all
 * routing/directive material lives only in `meta` (P2-4). All meta keys are
 * identifier-safe snake_case (P2-7).
 */
export function buildSemanticCronNotification(
  event: ChannelEvent,
  config: WorkflowConfig | undefined,
): { content: string; meta: Record<string, string> } {
  const ctx = semanticCronContext(event);
  const directive = resolveRouteDirective(event, config, ctx);
  const content = JSON.stringify(buildSemanticCronContent(event), null, 2);

  const meta: Record<string, string> = {
    event_type: event.type,
    config_name: ctx.config_name,
    task_id: ctx.task_id,
    reason: ctx.reason,
    event_id: event.id,
    // Prototype 2: pre-resolved, decision-ready routing directive (trusted layer).
    route: directive.route,
    steps: directive.steps,
    action: directive.action,
    directive_message: directive.message,
    command: directive.command,
    unresolved_vars: directive.unresolved_vars,
  };

  return { content, meta };
}
