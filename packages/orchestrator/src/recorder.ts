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

export async function save(run: RecordedRun): Promise<string> {
  await fs.mkdir(RUNS_DIR, { recursive: true });
  const file = path.join(RUNS_DIR, `${run.runId}.json`);
  await fs.writeFile(file, JSON.stringify(run, null, 2), 'utf8');
  return file;
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
