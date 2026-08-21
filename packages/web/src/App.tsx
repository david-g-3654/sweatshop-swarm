import { useEffect, useState } from 'react';
import { useSwarm } from './store';
import { useSocket } from './useSocket';
import { StatusStrip } from './components/StatusStrip';
import { Graph } from './components/Graph';
import { FlightLoop } from './components/FlightLoop';
import { ConsolePanel } from './components/ConsolePanel';
import { Workspace } from './components/Workspace';
import { Scrubber } from './components/Scrubber';
import { GoNoGo } from './components/GoNoGo';
import { Artifact } from './components/Artifact';

export function App() {
  const { send } = useSocket();
  const { derived, connected, error, replay } = useSwarm();
  const [stageView, setStageView] = useState<'graph' | 'artifact'>('graph');

  // The moment a URL exists, show what was built. Scrubbing back to before the
  // deploy takes the view with it, so the panel never shows a stale artifact.
  const deployUrl = derived.deployUrl;
  useEffect(() => {
    // Only jump to the artifact for a run happening now. A recording's URL
    // points at an app that stopped running when that run ended.
    setStageView(deployUrl && !replay ? 'artifact' : 'graph');
  }, [deployUrl, replay]);

  const showing = deployUrl ? stageView : 'graph';

  return (
    <div className="shell">
      <StatusStrip state={derived} connected={connected} />

      <div className="stage">
        <section className="bay">
          <header>
            <span className="placard">{showing === 'artifact' ? 'What they shipped' : 'The team'}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="placard">
                {derived.tests
                  ? `${derived.tests.passed} passing · ${derived.tests.failed} failing`
                  : 'no test run yet'}
              </span>
              {deployUrl && (
                <span className="view-toggle" role="group" aria-label="Stage view">
                  <button
                    className="tab"
                    aria-selected={showing === 'graph'}
                    onClick={() => setStageView('graph')}
                  >
                    Graph
                  </button>
                  <button
                    className="tab"
                    aria-selected={showing === 'artifact'}
                    onClick={() => setStageView('artifact')}
                  >
                    Live app
                  </button>
                </span>
              )}
            </span>
          </header>
          <div className="body" style={{ overflow: 'hidden' }}>
            {showing === 'artifact' ? <Artifact state={derived} replay={replay} /> : <Graph state={derived} />}
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

      <Scrubber
        onStart={(goal, mode) => send({ kind: 'start', goal, mode })}
        onLoop={(enabled, goal) => send({ kind: 'set-loop', enabled, goal })}
      />

      <GoNoGo state={derived} />
    </div>
  );
}
