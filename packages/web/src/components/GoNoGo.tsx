import { ROSTER } from '@swarm/shared';
import type { SwarmState } from '../store';

/**
 * The GO/NO-GO poll — the one piece of choreography in this interface.
 *
 * A review verdict genuinely is a go/no-go gate, so borrowing the flight
 * controller's poll is structurally honest rather than a costume. It takes the
 * screen for four seconds because it is the moment the demo turns on: the
 * audience has to register that one agent just refused another's work.
 *
 * Everything else in the UI stays deliberately quiet so that this reads.
 */

const WINDOW_MS = 3600;

export function GoNoGo({ state }: { state: SwarmState }) {
  // Once the run has landed, nothing gets to cover the URL. The deployed link
  // is the climax; a poll band still hanging over it steals the moment.
  if (state.finished) return null;

  const verdicts = state.handoffs.filter((h) => h.kind === 'reject' || h.kind === 'approve');
  const latest = verdicts[verdicts.length - 1];
  if (!latest || state.now === null || state.now - latest.at > WINDOW_MS) return null;

  const nogo = latest.kind === 'reject';

  // The reviewer's own words, not a summary the UI invented.
  const detail =
    [...state.drama]
      .reverse()
      .find((line) => line.at <= latest.at + 200 && line.agentId === 'reviewer')?.text ?? latest.summary;

  return (
    <div className="poll" aria-live="polite">
      <div className="poll-band" data-result={nogo ? 'nogo' : 'go'}>
        <p className="poll-verdict">{nogo ? 'No Go' : 'Go'}</p>
        <p className="poll-detail">{detail}</p>
        <div className="poll-stations">
          {ROSTER.map((spec, i) => (
            <span className="poll-station" key={spec.agentId} style={{ animationDelay: `${i * 55}ms` }}>
              {spec.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
