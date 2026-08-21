import { randomUUID } from 'node:crypto';
import type { SwarmEvent, RecordedRun } from '@swarm/shared';
import { EVENT_SCHEMA_VERSION } from '@swarm/shared';
import { redactDeep } from './redact.js';

/**
 * An event as emitted by the orchestrator, before the bus stamps it.
 *
 * The omit has to distribute across the union — a plain Omit<Union, K> collapses
 * to the keys every member shares, which throws away every payload field.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EmittedEvent = DistributiveOmit<SwarmEvent, 'id' | 'seq' | 'ts' | 'runId'> & {
  ts?: number;
};

export type Subscriber = (event: SwarmEvent) => void;

/**
 * The event bus.
 *
 * One instance per run. It stamps ordering metadata, keeps the full log in
 * memory, and fans out to subscribers (WebSocket clients, the recorder).
 *
 * The in-memory log is what lets a browser that connects halfway through a run
 * catch up: it replays the backlog, then joins the live feed. Same events, same
 * order, so a late joiner and an early joiner end up in identical state.
 */
export class EventBus {
  readonly log: SwarmEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private seq = 0;

  constructor(
    readonly runId: string,
    readonly goal: string,
  ) {}

  emit(event: EmittedEvent): SwarmEvent {
    // Redact here, not at the call sites. Every observable string — the live
    // feed, the recording on disk, the console — passes through this one
    // function, so a secret scrubbed here cannot reach any of them.
    const stamped = {
      ...redactDeep(event),
      id: randomUUID(),
      seq: this.seq++,
      ts: event.ts ?? Date.now(),
      runId: this.runId,
    } as SwarmEvent;

    this.log.push(stamped);
    for (const subscriber of this.subscribers) {
      try {
        subscriber(stamped);
      } catch (err) {
        // A broken client must never take down a run mid-demo.
        console.error('[bus] subscriber threw:', err);
      }
    }
    return stamped;
  }

  /** Convenience: the one-liner the audience actually reads. */
  drama(level: 'info' | 'good' | 'warn' | 'bad', text: string, agentId?: string): void {
    this.emit({ type: 'drama', level, text, ...(agentId ? { agentId } : {}) });
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Snapshot for a client that just connected. */
  backlog(): SwarmEvent[] {
    return [...this.log];
  }

  toRecording(): RecordedRun {
    const finished = [...this.log].reverse().find((e) => e.type === 'run.finished');
    const started = this.log.find((e) => e.type === 'run.started');
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      runId: this.runId,
      goal: this.goal,
      startedAt: started?.ts ?? this.log[0]?.ts ?? Date.now(),
      finishedAt: finished?.ts ?? this.log[this.log.length - 1]?.ts ?? Date.now(),
      ok: finished?.type === 'run.finished' ? finished.ok : false,
      ...(finished?.type === 'run.finished' && finished.deployUrl
        ? { deployUrl: finished.deployUrl }
        : {}),
      events: [...this.log],
    };
  }
}
