import fs from 'node:fs/promises';
import path from 'node:path';
import { RUNS_DIR } from './config.js';
import type { RecordedRun, RunSummary } from '@swarm/shared';
import { summarise } from '@swarm/shared';

/**
 * Recorded runs.
 *
 * A recording is the event log and nothing else, because the event log is the
 * only thing the UI ever consumed. Replaying one is not a special mode — the
 * frontend cannot tell a recorded run from a live one, which is exactly why
 * the scrubber is honest to show on stage.
 */

/**
 * How many recordings to keep on disk.
 *
 * The booth loop produces a run every couple of minutes for a whole day. Left
 * alone that is hundreds of files, a few hundred kilobytes each, and a run
 * picker nobody can find anything in. Keeping a rolling window costs nothing —
 * the interesting run is almost always a recent one, and anything genuinely
 * worth keeping can be copied out of runs/.
 */
const KEEP_RECORDINGS = Number(process.env.SWARM_KEEP_RUNS ?? 40);

export async function save(run: RecordedRun): Promise<string> {
  await fs.mkdir(RUNS_DIR, { recursive: true });
  const file = path.join(RUNS_DIR, `${run.runId}.json`);
  await fs.writeFile(file, JSON.stringify(run, null, 2), 'utf8');
  await prune();
  return file;
}

/** Delete the oldest recordings beyond the rolling window. */
export async function prune(keep: number = KEEP_RECORDINGS): Promise<number> {
  try {
    const names = (await fs.readdir(RUNS_DIR))
      .filter((n) => n.endsWith('.json'))
      // sample-* recordings are checked into the repo on purpose. Housekeeping
      // that deletes tracked files is not housekeeping.
      .filter((n) => !n.startsWith('sample-'));
    if (names.length <= keep) return 0;

    const dated = await Promise.all(
      names.map(async (name) => ({
        name,
        at: (await fs.stat(path.join(RUNS_DIR, name))).mtimeMs,
      })),
    );
    dated.sort((a, b) => b.at - a.at);

    const doomed = dated.slice(keep);
    for (const { name } of doomed) {
      await fs.rm(path.join(RUNS_DIR, name), { force: true });
    }
    return doomed.length;
  } catch {
    // Pruning is housekeeping. It must never be the reason a run fails.
    return 0;
  }
}

export async function load(runId: string): Promise<RecordedRun | null> {
  // Guard the path: run ids come off the wire.
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return null;
  try {
    const raw = await fs.readFile(path.join(RUNS_DIR, `${runId}.json`), 'utf8');
    return JSON.parse(raw) as RecordedRun;
  } catch {
    return null;
  }
}

export async function list(): Promise<RunSummary[]> {
  try {
    const names = await fs.readdir(RUNS_DIR);
    const runs: RunSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(RUNS_DIR, name), 'utf8');
        runs.push(summarise(JSON.parse(raw) as RecordedRun));
      } catch {
        // A half-written recording should not break the run list.
      }
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}
