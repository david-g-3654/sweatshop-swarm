import { PHASE_ORDER } from '@arena/shared';
import type { ArenaState } from '../store';
import { met } from '../time';

const PHASE_LABEL: Record<string, string> = {
  planning: 'plan',
  building: 'build',
  review: 'review',
  testing: 'test',
  deploying: 'deploy',
};

export function StatusStrip({ state, connected }: { state: ArenaState; connected: boolean }) {
  const currentIndex = state.phase ? PHASE_ORDER.indexOf(state.phase) : -1;

  const badge = !connected
    ? { className: 'offline', text: 'No feed' }
    : state.mode === 'rehearsal'
      ? { className: 'rehearsal', text: 'Rehearsal' }
      : state.mode === 'live'
        ? { className: 'live', text: 'Live' }
        : { className: 'rehearsal', text: 'Standby' };

  return (
    <div className="strip">
      <div className="strip-inner">
        <span className="met" aria-label="mission elapsed time">
          {met(state.startedAt, state.now)}
        </span>
        <span className="wordmark">Agent Arena</span>

        <span className="goal">
          {state.goal ? <b>{state.goal}</b> : 'No run loaded.'}
        </span>

        <div className="rail" role="list" aria-label="pipeline phase">
          {PHASE_ORDER.filter((phase) => phase !== 'done').map((phase) => {
            const index = PHASE_ORDER.indexOf(phase);
            const stateAttr =
              currentIndex < 0
                ? 'future'
                : index < currentIndex
                  ? 'past'
                  : index === currentIndex
                    ? 'current'
                    : 'future';
            return (
              <span className="rail-step" data-state={stateAttr} role="listitem" key={phase}>
                {PHASE_LABEL[phase] ?? phase}
              </span>
            );
          })}
        </div>

        <span className={`badge ${badge.className}`}>{badge.text}</span>
      </div>
    </div>
  );
}
