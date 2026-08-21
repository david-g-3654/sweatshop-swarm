import { useSwarm } from './store';
import { useSocket } from './useSocket';
import { StatusStrip } from './components/StatusStrip';
import { Graph } from './components/Graph';
import { FlightLoop } from './components/FlightLoop';
import { ConsolePanel } from './components/ConsolePanel';
import { Workspace } from './components/Workspace';
import { Scrubber } from './components/Scrubber';
import { GoNoGo } from './components/GoNoGo';

export function App() {
  const { send } = useSocket();
  const { derived, connected, error } = useSwarm();

  return (
    <div className="shell">
      <StatusStrip state={derived} connected={connected} />

      <div className="stage">
        <section className="bay">
          <header>
            <span className="placard">The team</span>
            <span className="placard">
              {derived.tests ? `${derived.tests.passed} passing · ${derived.tests.failed} failing` : 'no test run yet'}
            </span>
          </header>
          <div className="body" style={{ overflow: 'hidden' }}>
            <Graph state={derived} />
          </div>
        </section>

        <FlightLoop state={derived} />
      </div>

      <div className="console-column">
        <ConsolePanel state={derived} />
        <Workspace state={derived} />
      </div>

      {(derived.deployUrl || error) && (
        <div className="ship-row">
          {derived.deployUrl && (
            <p className="shipped">
              <span className="placard">Shipped</span>
              <a href={derived.deployUrl} target="_blank" rel="noreferrer">
                {derived.deployUrl}
              </a>
            </p>
          )}
          {error && (
            <p className="shipped" style={{ borderColor: 'var(--nogo)', background: 'rgba(255,111,107,.08)' }}>
              <span className="placard">Feed</span>
              <span>{error}</span>
            </p>
          )}
        </div>
      )}

      <Scrubber onStart={(goal, mode) => send({ kind: 'start', goal, mode })} />

      <GoNoGo state={derived} />
    </div>
  );
}
