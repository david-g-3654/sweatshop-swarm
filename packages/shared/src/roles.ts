import type { Phase } from './events.js';

/**
 * The roster. Shared so the frontend can lay out the graph before the run
 * starts (empty nodes, greyed out) instead of popping them in mid-demo.
 */
export type RoleName = 'planner' | 'engineer' | 'reviewer' | 'tester' | 'deployer';

export interface RoleSpec {
  role: RoleName;
  /** Stable id used in events. Engineers are numbered: engineer-a, engineer-b. */
  agentId: string;
  label: string;
  /** Which graph column this node sits in. */
  phase: Phase;
  accent: string;
}

export const ROSTER: RoleSpec[] = [
  { role: 'planner',  agentId: 'planner',    label: 'Planner',    phase: 'planning',  accent: '#7c9cff' },
  { role: 'engineer', agentId: 'engineer-a', label: 'Engineer A', phase: 'building',  accent: '#4ade80' },
  { role: 'engineer', agentId: 'engineer-b', label: 'Engineer B', phase: 'building',  accent: '#34d399' },
  { role: 'reviewer', agentId: 'reviewer',   label: 'Reviewer',   phase: 'review',    accent: '#fbbf24' },
  { role: 'tester',   agentId: 'tester',     label: 'Tester',     phase: 'testing',   accent: '#f472b6' },
  { role: 'deployer', agentId: 'deployer',   label: 'Deployer',   phase: 'deploying', accent: '#22d3ee' },
];

export const PHASE_ORDER: Phase[] = [
  'planning',
  'building',
  'review',
  'testing',
  'deploying',
  'done',
];

export function roleOf(agentId: string): RoleSpec | undefined {
  return ROSTER.find((r) => r.agentId === agentId);
}
