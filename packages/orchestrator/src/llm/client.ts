import Anthropic from '@anthropic-ai/sdk';
import { PROVIDER, OPENROUTER_BASE_URL, FEATURES } from '../config.js';

/**
 * The model client.
 *
 * OpenRouter speaks the Anthropic Messages API at /api/v1, so this is a base
 * URL swap rather than a second implementation of the agent loop. The whole
 * provider story is these thirty lines.
 */

export class MissingKeyError extends Error {}

function apiKey(): string {
  const key = PROVIDER === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new MissingKeyError(
      PROVIDER === 'openrouter'
        ? 'OPENROUTER_API_KEY is not set. Put it in .env — never on the command line, where it lands in your shell history.'
        : 'ANTHROPIC_API_KEY is not set. Copy .env.example to .env.',
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
            'X-Title': 'Agent Arena',
          },
        }
      : {}),
  });
  return cached;
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
