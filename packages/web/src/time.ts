/** Mission elapsed time: how far into the run an event happened. */
export function met(startedAt: number | null, at: number | null): string {
  if (startedAt === null || at === null) return '--:--:--';
  const seconds = Math.max(0, Math.floor((at - startedAt) / 1000));
  const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
