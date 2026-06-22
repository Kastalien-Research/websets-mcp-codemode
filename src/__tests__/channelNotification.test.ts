import { describe, it, expect } from 'vitest';
import {
  buildSemanticCronContent,
  buildSemanticCronNotification,
  resolveRouteDirective,
  directiveMeta,
  substitute,
  semanticCronContext,
  type WorkflowConfig,
} from '../channelNotification.js';
import type { ChannelEvent } from '../channelSynthesis.js';

// The exact snapshot fired during live user-testing (model-drift-monitor),
// reshaped as the event the bridge receives off the SSE bus.
function firedEvent(overrides: Partial<{ shapes: boolean }> = {}): ChannelEvent {
  const withShapes = overrides.shapes !== false;
  return {
    id: 'semantic-cron-fire_task_test',
    type: 'semantic-cron.signal-fired',
    payload: {
      configName: 'model-drift-monitor',
      taskId: 'task_test',
      reason: 'new-fire',
      transition: { was: false, now: true, newEntities: ['Claude Code latency regression'], lostEntities: [] },
      snapshot: {
        evaluatedAt: '2026-06-03T21:20:00.000Z',
        lenses: {
          twitter_complaints: { websetId: 'webset_01kqb1jcy7tq6r6h0yad19r7ke', totalItems: 6, shapedCount: 3 },
          github_issues: { websetId: 'webset_01kqb1jfbs7hcgr7fq7ntrpz7g', totalItems: 4, shapedCount: 2 },
        },
        join: {
          type: 'entity',
          entities: [
            {
              entity: 'Claude Code latency regression',
              url: 'https://github.com/x/y/issues/1',
              presentInLenses: ['twitter_complaints', 'github_issues'],
              lensCount: 2,
              ...(withShapes
                ? {
                    shapes: {
                      twitter_complaints: { 'Complaint volume': '37' },
                      github_issues: { 'Issue state': 'open' },
                    },
                  }
                : {}),
            },
          ],
          lensesWithEvidence: ['twitter_complaints', 'github_issues'],
        },
        signal: { fired: true, satisfiedBy: ['twitter_complaints', 'github_issues'], rule: 'all', entities: ['Claude Code latency regression'] },
      },
    },
  };
}

// Minimal route config mirroring data/workflow-configs.json's model-drift-monitor.
const CONFIG: WorkflowConfig = {
  routes: {
    'model-drift-monitor': {
      name: 'Model behavior drift monitor — fire alert',
      match: { event_type: 'semantic-cron.signal-fired', config_name: 'model-drift-monitor' },
      on: {
        'semantic-cron.signal-fired': {
          steps: ['draft-incident-summary', 'notify-user'],
          params: { message: '🔥 model-drift-monitor fired — {{reason}} — entities: {{joined_entities}} ({{entity_count}}).' },
        },
      },
    },
    'webset_01kn2jaampjxn9wgfbrbpf53ds': {
      name: 'MCP creators',
      on: {
        'webset.idle': {
          steps: ['verify-enrichments', 'notify-user'],
          params: { message: 'idle' },
        },
      },
    },
  },
  steps: {
    'draft-incident-summary': { type: 'notify', description: 'compose incident', params_template: { message: '...' } },
    'notify-user': { type: 'notify', params_template: { message: '{{message}}' } },
    'verify-enrichments': { type: 'server-workflow', workflow: 'verify.enrichments', params_template: {} },
  },
};

