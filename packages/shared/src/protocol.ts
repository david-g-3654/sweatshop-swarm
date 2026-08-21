import type { ArenaEvent, RecordedRun } from './events.js';

/** Frames the server sends down the socket. */
export type ServerFrame =
  /** Sent immediately on connect: everything that has happened so far. */
  | { kind: 'snapshot'; runId: string | null; goal: string | null; events: ArenaEvent[] }
  | { kind: 'event'; event: ArenaEvent }
  | { kind: 'runs'; runs: RunSummary[] }
  | { kind: 'error'; message: string };

/** Frames the client sends up. */
export type ClientFrame =
  | { kind: 'start'; goal: string }
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
