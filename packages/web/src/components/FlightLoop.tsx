import { useEffect, useRef } from 'react';
import type { SwarmState } from '../store';
import { met } from '../time';
import { roleStyle, plain } from '../role';

const MARK = { info: '·', good: '✓', warn: '!', bad: '✗' } as const;

/**
 * The flight director's loop.
 *
 * This is the line the audience actually reads, so it is the largest body text
 * on the screen and it never has to be interpreted — every entry is a plain
 * sentence about something that just happened.
 */
export function FlightLoop({ state }: { state: SwarmState }) {
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [state.drama.length]);

  return (
    <section className="bay">
      <header>
        <span className="placard">Flight loop</span>
        <span className="placard">{state.drama.length} calls</span>
      </header>
      <div className="body loop">
        {state.drama.length === 0 && (
          <p className="empty">Quiet. Start a run and the team's traffic shows up here.</p>
        )}
        {state.drama.map((line) => (
          <div
            className="loop-line"
            data-level={line.level}
            data-has-role={Boolean(line.agentId)}
            style={roleStyle(line.agentId)}
            key={line.seq}
          >
            <time>{met(state.startedAt, line.at)}</time>
            <span className="mark">{MARK[line.level]}</span>
            <span className="text">{plain(line.text)}</span>
          </div>
        ))}
        <div ref={bottom} />
      </div>
    </section>
  );
}