// --- Prototype 1: evidence-complete content -------------------------------
describe('Prototype 1 — evidence-complete semantic-cron content', () => {
  it('P1-1: each joined entity carries its per-lens evidence matrix (not stripped)', () => {
    const c = buildSemanticCronContent(firedEvent()) as any;
    const e = c.joinedEntities[0];
    expect(e.entity).toBe('Claude Code latency regression');
    expect(e.evidence).toEqual({
      twitter_complaints: { 'Complaint volume': '37' },
      github_issues: { 'Issue state': 'open' },
    });
    expect(e.lenses).toEqual(['twitter_complaints', 'github_issues']);
    expect(e.url).toBe('https://github.com/x/y/issues/1');
  });

  it('P1-2: the draft-incident-summary matrix is renderable from content alone (no callback)', () => {
    const c = buildSemanticCronContent(firedEvent()) as any;
    // Everything the incident template references is present in content.
    for (const e of c.joinedEntities) {
      expect(e.evidence).toBeTypeOf('object');
      const lensesWithEvidence = Object.keys(e.evidence);
      expect(lensesWithEvidence.length).toBeGreaterThan(0); // matrix is fillable
    }
  });

  it('P1-3: content scales with shaped/joined entities, not totalItems (no raw item lists)', () => {
    const c = buildSemanticCronContent(firedEvent()) as any;
    expect(JSON.stringify(c)).not.toContain('totalItems');
    // Only the single joined entity is present, though lenses saw 10 total items.
    expect(c.joinedEntities).toHaveLength(1);
  });

  it('P1-4: an entity with no shapes still appears with an explicit empty evidence marker', () => {
    const c = buildSemanticCronContent(firedEvent({ shapes: false })) as any;
    expect(c.joinedEntities).toHaveLength(1);
    expect(c.joinedEntities[0].evidence).toEqual({});
  });

  it('P1-6: existing content fields are preserved unchanged', () => {
    const c = buildSemanticCronContent(firedEvent()) as any;
    expect(c.configName).toBe('model-drift-monitor');
    expect(c.reason).toBe('new-fire');
    expect(c.signal).toEqual({ fired: true, rule: 'all', entities: ['Claude Code latency regression'] });
    expect(c.transition).toEqual({ was: false, now: true, newEntities: ['Claude Code latency regression'], lostEntities: [] });
  });

  it('P1-7: emitted content is valid JSON', () => {
    const { content } = buildSemanticCronNotification(firedEvent(), CONFIG);
    expect(() => JSON.parse(content)).not.toThrow();
  });
});

