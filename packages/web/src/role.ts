import { ROSTER, type AgentStatus } from '@swarm/shared';

/**
 * Role colour, as the primary visual language.
 *
 * The roster has carried an accent per role since the first commit and nothing
 * ever drew with it. That is the difference between a viewer tracking an agent
 * across four panels by hue and having to stop and read labels — which, from
 * the back of a room, means not tracking it at all.
 *
 * Hue answers "who". Status answers "what are they doing". Keeping those on
 * separate channels is what lets both be read at a glance.
 */
const ACCENTS = new Map(ROSTER.map((spec) => [spec.agentId, spec.accent]));

export function roleAccent(agentId: string | undefined): string {
  return (agentId && ACCENTS.get(agentId)) || 'var(--dim)';
}

/** Inline custom property, so any rule beneath can reference the role hue. */
export function roleStyle(agentId: string | undefined): React.CSSProperties {
  return { ['--role' as string]: roleAccent(agentId) };
}

export interface StatusLook {
  label: string;
  glyph: string;
  tone: 'idle' | 'busy' | 'bad' | 'good';
}

/**
 * Status as a glyph plus a colour, not a word.
 *
 * A badge that only differs by its text is invisible at distance; the shape and
 * the colour do the work and the word confirms it up close.
 */
export const STATUS: Record<AgentStatus, StatusLook> = {
  idle: { label: 'standby', glyph: '○', tone: 'idle' },
  thinking: { label: 'thinking', glyph: '◆', tone: 'busy' },
  tool: { label: 'tool', glyph: '▶', tone: 'busy' },
  waiting: { label: 'waiting', glyph: '⋯', tone: 'idle' },
  blocked: { label: 'blocked', glyph: '▲', tone: 'bad' },
  done: { label: 'complete', glyph: '✓', tone: 'good' },
  failed: { label: 'failed', glyph: '✕', tone: 'bad' },
};

/**
 * Strip the markdown a model puts around its prose.
 *
 * Reviewers write findings with **bold** and `code`, which is right in a review
 * and wrong on a projector — the asterisks and backticks render literally and
 * the most important sentence in the demo looks broken. This is display-only;
 * the stored event keeps the original text.
 */
export function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)_(.+?)_(?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}
