import { useMemo, useRef } from 'react';
import { useSwarm } from '../store';
import { roleAccent } from '../role';

/**
 * The run, as a strip.
 *
 * Borrowed from the event-timeline heatmap in the Figma template, except that
 * here it is not decoration — it is the scrubber. Each column is a slice of the
 * run coloured by whichever agent produced most of its events, so the shape of
 * a run is legible without reading anything: a blue planning block, two green
 * engineer blocks interleaved, a long amber review block, then a short bright
 * tail where it tests and ships.
 *
 * It also does the job the plain slider did, and does it better — you can see
 * where the interesting part is before you drag to it.
 */
const COLUMNS = 120;

export function Timeline() {
  const { events, cursor, setCursor } = useSwarm();
  const strip = useRef<HTMLDivElement>(null);

  const columns = useMemo(() => {
    if (events.length === 0) return [];
    const perColumn = Math.max(1, Math.ceil(events.length / COLUMNS));
    const out: { accent: string; weight: number; index: number; verdict: 'reject' | 'approve' | null }[] = [];

    for (let start = 0; start < events.length; start += perColumn) {
      const slice = events.slice(start, start + perColumn);
      const byAgent = new Map<string, number>();
      let verdict: 'reject' | 'approve' | null = null;

      for (const event of slice) {
        const agentId =
          'agentId' in event ? (event as { agentId?: string }).agentId : ('from' in event ? event.from : undefined);
        if (agentId) byAgent.set(agentId, (byAgent.get(agentId) ?? 0) + 1);
        if (event.type === 'message.sent' && event.kind === 'reject') verdict = 'reject';
        if (event.type === 'message.sent' && event.kind === 'approve' && verdict !== 'reject') verdict = 'approve';
      }

      const busiest = [...byAgent.entries()].sort((a, b) => b[1] - a[1])[0];
      out.push({
        accent: busiest ? roleAccent(busiest[0]) : 'var(--rule-bright)',
        // Height carries how much was happening, so quiet stretches read as quiet.
        weight: Math.min(1, slice.length / perColumn),
        index: start,
        verdict,
      });
    }
    return out;
  }, [events]);

  if (events.length === 0) {
    return <div className="timeline timeline-empty" aria-hidden="true" />;
  }

  const progress = events.length ? cursor / events.length : 0;

  const seek = (clientX: number) => {
    const box = strip.current?.getBoundingClientRect();
    if (!box) return;
    const ratio = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
    setCursor(Math.round(ratio * events.length));
  };

  return (
    <div
      className="timeline"
      ref={strip}
      role="slider"
      tabIndex={0}
      aria-label="Run timeline"
      aria-valuemin={0}
      aria-valuemax={events.length}
      aria-valuenow={cursor}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) seek(e.clientX);
      }}
      onKeyDown={(e) => {
        const step = Math.max(1, Math.round(events.length / 60));
        if (e.key === 'ArrowLeft') setCursor(cursor - step);
        if (e.key === 'ArrowRight') setCursor(cursor + step);
      }}
    >
      {columns.map((column, i) => (
        <i
          key={i}
          className="tick"
          data-verdict={column.verdict ?? undefined}
          style={{
            background: column.accent,
            height: `${28 + column.weight * 72}%`,
            opacity: i / columns.length <= progress ? 1 : 0.28,
          }}
        />
      ))}
      <span className="timeline-head" style={{ left: `${progress * 100}%` }} />
    </div>
  );
}
