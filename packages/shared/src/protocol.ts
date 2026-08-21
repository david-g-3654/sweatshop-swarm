import type { SwarmEvent, RecordedRun } from './events.js';

/** Frames the server sends down the socket. */
export type ServerFrame =
  /** Booth-loop state, so the UI can show whether it is armed and what it is doing. */
  | { kind: 'loop'; enabled: boolean; dwellSeconds: number; nextRunInSeconds: number | null }
  /**
   * Sent immediately on connect, and again whenever the current run changes.
   *
   * `live` says whether this is a run happening on this machine now, or one
   * loaded from disk. Inferring it from an empty event list looked equivalent
   * and was not: a client connecting mid-run gets a full backlog and would be
   * misread as a replay, which is exactly what happens when someone reloads
   * the booth screen while a run is going.
   */
  | { kind: 'snapshot'; runId: string | null; goal: string | null; events: SwarmEvent[]; live: boolean }
  | { kind: 'event'; event: SwarmEvent }
  | { kind: 'runs'; runs: RunSummary[] }
  | { kind: 'error'; message: string };

/** Frames the client sends up. */
export type ClientFrame =
  | { kind: 'start'; goal: string; mode?: 'live' | 'rehearsal' }
  | { kind: 'set-loop'; enabled: boolean; goal?: string }
  | { kind: 'list-runs' }
  | { kind: 'load-run'; runId: string };

export interface RunSummary {
  runId: string;
  goal: string;
  startedAt: number;
  ok: boolean;
  deployUrl?: string;
  eventCount: number;
}

export function summarise(run: RecordedRun): RunSummary {
  return {
    runId: run.runId,
    goal: run.goal,
    startedAt: run.startedAt,
    ok: run.ok,
    ...(run.deployUrl ? { deployUrl: run.deployUrl } : {}),
    eventCount: run.events.length,
  };
}
