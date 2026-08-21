import Anthropic from '@anthropic-ai/sdk';
import { PROVIDER, OPENROUTER_BASE_URL, FEATURES } from '../config.js';

/**
 * The model client.
 *
 * OpenRouter speaks the Anthropic Messages API at /api/v1, so this is a base
 * URL swap rather than a second implementation of the agent loop. The whole
 * provider story is these thirty lines.
 */

/** A problem with configuration, not with the model. Aborts a run immediately. */
export class ConfigError extends Error {}

const KEY_NAME = PROVIDER === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';

/**
 * Fetch and sanity-check the API key.
 *
 * A key with a newline in it becomes an invalid HTTP header, and the resulting
 * error talks about `Headers.append` rather than about the key — six times over,
 * once per agent, while the run grinds on to a meaningless conclusion. Checking
 * the shape up front turns that into one sentence naming the actual cause.
 */
function apiKey(): string {
  const raw = PROVIDER === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.ANTHROPIC_API_KEY;

  if (!raw || !raw.trim()) {
    throw new ConfigError(
      `${KEY_NAME} is not set. Put it in .env — not on the command line, where it lands in your shell history.`,
    );
  }

  const key = raw.trim();

  // The tell-tale signature of a broken shell paste: an unterminated quote in a
  // .zshrc swallows the following lines into the value.
  if (/\s/.test(key) || key.includes('export ')) {
    throw new ConfigError(
      `${KEY_NAME} contains whitespace or shell syntax, so it cannot be sent as an HTTP header.\n` +
        `  This usually means it is exported in your shell from a paste with an unterminated quote.\n` +
        `  Fix it with:   unset ${KEY_NAME}\n` +
        `  then check ~/.zshrc for an export line whose quote is never closed.\n` +
        `  The key in .env is used once nothing in the shell is overriding it.`,
    );
  }

  const expectedPrefix = PROVIDER === 'openrouter' ? 'sk-or-' : 'sk-ant-';
  if (!key.startsWith(expectedPrefix)) {
    throw new ConfigError(
      `${KEY_NAME} does not look like a ${PROVIDER} key (expected it to start with "${expectedPrefix}").\n` +
        `  Set SWARM_PROVIDER explicitly if you meant to use the other provider.`,
    );
  }

  return key;
}

let cached: Anthropic | null = null;

export function client(): Anthropic {
  if (cached) return cached;
  cached = new Anthropic({
    apiKey: apiKey(),
    ...(PROVIDER === 'openrouter'
      ? {
          baseURL: OPENROUTER_BASE_URL,
          // OpenRouter uses these for attribution on its public leaderboards.
          defaultHeaders: {
            'HTTP-Referer': 'https://github.com/david-g-3654/sweatshop-swarm',
            'X-Title': 'Sweatshop Swarm',
          },
        }
      : {}),
  });
  return cached;
}

/**
 * A safe, human-checkable description of the credential in force.
 *
 * Printed at startup so a stale process or a bad key is obvious before anyone
 * clicks Run live, instead of surfacing as six identical failures a minute in.
 * Only the last four characters are shown — enough to tell two keys apart,
 * useless to anyone reading over your shoulder or watching the projector.
 */
export function keyFingerprint(): string {
  try {
    const key = apiKey();
    return `…${key.slice(-4)} (${key.length} chars)`;
  } catch (err) {
    return err instanceof ConfigError ? 'UNUSABLE' : 'unknown';
  }
}

export function hasKey(): boolean {
  try {
    apiKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark the end of the conversation so far as cacheable.
 *
 * The agent loop resends the whole history every turn, so by the end of a run
 * the same tokens have been billed at full price a dozen times over. Caching
 * only the system prompt barely dents that — a measured live run read just 44k
 * of 652k input tokens from cache.
 *
 * Putting a second breakpoint on the last block of the last message means each
 * turn reads the previous turn's entire prefix at a tenth of the price. Cache
 * writes cost 1.25x, so this pays for itself from the second turn onward, and
 * every agent here runs several.
 *
 * The last message is always a user turn — either the task or a batch of
 * tool_results — and both block types accept cache_control.
 */
function cacheConversationTail(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const index = messages.length - 1;
  const last = messages[index]!;
  const mark = { cache_control: { type: 'ephemeral' as const } };

  const content: Anthropic.ContentBlockParam[] =
    typeof last.content === 'string'
      ? [{ type: 'text', text: last.content, ...mark }]
      : last.content.map((block, i) =>
          i === last.content.length - 1
            ? ({ ...block, ...mark } as Anthropic.ContentBlockParam)
            : block,
        );

  return [...messages.slice(0, index), { ...last, content }];
}

/**
 * Build the per-turn request, including only the optional parameters this
 * provider is configured to accept.
 */
export function buildRequest(options: {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
}): Anthropic.MessageStreamParams {
  const system: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: options.system,
      ...(FEATURES.promptCache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    },
  ];

  return {
    model: options.model,
    max_tokens: options.maxTokens ?? 16000,
    system,
    messages: FEATURES.promptCache ? cacheConversationTail(options.messages) : options.messages,
    tools: options.tools,
    // Adaptive thinking with a visible summary is what fills the inner-monologue
    // panel. Omitting the parameter entirely still leaves Sonnet 5 and Opus 5
    // thinking adaptively — it just stops returning the summary.
    ...(FEATURES.thinking ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } } : {}),
    ...(FEATURES.effort ? { output_config: { effort: options.effort } } : {}),
  };
}
