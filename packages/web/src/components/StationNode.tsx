import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AgentView } from '../store';

const STATUS_LABEL: Record<string, string> = {
  idle: 'standby',
  thinking: 'generating',
  tool: 'tool',
  waiting: 'waiting',
  blocked: 'blocked',
  done: 'complete',
  failed: 'failed',
};

/**
 * A console station. Fixed position, fixed callsign, one lamp.
 *
 * Deliberately not a card with an avatar: from fifteen metres you can read a
 * name, a lamp and a colour, and nothing else. Everything on it earns its place
 * by being legible at that distance.
 */
export function StationNode({ data }: NodeProps) {
  const agent = data.agent as AgentView;
  const active = agent.status === 'thinking' || agent.status === 'tool';

  return (
    <div className="station" data-active={active} data-status={agent.status}>
      <Handle type="target" position={Position.Left} />
      <div className="station-name">{agent.label}</div>
      <div className="station-model">{agent.model || '—'}</div>

      <div className="station-status">
        <span className="lamp" data-status={agent.status} />
        <span>{agent.detail ?? STATUS_LABEL[agent.status] ?? agent.status}</span>
      </div>

      <div className="station-meta">
        <span>turn {agent.turn}</span>
        <span>{agent.toolCalls} calls</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
