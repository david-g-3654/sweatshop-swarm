import { ROSTER } from '@swarm/shared';
import type { EventBus } from './bus.js';

/**
 * Give every agent a final resting state when a run ends.
 *
 * Without this an agent keeps whatever status it last emitted — so a station
 * finishes the run insisting it is mid `write_file`, and on a booth loop it
 * says that for the rest of the day. A finished run should look finished.
 *
 * Agents that were already blocked or failed keep that: it is the truth, and
 * it is worth seeing.
 */
export function settleAgents(bus: EventBus, ok: boolean): void {
  const stuck = new Set(['blocked', 'failed']);
  const lastStatus = new Map<string, string>();

  for (const event of bus.log) {
    if (event.type === 'agent.status') lastStatus.set(event.agentId, event.status);
  }

  for (const spec of ROSTER) {
    if (stuck.has(lastStatus.get(spec.agentId) ?? '')) continue;
    bus.emit({ type: 'agent.status', agentId: spec.agentId, status: ok ? 'done' : 'idle' });
  }
}
