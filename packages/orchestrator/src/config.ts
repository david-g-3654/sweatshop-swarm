import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, derived from this file rather than cwd so npm scripts can run anywhere. */
export const REPO_ROOT = path.resolve(here, '../../..');

/** Every file an agent touches lives under here. Nothing escapes it. */
export const SANDBOX_ROOT = path.join(REPO_ROOT, 'sandbox');
export const RUNS_DIR = path.join(REPO_ROOT, 'runs');

export const MODELS = {
  /** The Planner does the hard reasoning: decomposition, and re-planning on failure. */
  planner: process.env.ARENA_PLANNER_MODEL ?? 'claude-opus-5',
  /** Workers. Cheaper and faster, which matters when six agents run in one demo. */
  worker: process.env.ARENA_WORKER_MODEL ?? 'claude-sonnet-5',
} as const;

/**
 * Effort replaces temperature as the determinism knob.
 *
 * Sampling parameters (temperature/top_p/top_k) are rejected with a 400 on
 * Sonnet 5 and Opus 5, so "turn the temperature down for a reliable demo" is
 * not available. What we have instead: effort, hard turn caps, tight tool
 * whitelists, and a Planner prompt carrying the expected decomposition as a
 * strong prior. Structure does the work temperature used to.
 */
export const EFFORT = {
  planner: 'high',
  worker: 'medium',
  reviewer: 'high',
} as const;

/** Hard ceilings. An agent that hits its cap is failed, not left to wander. */
export const LIMITS = {
  maxTurnsPerAgent: Number(process.env.ARENA_MAX_TURNS ?? 14),
  maxReviewRounds: Number(process.env.ARENA_MAX_REVIEW_ROUNDS ?? 3),
  commandTimeoutMs: Number(process.env.ARENA_CMD_TIMEOUT_MS ?? 90_000),
  maxToolResultChars: 12_000,
  maxFileBytes: 200_000,
} as const;

export const PORTS = {
  ws: Number(process.env.ARENA_WS_PORT ?? 8787),
  /** The port the shipped app is served on. */
  app: Number(process.env.ARENA_APP_PORT ?? 4310),
} as const;

/**
 * Multiplier on every scripted pause in rehearsal mode.
 *
 * At 1 the whole run finishes in about nine seconds, which is great for
 * iterating and useless on stage — nobody can read it. 2.5 puts a full run at
 * roughly half a minute, which is the pace you can actually narrate over.
 */
export const REHEARSAL_SPEED = Number(process.env.ARENA_REHEARSAL_SPEED ?? 2.5);

export const DEPLOY_TARGET = (process.env.ARENA_DEPLOY_TARGET ?? 'tunnel') as
  | 'tunnel'
  | 'local'
  | 'fly';
