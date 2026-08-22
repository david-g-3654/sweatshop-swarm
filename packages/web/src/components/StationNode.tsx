import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AgentView } from '../store';
import { roleStyle } from '../role';
import { StatusBadge } from './StatusBadge';

/**
 * A console station. Fixed position, fixed callsign, one hue.
 *
 * The role's colour owns the node's identity — the rule, the name, the glow —
 * so the same agent is recognisable here, in the flight loop and in the console
 * without anyone reading a label. Status rides on the badge instead, on its own
 * colour channel, so "who" and "what are they doing" never compete.
 */
export function StationNode({ data }: NodeProps) {
  const agent = data.agent as AgentView;
  const active = agent.status === 'thinking' || agent.status === 'tool';

  return (
    <div
      className="station"
      style={roleStyle(agent.agentId)}
      data-active={active}
      data-status={agent.status}
    >
      <Handle type="target" position={Position.Left} />

      <div className="station-name">{agent.label}</div>
      <div className="station-model">{agent.model || '—'}</div>

      <StatusBadge status={agent.status} {...(agent.detail ? { detail: agent.detail } : {})} />

      <div className="station-meta">
        <span>turn {agent.turn}</span>
        <span>{agent.toolCalls} calls</span>
      </div>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
