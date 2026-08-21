/**
 * The event schema.
 *
 * This is the contract between the orchestrator and everything that watches it:
 * the live WebSocket feed, the recorded-run JSON files, and the replay scrubber.
 *
 * Two rules keep replay honest:
 *   1. `seq` is a monotonic integer per run. Ordering is by seq, never by ts.
 *   2. Events are append-only facts about the past. Nothing mutates; a status
 *      change is a new event, not an edit to an old one.
 *
 * That means "replay" is just "feed the same array through the same reducer",
 * which is why the scrubber is real and not a video.
 */

export const EVENT_SCHEMA_VERSION = 1;

export type AgentId = string;

/** What an agent is doing right now, as shown on its node in the graph. */
export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'waiting'
  | 'blocked'
  | 'done'
  | 'failed';

/** Coarse pipeline stage, used to group the graph into columns. */
export type Phase =
  | 'planning'
  | 'building'
  | 'review'
  | 'testing'
  | 'deploying'
  | 'done'
  | 'failed';

/** Severity for the human-readable drama feed. */
export type DramaLevel = 'info' | 'good' | 'warn' | 'bad';

interface BaseEvent {
  /** Unique per event. */
  id: string;
  /** Monotonic within a run, starting at 0. Sort key for replay. */
  seq: number;
  /** Wall-clock ms since epoch. Used for replay pacing only. */
  ts: number;
  runId: string;
}

export type SwarmEvent =
  | (BaseEvent & {
      type: 'run.started';
      goal: string;
      schemaVersion: number;
      /**
       * 'live' means real model calls. 'rehearsal' means the agents' words are
       * scripted while the tools, tests and deployment are real.
       *
       * This is on the event, not a UI setting, so a rehearsal cannot be shown
       * as a live run by accident — the badge is driven by the run itself.
       */
      mode: 'live' | 'rehearsal';
    })
  | (BaseEvent & { type: 'run.finished'; ok: boolean; summary: string; deployUrl?: string })
  | (BaseEvent & { type: 'phase.changed'; phase: Phase })

  /** An agent joins the graph. Emitted for every agent before it is used. */
  | (BaseEvent & {
      type: 'agent.spawned';
      agentId: AgentId;
      role: string;
      label: string;
      model: string;
    })
  | (BaseEvent & { type: 'agent.status'; agentId: AgentId; status: AgentStatus; detail?: string })

  /** Streamed assistant text, token by token. Keeps the panels alive. */
  | (BaseEvent & { type: 'agent.token'; agentId: AgentId; turn: number; text: string })
  /** A completed assistant text block. The panel's permanent record. */
  | (BaseEvent & { type: 'agent.message'; agentId: AgentId; turn: number; text: string })

  | (BaseEvent & {
      type: 'tool.call';
      agentId: AgentId;
      callId: string;
      tool: string;
      input: unknown;
    })
  | (BaseEvent & {
      type: 'tool.result';
      agentId: AgentId;
      callId: string;
      tool: string;
      ok: boolean;
      /** Truncated for transport; the full text stays in the agent transcript. */
      preview: string;
      durationMs: number;
    })

  /** Agent-to-agent handoff. This is what animates an edge in the graph. */
  | (BaseEvent & {
      type: 'message.sent';
      from: AgentId;
      to: AgentId;
      kind: 'assign' | 'submit' | 'reject' | 'approve' | 'report';
      summary: string;
    })

  | (BaseEvent & { type: 'file.changed'; path: string; action: 'created' | 'modified' | 'deleted'; bytes: number; by: AgentId })

  | (BaseEvent & {
      type: 'tests.ran';
      agentId: AgentId;
      passed: number;
      failed: number;
      ok: boolean;
      output: string;
    })

  | (BaseEvent & { type: 'deploy.started'; agentId: AgentId; target: string })
  | (BaseEvent & { type: 'deploy.finished'; agentId: AgentId; ok: boolean; url?: string; error?: string })

  /** The line the audience actually reads. */
  | (BaseEvent & { type: 'drama'; level: DramaLevel; text: string; agentId?: AgentId });

export type SwarmEventType = SwarmEvent['type'];

/** A recorded run: exactly what the live feed emitted, in order. */
export interface RecordedRun {
  schemaVersion: number;
  runId: string;
  goal: string;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  deployUrl?: string;
  events: SwarmEvent[];
}

/** Narrow an event by type, with the payload typed. */
export function isEvent<T extends SwarmEventType>(
  e: SwarmEvent,
  type: T,
): e is Extract<SwarmEvent, { type: T }> {
  return e.type === type;
}
