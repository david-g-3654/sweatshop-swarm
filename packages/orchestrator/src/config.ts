import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, derived from this file rather than cwd so npm scripts can run anywhere. */
export const REPO_ROOT = path.resolve(here, '../../..');

/** Every file an agent touches lives under here. Nothing escapes it. */
export const SANDBOX_ROOT = path.join(REPO_ROOT, 'sandbox');
export const RUNS_DIR = path.join(REPO_ROOT, 'runs');

/**
 * Which gateway we talk to.
 *
 * OpenRouter exposes an Anthropic-native /v1/messages endpoint, not just the
 * OpenAI-compatible one, so the agent loop is identical either way — only the
 * base URL, the key and the model naming change. Auto-detected from whichever
 * key is present so there is one less thing to get wrong at 2am.
 */
export const PROVIDER = (process.env.ARENA_PROVIDER ??
  (process.env.OPENROUTER_API_KEY ? 'openrouter' : 'anthropic')) as 'openrouter' | 'anthropic';

/**
 * Note the missing /v1 — the Anthropic SDK appends `/v1/messages` itself, so
 * pointing this at .../api/v1 produces .../api/v1/v1/messages and a 404 page
 * that is not remotely obvious from the error.
 */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

/** OpenRouter namespaces every model by vendor; the direct API does not. */
function qualify(model: string): string {
  return PROVIDER === 'openrouter' ? `anthropic/${model}` : model;
}

export const MODELS = {
  /** The Planner does the hard reasoning: decomposition, and re-planning on failure. */
  planner: process.env.ARENA_PLANNER_MODEL ?? qualify('claude-opus-5'),
  /** Workers. Cheaper and faster, which matters when six agents run in one demo. */
  worker: process.env.ARENA_WORKER_MODEL ?? qualify('claude-sonnet-5'),
} as const;

/**
 * Optional request features, each independently switchable.
 *
 * A gateway is not obliged to accept every parameter the first-party API takes,
 * and a rejected parameter is a 400 that kills the run rather than degrading
 * it. So these default to on for the direct API and off for OpenRouter, and
 * `npm run probe` finds out which ones actually work against your key and
 * prints the .env lines to turn them back on.
 *
 * Losing them costs polish, not correctness:
 * - thinking off  -> the console panel streams visible text but no reasoning
 *                    summary. Both Sonnet 5 and Opus 5 still think adaptively
 *                    when the parameter is simply omitted.
 * - effort off    -> model default (high).
 * - strict off    -> tool inputs are validated by us instead of the API.
 * - cache off     -> the system prompt is billed in full every turn.
 */
function feature(name: string, defaultOn: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultOn;
  return raw === '1' || raw.toLowerCase() === 'true';
}

const RICH = PROVIDER === 'anthropic';

export const FEATURES = {
  thinking: feature('ARENA_THINKING', RICH),
  effort: feature('ARENA_EFFORT', RICH),
  strictTools: feature('ARENA_STRICT_TOOLS', RICH),
  promptCache: feature('ARENA_PROMPT_CACHE', true),
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
