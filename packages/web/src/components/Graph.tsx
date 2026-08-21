import { useMemo } from 'react';
import { ReactFlow, Background, BackgroundVariant, type Edge, type Node } from '@xyflow/react';
import { ROSTER } from '@swarm/shared';
import { StationNode } from './StationNode';
import type { SwarmState } from '../store';

const NODE_TYPES = { station: StationNode };

/**
 * Fixed stations, one column per phase, so the graph reads left to right the
 * way the pipeline actually runs.
 *
 * The geometry is tuned to the shape of the bay it sits in, not chosen for
 * tidiness. fitView scales to whichever axis is tighter, so a graph that is
 * much wider than its container gets shrunk until the station names are
 * unreadable on a projector. Keeping the overall extent near the bay's aspect
 * ratio is what keeps the type large.
 */
const COL = 250;
const POSITIONS: Record<string, { x: number; y: number }> = {
  planner: { x: 0, y: 130 },
  'engineer-a': { x: COL, y: 0 },
  'engineer-b': { x: COL, y: 260 },
  reviewer: { x: COL * 2, y: 130 },
  tester: { x: COL * 3, y: 130 },
  deployer: { x: COL * 4, y: 130 },
};

/**
 * How long a handoff stays lit after it happens.
 *
 * Deliberately longer than the GO/NO-GO band (4.2s): when the band clears, the
 * audience should look down and still see the red edge running back to the
 * engineers. If this were shorter the edge would already be cold and the
 * cause-and-effect would be lost.
 */
const HOT_WINDOW_MS = 9000;

export function Graph({ state }: { state: SwarmState }) {
  const nodes = useMemo<Node[]>(
    () =>
      ROSTER.map((spec) => ({
        id: spec.agentId,
        type: 'station',
        position: POSITIONS[spec.agentId] ?? { x: 0, y: 0 },
        data: { agent: state.agents[spec.agentId]! },
        draggable: false,
        selectable: false,
      })),
    [state.agents],
  );

  const edges = useMemo<Edge[]>(() => {
    // Collapse repeated handoffs down to the latest one per from->to->kind, so
    // three review rounds do not stack three identical arrows on top of
    // each other.
    const latest = new Map<string, (typeof state.handoffs)[number]>();
    for (const handoff of state.handoffs) {
      latest.set(`${handoff.from}->${handoff.to}:${handoff.kind}`, handoff);
    }

    return [...latest.values()].map((handoff) => {
      const hot = state.now !== null && state.now - handoff.at < HOT_WINDOW_MS;
      return {
        id: `${handoff.from}-${handoff.to}-${handoff.kind}`,
        source: handoff.from,
        target: handoff.to,
        animated: hot,
        label: hot ? handoff.summary : undefined,
        // React Flow puts className on the edge group; data-* attributes are
        // not forwarded, so the styling hook has to be a class.
        className: `edge-${handoff.kind}${hot ? ' edge-hot' : ''}`,
        labelStyle: { fill: '#e9eef8', fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' },
        labelBgStyle: { fill: '#0e131c' },
        labelBgPadding: [6, 3] as [number, number],
      };
    });
  }, [state.handoffs, state.now]);

  return (
    <ReactFlow
      className="graph"
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      fitView
      fitViewOptions={{ padding: 0.06 }}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnDrag
      zoomOnScroll
      minZoom={0.3}
      maxZoom={1.6}
      colorMode="dark"
      onlyRenderVisibleElements={false}
    >
      <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="#2b3548" />
    </ReactFlow>
  );
}
