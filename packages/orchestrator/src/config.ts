import fs from 'node:fs';
import { config as loadEnv, parse as parseEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, derived from this file rather than cwd so npm scripts can run anywhere. */
export const REPO_ROOT = path.resolve(here, '../../..');

/**
 * Load .env from the repo root, by absolute path.
 *
 * `dotenv/config` reads from process.cwd(), and `npm --workspace ... run x`
 * sets cwd to the *package* directory — so the root .env everything documents
 * was silently never read, and every run looked like a missing key. Deriving
 * the path from this file's location instead makes it work from any cwd.
 */
const ENV_FILE = path.join(REPO_ROOT, '.env');

/**
 * Load .env without overriding the shell, then rescue one specific case.
 *
 * Blanket `override: true` was the obvious fix and the wrong one: it also
 * overrode deliberate command-line settings, so `SWARM_PROVIDER=anthropic npm
 * run …` silently kept using OpenRouter. Normal precedence has to survive.
 *
 * The case actually worth rescuing is narrow: a *credential* exported in the
 * shell that cannot possibly work — the signature of a paste with an
 * unterminated quote, which swallows the following lines into the value. That
 * beat a perfectly good .env and made every agent fail with an error about an
 * HTTP header rather than about a key.
 *
 * So: a usable shell value always wins, an unusable one is replaced from .env,
 * and either way nothing happens silently.
 */
const CREDENTIALS = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'] as const;

/** Could this be sent as an HTTP header at all? */
function usableCredential(value: string | undefined): value is string {
  return !!value && value.trim().length > 0 && !/\s/.test(value.trim()) && !value.includes('export ');
}

const fileVars: Record<string, string> = fs.existsSync(ENV_FILE)
  ? parseEnv(fs.readFileSync(ENV_FILE))
  : {};

loadEnv({ path: ENV_FILE });

for (const key of CREDENTIALS) {
  const fromShell = process.env[key];
  const fromFile = fileVars[key];
  if (!fromShell || !fromFile || fromShell === fromFile) continue;

  if (usableCredential(fromShell)) {
    // A deliberate override. Note it, change nothing.
    console.warn(`[swarm] ${key} is set in your shell, so .env's value is being ignored.`);
    continue;
  }

  process.env[key] = fromFile;
  console.warn(
    `[swarm] ${key} in your shell contains whitespace or shell syntax and cannot be sent\n` +
      `        as an HTTP header — using the value from .env instead.\n` +
      `        To clear it for good:  unset ${key}\n` +
      `        and check ~/.zshrc for an export line whose quote is never closed.`,
  );
}

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
export const PROVIDER = (process.env.SWARM_PROVIDER ??
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
  planner: process.env.SWARM_PLANNER_MODEL ?? qualify('claude-opus-5'),
  /** Workers. Cheaper and faster, which matters when six agents run in one demo. */
  worker: process.env.SWARM_WORKER_MODEL ?? qualify('claude-sonnet-5'),
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
  thinking: feature('SWARM_THINKING', RICH),
  effort: feature('SWARM_EFFORT', RICH),
  strictTools: feature('SWARM_STRICT_TOOLS', RICH),
  promptCache: feature('SWARM_PROMPT_CACHE', true),
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
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

function effortFor(role: string, fallback: Effort): Effort {
  const raw = process.env[`SWARM_EFFORT_${role.toUpperCase()}`];
  const allowed: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  return allowed.includes(raw as Effort) ? (raw as Effort) : fallback;
}

/**
 * Effort per role, tunable without touching code.
 *
 * Effort replaces temperature as the determinism knob — sampling parameters are
 * rejected with a 400 on Sonnet 5 and Opus 5, so "turn the temperature down for
 * a reliable demo" is not available. What we have instead: effort, hard turn
 * caps, tight tool whitelists, and a Planner prompt carrying the expected
 * decomposition as a strong prior. Structure does the work temperature used to.
 *
 * Tune these against live runs, not by reasoning about them. Lowering the
 * Engineers speeds the build up, but it also makes first drafts worse, and a
 * first draft that is worse in the *wrong* way (missing a whole file) is not
 * the same as one the Reviewer can bounce for a real defect. Watch whether the
 * rejection still happens and whether it is still about something true.
 */
export const EFFORT = {
  planner: effortFor('planner', 'high'),
  engineer: effortFor('engineer', 'medium'),
  reviewer: effortFor('reviewer', 'high'),
  tester: effortFor('tester', 'low'),
  deployer: effortFor('deployer', 'low'),
} as const;

/** Hard ceilings. An agent that hits its cap is failed, not left to wander. */
export const LIMITS = {
  maxTurnsPerAgent: Number(process.env.SWARM_MAX_TURNS ?? 14),
  maxReviewRounds: Number(process.env.SWARM_MAX_REVIEW_ROUNDS ?? 3),
  commandTimeoutMs: Number(process.env.SWARM_CMD_TIMEOUT_MS ?? 90_000),
  maxToolResultChars: 12_000,
  maxFileBytes: 200_000,
} as const;

export const PORTS = {
  ws: Number(process.env.SWARM_WS_PORT ?? 8787),
  /** The port the shipped app is served on. */
  app: Number(process.env.SWARM_APP_PORT ?? 4310),
} as const;

/**
 * Multiplier on every scripted pause in rehearsal mode.
 *
 * At 1 the whole run finishes in about nine seconds, which is great for
 * iterating and useless on stage — nobody can read it. 2.5 puts a full run at
 * roughly half a minute, which is the pace you can actually narrate over.
 */
export const REHEARSAL_SPEED = Number(process.env.SWARM_REHEARSAL_SPEED ?? 2.5);

export const DEPLOY_TARGET = (process.env.SWARM_DEPLOY_TARGET ?? 'tunnel') as
  | 'tunnel'
  | 'local'
  | 'fly';
