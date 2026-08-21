import { useCallback, useEffect, useRef, useState } from 'react';
import { useSwarm } from '../store';
import { met } from '../time';

/**
 * The timeline scrubber, and the run controls.
 *
 * Replay paces itself by the events' own timestamps, so a recorded run plays
 * back at the speed it actually happened. That is the whole point: on stage
 * this is presented as "here is a full run from this morning", and it has to
 * be true — same events, same order, same durations, same reducer.
 */
export function Scrubber({
  onStart,
  onLoop,
}: {
  onStart: (goal: string, mode: 'live' | 'rehearsal') => void;
  onLoop: (enabled: boolean, goal: string) => void;
}) {
  const { events, cursor, scrubbing, setCursor, follow, derived, runs, connected, loop, rejectionCursor } =
    useSwarm();
  const [goal, setGoal] = useState('Build and deploy a URL shortener with a real-time analytics dashboard showing clicks per link as a live-updating chart.');
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setPlaying(false);
  }, []);

  // Step forward one event at a time, waiting the gap the run actually had.
  useEffect(() => {
    if (!playing) return;
    if (cursor >= events.length) {
      stop();
      return;
    }
    const current = events[cursor - 1];
    const next = events[cursor];
    const gap = current && next ? Math.min(next.ts - current.ts, 2500) : 0;
    timer.current = window.setTimeout(() => setCursor(cursor + 1), Math.max(gap, 8));
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [playing, cursor, events, setCursor, stop]);

  const loadRun = (runId: string) => {
    stop();
    useSwarm.setState({ error: null });
    window.dispatchEvent(new CustomEvent('swarm:load-run', { detail: runId }));
  };

  return (
    <div className="scrub">
      <div className="scrub-inner">
        <label className="placard" htmlFor="goal">
          Goal
        </label>
        <input
          id="goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          style={{
            flex: '1 1 18rem',
            minWidth: '12rem',
            background: 'var(--void)',
            border: '1px solid var(--rule-bright)',
            color: 'var(--ink)',
            font: 'inherit',
            padding: '6px 9px',
          }}
        />
        {/*
          Disabled while the feed is down. A frame sent on a closed socket is
          dropped silently, which on stage reads as "I pressed the button and
          nothing happened" — the worst possible failure in front of a room.
        */}
        <button
          className="control primary"
          onClick={() => onStart(goal, 'live')}
          disabled={!connected}
          title={connected ? undefined : 'Waiting for the orchestrator feed'}
        >
          Run live
        </button>
        <button
          className="control"
          onClick={() => onStart(goal, 'rehearsal')}
          disabled={!connected}
          title={connected ? undefined : 'Waiting for the orchestrator feed'}
        >
          Rehearse
        </button>
        <button
          className="control"
          aria-pressed={loop.enabled}
          onClick={() => onLoop(!loop.enabled, goal)}
          disabled={!connected}
          title="Rehearse on repeat all session, leaving the shipped app up between runs"
        >
          {loop.enabled ? 'Loop on' : 'Loop'}
        </button>
        {loop.enabled && loop.nextRunInSeconds !== null && (
          <span className="counter">next in {loop.nextRunInSeconds}s</span>
        )}
        {!connected && <span className="counter">reconnecting…</span>}

        {runs.length > 0 && (
          <select
            aria-label="Load a recorded run"
            className="control"
            defaultValue=""
            onChange={(e) => e.target.value && loadRun(e.target.value)}
            style={{ background: 'var(--void)', maxWidth: '13rem' }}
          >
            <option value="">Recorded runs…</option>
            {runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {run.ok ? '✓' : '✗'} {new Date(run.startedAt).toLocaleTimeString()} · {run.eventCount} events
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="scrub-inner" style={{ borderTop: 'none' }}>
        <button
          className="control"
          onClick={() => (playing ? stop() : setPlaying(true))}
          disabled={events.length === 0}
        >
          {playing ? 'Pause' : 'Play'}
        </button>

        <input
          type="range"
          min={0}
          max={events.length}
          value={cursor}
          aria-label="Scrub the run timeline"
          onChange={(e) => {
            stop();
            setCursor(Number(e.target.value));
          }}
        />

        <span className="counter">
          {met(derived.startedAt, derived.now)} · {cursor}/{events.length}
        </span>

        {/*
          The single most valuable thirty seconds of any run, on a button. At a
          booth you cannot rely on someone arriving at the right moment.
        */}
        <button
          className="control"
          onClick={() => {
            const at = rejectionCursor();
            if (at === null) return;
            stop();
            setCursor(at);
            setPlaying(true);
          }}
          disabled={rejectionCursor() === null}
          title="Jump to the moment the Reviewer rejects the work"
        >
          The rejection
        </button>

        <button
          className="control"
          onClick={() => {
            stop();
            follow();
          }}
          disabled={!scrubbing}
        >
          Follow live
        </button>
      </div>
    </div>
  );
}
