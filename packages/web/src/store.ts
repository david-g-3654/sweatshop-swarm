import { create } from 'zustand';
import type { AgentStatus, ArenaEvent, Phase, RunSummary, ServerFrame } from '@arena/shared';
import { ROSTER } from '@arena/shared';

/**
 * All view state is derived from the event log by a pure function.
 *
 * That single decision is what makes the scrubber honest: replaying is
 * re-running this reducer over a prefix of the same array. There is no
 * "replay mode" branch anywhere in the UI, because there is nothing to branch
 * on — live and recorded runs are the same data through the same function.
 */

export interface AgentView {
  agentId: string;
  label: string;
  role: string;
  model: string;
  status: AgentStatus;
  detail?: string;
  /** Tokens as they arrive, for the console panel. */
  stream: string;
  /** Completed messages, newest last. */
  messages: string[];
  turn: number;
  toolCalls: number;
  lastTool?: string;
}

export interface FileView {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  bytes: number;
  by: string;
  at: number;
  revisions: number;
}

export interface DramaLine {
  seq: number;
  at: number;
  level: 'info' | 'good' | 'warn' | 'bad';
  text: string;
  agentId?: string;
}

export interface Handoff {
  from: string;
  to: string;
  kind: 'assign' | 'submit' | 'reject' | 'approve' | 'report';
  summary: string;
  at: number;
  seq: number;
}

export interface ArenaState {
  runId: string | null;
  goal: string | null;
  mode: 'live' | 'rehearsal' | null;
  phase: Phase | null;
  startedAt: number | null;
  /** Timestamp of the newest applied event — mission elapsed time is derived from it. */
  now: number | null;
  finished: { ok: boolean; summary: string; deployUrl?: string } | null;
  agents: Record<string, AgentView>;
  files: Record<string, FileView>;
  drama: DramaLine[];
  handoffs: Handoff[];
  tests: { passed: number; failed: number; ok: boolean } | null;
  deployUrl: string | null;
}

function blankAgent(agentId: string, label: string, role: string): AgentView {
  return {
    agentId,
    label,
    role,
    model: '',
    status: 'idle',
    stream: '',
    messages: [],
    turn: 0,
    toolCalls: 0,
  };
}

export function initialState(): ArenaState {
  // Seed the roster so the graph renders its stations before a run starts,
  // instead of nodes popping into existence mid-demo.
  const agents: Record<string, AgentView> = {};
  for (const spec of ROSTER) {
    agents[spec.agentId] = blankAgent(spec.agentId, spec.label, spec.role);
  }
  return {
    runId: null,
    goal: null,
    mode: null,
    phase: null,
    startedAt: null,
    now: null,
    finished: null,
    agents,
    files: {},
    drama: [],
    handoffs: [],
    tests: null,
    deployUrl: null,
  };
}

