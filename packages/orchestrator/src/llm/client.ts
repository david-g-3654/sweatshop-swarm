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
    messages: options.messages,
    tools: options.tools,
    // Adaptive thinking with a visible summary is what fills the inner-monologue
    // panel. Omitting the parameter entirely still leaves Sonnet 5 and Opus 5
    // thinking adaptively — it just stops returning the summary.
    ...(FEATURES.thinking ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } } : {}),
    ...(FEATURES.effort ? { output_config: { effort: options.effort } } : {}),
  };
}
