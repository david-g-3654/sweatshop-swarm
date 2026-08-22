import { useEffect, useRef, useState } from 'react';
import { ROSTER } from '@swarm/shared';
import { roleStyle } from '../role';
import { StatusBadge } from './StatusBadge';
import type { SwarmState } from '../store';

/**
 * One station's console: what that agent is saying, as it says it.
 *
 * The tab auto-follows whichever station is generating, because on stage
 * nobody is clicking tabs. It stops following the moment you pick one
 * yourself — the operator always outranks the autopilot.
 */
export function ConsolePanel({ state }: { state: SwarmState }) {
  const [pinned, setPinned] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);

  // Follow whoever is actually producing text, not merely whoever flipped to
  // 'thinking'. Switching on status alone means the panel jumps to an agent
  // that has not said a word yet and shows an empty state mid-demo.
  const [following, setFollowing] = useState(ROSTER[0]!.agentId);
  const speaking =
    ROSTER.find((spec) => {
      const view = state.agents[spec.agentId];
      return view?.status === 'thinking' && view.stream.length > 0;
    })?.agentId ?? null;

  useEffect(() => {
    if (speaking) setFollowing(speaking);
  }, [speaking]);

  const selected = pinned ?? following;
  const agent = state.agents[selected];

  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [agent?.stream, agent?.messages.length]);

  return (
    <section className="bay">
      <header>
        <span className="placard" style={roleStyle(selected)}>
          <span className="console-dot" /> {agent?.label ?? 'Console'}
        </span>
        <span className="placard">
          {agent ? <StatusBadge status={agent.status} /> : null} {pinned ? 'pinned' : 'following'}
        </span>
      </header>

      <div className="tabs" role="tablist" aria-label="Agent consoles">
        {ROSTER.map((spec) => {
          const view = state.agents[spec.agentId];
          const busy = view?.status === 'thinking' || view?.status === 'tool';
          return (
            <button
              key={spec.agentId}
              className="tab tab-role"
              role="tab"
              style={roleStyle(spec.agentId)}
              aria-selected={selected === spec.agentId}
              onClick={() => setPinned(pinned === spec.agentId ? null : spec.agentId)}
            >
              {busy && <span className="lamp" data-status={view?.status} />}
              {spec.label}
            </button>
          );
        })}
      </div>

      <div className="body transcript" ref={body} style={roleStyle(selected)}>
        {!agent || (agent.messages.length === 0 && !agent.stream) ? (
          <p className="empty">{agent?.label ?? 'This station'} has not said anything yet.</p>
        ) : (
          <>
            {agent.messages.map((message, i) => (
              <div className="past" key={i}>
                {message}
              </div>
            ))}
            {agent.stream && (
              <div className="live">
                {agent.stream}
                {agent.status === 'thinking' && <span className="caret" />}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