/** Apply one event. Mutates the draft; callers always pass a fresh draft. */
function apply(state: ArenaState, event: ArenaEvent): void {
  state.now = event.ts;

  switch (event.type) {
    case 'run.started':
      state.runId = event.runId;
      state.goal = event.goal;
      state.mode = event.mode;
      state.startedAt = event.ts;
      break;

    case 'run.finished':
      state.finished = {
        ok: event.ok,
        summary: event.summary,
        ...(event.deployUrl ? { deployUrl: event.deployUrl } : {}),
      };
      if (event.deployUrl) state.deployUrl = event.deployUrl;
      break;

    case 'phase.changed':
      state.phase = event.phase;
      break;

    case 'agent.spawned': {
      const existing = state.agents[event.agentId] ?? blankAgent(event.agentId, event.label, event.role);
      state.agents[event.agentId] = {
        ...existing,
        label: event.label,
        role: event.role,
        model: event.model,
      };
      break;
    }

    case 'agent.status': {
      const agent = state.agents[event.agentId];
      if (!agent) break;
      // A new thinking turn clears the stream so the panel shows the current
      // thought, not an ever-growing wall from the whole run.
      if (event.status === 'thinking' && agent.status !== 'thinking') agent.stream = '';
      agent.status = event.status;
      if (event.detail) agent.detail = event.detail;
      else delete agent.detail;
      break;
    }

    case 'agent.token': {
      const agent = state.agents[event.agentId];
      if (!agent) break;
      agent.stream += event.text;
      agent.turn = event.turn;
      break;
    }

    case 'agent.message': {
      const agent = state.agents[event.agentId];
      if (!agent) break;
      agent.messages.push(event.text);
      break;
    }

    case 'tool.call': {
      const agent = state.agents[event.agentId];
      if (!agent) break;
      agent.toolCalls += 1;
      agent.lastTool = event.tool;
      break;
    }

    case 'file.changed': {
      const previous = state.files[event.path];
      state.files[event.path] = {
        path: event.path,
        action: event.action,
        bytes: event.bytes,
        by: event.by,
        at: event.ts,
        revisions: (previous?.revisions ?? 0) + 1,
      };
      break;
    }

    case 'message.sent':
      state.handoffs.push({
        from: event.from,
        to: event.to,
        kind: event.kind,
        summary: event.summary,
        at: event.ts,
        seq: event.seq,
      });
      break;

    case 'tests.ran':
      state.tests = { passed: event.passed, failed: event.failed, ok: event.ok };
      break;

    case 'deploy.finished':
      if (event.ok && event.url) state.deployUrl = event.url;
      break;

    case 'drama':
      state.drama.push({
        seq: event.seq,
        at: event.ts,
        level: event.level,
        text: event.text,
        ...(event.agentId ? { agentId: event.agentId } : {}),
      });
      break;

    default:
      break;
  }
}

export function reduceEvents(events: ArenaEvent[], upTo: number): ArenaState {
  const state = initialState();
  const end = Math.min(upTo, events.length);
  for (let i = 0; i < end; i++) apply(state, events[i]!);
  return state;
}

// ---- the store -------------------------------------------------------------

interface Store {
  connected: boolean;
  events: ArenaEvent[];
  /** How many events are applied. Equals events.length when following live. */
  cursor: number;
  /** True while the user is scrubbing; new events stop advancing the cursor. */
  scrubbing: boolean;
  runs: RunSummary[];
  error: string | null;
  derived: ArenaState;

  setConnected(connected: boolean): void;
  ingest(frame: ServerFrame): void;
  setCursor(cursor: number): void;
  follow(): void;
}

export const useArena = create<Store>((set, get) => ({
  connected: false,
  events: [],
  cursor: 0,
  scrubbing: false,
  runs: [],
  error: null,
  derived: initialState(),

  setConnected: (connected) => set({ connected }),

  ingest: (frame) => {
    if (frame.kind === 'snapshot') {
      set({
        events: frame.events,
        cursor: frame.events.length,
        scrubbing: false,
        error: null,
        derived: reduceEvents(frame.events, frame.events.length),
      });
      return;
    }
    if (frame.kind === 'event') {
      const { events, cursor, scrubbing, derived } = get();
      const next = [...events, frame.event];
      if (scrubbing) {
        // Keep collecting, but leave the view where the user parked it.
        set({ events: next });
        return;
      }
      // Following live: extend the derived state rather than rebuilding it.
      const draft: ArenaState = structuredClone(derived);
      apply(draft, frame.event);
      set({ events: next, cursor: cursor + 1, derived: draft });
      return;
    }
    if (frame.kind === 'runs') {
      set({ runs: frame.runs });
      return;
    }
    if (frame.kind === 'error') set({ error: frame.message });
  },

  setCursor: (cursor) => {
    const { events } = get();
    const clamped = Math.max(0, Math.min(cursor, events.length));
    set({
      cursor: clamped,
      scrubbing: clamped < events.length,
      derived: reduceEvents(events, clamped),
    });
  },

  follow: () => {
    const { events } = get();
    set({ cursor: events.length, scrubbing: false, derived: reduceEvents(events, events.length) });
  },
}));
