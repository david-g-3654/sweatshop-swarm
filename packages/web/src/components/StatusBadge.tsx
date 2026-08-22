import type { AgentStatus } from '@swarm/shared';
import { STATUS } from '../role';

export function StatusBadge({ status, detail }: { status: AgentStatus; detail?: string }) {
  const look = STATUS[status] ?? STATUS.idle;
  return (
    <span className="status-badge" data-tone={look.tone} data-status={status}>
      <span className="status-glyph" aria-hidden="true">
        {look.glyph}
      </span>
      <span className="status-text">{detail ?? look.label}</span>
    </span>
  );
}
