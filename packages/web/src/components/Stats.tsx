import type { SwarmState } from '../store';
import { met } from '../time';

/**
 * The KPI row, lifted from the template and pointed at things that matter here.
 *
 * Big numbers, few of them, readable from across a room — that is the whole
 * job. A booth visitor should be able to answer "is it working, how far in, did
 * it cost anything" from ten feet away without asking.
 */
function Tile({ label, value, tone }: { label: string; value: string; tone?: 'go' | 'nogo' | 'phosphor' }) {
  return (
    <div className="tile" data-tone={tone}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
    </div>
  );
}

export function Stats({ state }: { state: SwarmState }) {
  const tests = state.tests;
  const phase = state.phase ?? 'standby';

  return (
    <div className="stats">
      <Tile label="Elapsed" value={met(state.startedAt, state.now)} tone="phosphor" />
      <Tile label="Phase" value={phase} />
      <Tile
        label="Tests"
        value={tests ? `${tests.passed} / ${tests.passed + tests.failed}` : '—'}
        {...(tests ? { tone: tests.ok ? ('go' as const) : ('nogo' as const) } : {})}
      />
      <Tile label="Files" value={String(Object.keys(state.files).length)} />
      {/* Not "Events": the scrubber counts events too, and it reports a number
          two orders of magnitude larger. One word, two numbers, ten centimetres
          apart is a question you get asked all day. */}
      <Tile label="Log" value={String(state.drama.length)} />
      <Tile
        label="Shipped"
        value={state.deployUrl ? 'yes' : state.finished ? 'no' : '—'}
        {...(state.deployUrl ? { tone: 'go' as const } : {})}
      />
    </div>
  );
}