// --- Prototype 2: decision-ready routing in meta --------------------------
describe('Prototype 2 — decision-ready route directive in meta', () => {
  it('P2-1: meta carries the resolved route key and ordered steps', () => {
    const { meta } = buildSemanticCronNotification(firedEvent(), CONFIG);
    expect(meta.route).toBe('model-drift-monitor');
    expect(meta.steps).toBe('draft-incident-summary,notify-user');
  });

  it('P2-2: meta carries a ready-to-act directive (action + resolved message)', () => {
    const { meta } = buildSemanticCronNotification(firedEvent(), CONFIG);
    expect(meta.action).toBe('report'); // both steps are notify
    expect(meta.directive_message).toContain('model-drift-monitor fired');
    expect(meta.directive_message).toContain('Claude Code latency regression');
  });

  it('P2-2: a workflow-dispatching route yields a runnable command hint', () => {
    const idleEvent: ChannelEvent = {
      id: 'event_idle',
      type: 'webset.idle',
      payload: { configName: '', snapshot: { lenses: { a: { websetId: 'webset_01kn2jaampjxn9wgfbrbpf53ds' } } } },
    };
    const directive = resolveRouteDirective(idleEvent, CONFIG, {
      event_type: 'webset.idle',
      webset_id: 'webset_01kn2jaampjxn9wgfbrbpf53ds',
      config_name: '',
    });
    expect(directive.route).toBe('webset_01kn2jaampjxn9wgfbrbpf53ds');
    expect(directive.action).toBe('dispatch');
    expect(directive.command).toContain("type: 'verify.enrichments'");
  });

  it('P2-3: pre-resolved route matches the hand-run dispatch protocol result', () => {
    const ctx = semanticCronContext(firedEvent());
    const directive = resolveRouteDirective(firedEvent(), CONFIG, ctx);
    // By hand: event_type + config_name match model-drift-monitor.match;
    // on[signal-fired].steps = [draft-incident-summary, notify-user].
    expect(directive.route).toBe('model-drift-monitor');
    expect(directive.steps).toBe('draft-incident-summary,notify-user');
  });

  it('P2-4: routing/directive material lives only in meta, never in content', () => {
    const { content } = buildSemanticCronNotification(firedEvent(), CONFIG);
    expect(content).not.toContain('draft-incident-summary');
    expect(content).not.toContain('notify-user');
    expect(content).not.toContain('model-drift-monitor fired'); // the directive message
  });

  it('P2-5: no route match yields an explicit default marker, not omission', () => {
    const orphan: ChannelEvent = {
      id: 'e',
      type: 'semantic-cron.signal-fired',
      payload: { configName: 'unknown-config', snapshot: { lenses: { a: { websetId: 'webset_nope' } }, join: { entities: [] }, signal: {} } },
    };
    const { meta } = buildSemanticCronNotification(orphan, CONFIG);
    expect(meta.route).toBe('');
    expect(meta.action).toBe('default');
    expect(meta.steps).toBe('');
  });

  it('P2-6: substituted messages never leak literal {{tokens}}; unresolved are listed', () => {
    const { text, unresolved } = substitute('a {{reason}} b {{missing}} c', { reason: 'new-fire' });
    expect(text).toBe('a new-fire b  c');
    expect(text).not.toMatch(/\{\{/);
    expect(unresolved).toEqual(['missing']);
  });

  it('P2-6: meta.directive_message has no literal {{tokens}}', () => {
    const { meta } = buildSemanticCronNotification(firedEvent(), CONFIG);
    expect(meta.directive_message).not.toMatch(/\{\{/);
    expect(meta.unresolved_vars).toBe(''); // all of reason/joined_entities/entity_count resolved
  });

  it('P2-7: all meta keys are identifier-safe snake_case', () => {
    const { meta } = buildSemanticCronNotification(firedEvent(), CONFIG);
    for (const key of Object.keys(meta)) {
      expect(key).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('P1-6/P2: existing meta keys preserved alongside new directive keys', () => {
    const { meta } = buildSemanticCronNotification(firedEvent(), CONFIG);
    for (const key of ['event_type', 'config_name', 'task_id', 'reason', 'event_id']) {
      expect(meta[key]).toBeDefined();
    }
    expect(meta.event_type).toBe('semantic-cron.signal-fired');
    expect(meta.config_name).toBe('model-drift-monitor');
  });
});

// --- Feature 1: universal directive (item / idle / candidate) -------------
describe('directiveMeta — route directive for all event types', () => {
  it('F1-2: resolves a webset-keyed webset.idle route to steps + a runnable command', () => {
    const idle: ChannelEvent = {
      id: 'e_idle', type: 'webset.idle',
      payload: { data: { id: 'webset_01kn2jaampjxn9wgfbrbpf53ds' } },
    };
    const m = directiveMeta(idle, CONFIG, {
      event_type: 'webset.idle',
      webset_id: 'webset_01kn2jaampjxn9wgfbrbpf53ds',
      entity_name: '',
    });
    expect(m.route).toBe('webset_01kn2jaampjxn9wgfbrbpf53ds');
    expect(m.steps).toBe('verify-enrichments,notify-user');
    expect(m.action).toBe('dispatch'); // verify-enrichments is a server-workflow
    expect(m.command).toContain("type: 'verify.enrichments'");
    expect(m.command).toContain("webset_01kn2jaampjxn9wgfbrbpf53ds");
  });

  it('F1-5/P2-5: no matching route yields explicit no-match markers', () => {
    const ev: ChannelEvent = {
      id: 'e', type: 'webset.item.ready',
      payload: { data: { id: 'witem_x', websetId: 'webset_unrouted' } },
    };
    const m = directiveMeta(ev, CONFIG, {
      event_type: 'webset.item.ready', webset_id: 'webset_unrouted', entity_name: 'X',
    });
    expect(m.route).toBe('');
    expect(m.action).toBe('default');
    expect(m.steps).toBe('');
  });

  it('F1-6: directive keys are identifier-safe and leak no literal {{tokens}}', () => {
    const idle: ChannelEvent = {
      id: 'e_idle', type: 'webset.idle',
      payload: { data: { id: 'webset_01kn2jaampjxn9wgfbrbpf53ds' } },
    };
    const m = directiveMeta(idle, CONFIG, {
      event_type: 'webset.idle', webset_id: 'webset_01kn2jaampjxn9wgfbrbpf53ds', entity_name: '',
    });
    for (const k of Object.keys(m)) expect(k).toMatch(/^[a-z0-9_]+$/);
    expect(m.directive_message).not.toMatch(/\{\{/);
  });
});

// --- Joint demonstration --------------------------------------------------
describe('J-1 — incident + next action derivable from the notification alone', () => {
  it('renders the per-entity evidence matrix and the route directive with zero callbacks', () => {
    const { content, meta } = buildSemanticCronNotification(firedEvent(), CONFIG);
    const c = JSON.parse(content);
    // (a) evidence matrix present
    expect(c.joinedEntities[0].evidence.twitter_complaints).toEqual({ 'Complaint volume': '37' });
    expect(c.joinedEntities[0].evidence.github_issues).toEqual({ 'Issue state': 'open' });
    // (b) resolved route + directive present in trusted meta
    expect(meta.route).toBe('model-drift-monitor');
    expect(meta.steps).toContain('draft-incident-summary');
    expect(meta.directive_message).toContain('Claude Code latency regression');
  });
});
