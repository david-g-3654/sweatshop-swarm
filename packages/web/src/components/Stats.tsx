import type { SwarmState } from '../store';

/**
 * The two questions a passer-by actually has: is it working, and did it ship.
 *
 * This row used to carry six tiles. Two of them — elapsed and phase — repeated
 * the mission clock and the phase rail sitting directly above them, and two
 * more counted files and log lines, which answers nothing anyone asked. Six
 * small numbers next to the thing that already said four of them is filler.
 *
 * Two numbers, large enough to read from the back of the room, is the whole
 * job.
 */
function Tile({ label, value, tone }: { label: string; value: string; tone?: 'go' | 'nogo' }) {
  return (
    <div className="tile" data-tone={tone}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
    </div>
  );
}

export function Stats({ state }: { state: SwarmState }) {
  const tests = state.tests;

  return (
    <div className="stats">
      <Tile
        label="Tests"
        value={tests ? `${tests.passed} / ${tests.passed + tests.failed}` : '—'}
        {...(tests ? { tone: tests.ok ? ('go' as const) : ('nogo' as const) } : {})}
      />
      <Tile
        label="Shipped"
        value={state.deployUrl ? 'yes' : state.finished ? 'no' : '—'}
        {...(state.deployUrl
          ? { tone: 'go' as const }
          : state.finished
            ? { tone: 'nogo' as const }
            : {})}
      />
    </div>
  );
}
