import type Anthropic from '@anthropic-ai/sdk';

/**
 * Token accounting and a cost estimate.
 *
 * This exists because the budget is finite and small. Knowing a run costs
 * ~$0.40 rather than ~$4.00 is the difference between rehearsing freely and
 * running out of credit the morning of the demo.
 *
 * Prices are USD per million tokens, and match Anthropic's first-party rates —
 * OpenRouter charges the same for these models. It is an estimate: the
 * authoritative number is on your provider's dashboard.
 */

interface Price {
  input: number;
  output: number;
}

const PRICES: Record<string, Price> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4.6': { input: 3, output: 15 },
  'claude-haiku-4.5': { input: 1, output: 5 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
};

/** Strip an OpenRouter vendor prefix so both naming schemes hit the same row. */
function priceFor(model: string): Price | null {
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  return PRICES[bare] ?? null;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  costUsd: number;
  /** True when at least one model had no price on file, so cost is a floor. */
  incomplete: boolean;
}

export class UsageMeter {
  private input = 0;
  private output = 0;
  private cacheWrite = 0;
  private cacheRead = 0;
  private cost = 0;
  private incomplete = false;

  record(model: string, usage: Anthropic.Usage): void {
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;

    this.input += input;
    this.output += output;
    this.cacheWrite += cacheWrite;
    this.cacheRead += cacheRead;

    const price = priceFor(model);
    if (!price) {
      this.incomplete = true;
      return;
    }
    // Cache writes cost 1.25x input; cache reads cost 0.1x.
    this.cost +=
      (input * price.input + cacheWrite * price.input * 1.25 + cacheRead * price.input * 0.1 + output * price.output) /
      1_000_000;
  }

  totals(): UsageTotals {
    return {
      input: this.input,
      output: this.output,
      cacheWrite: this.cacheWrite,
      cacheRead: this.cacheRead,
      costUsd: this.cost,
      incomplete: this.incomplete,
    };
  }

  /** A one-line summary for the drama feed. */
  summary(): string {
    const t = this.totals();
    const tokens = `${fmt(t.input + t.cacheWrite + t.cacheRead)} in, ${fmt(t.output)} out`;
    const saved = t.cacheRead > 0 ? `, ${fmt(t.cacheRead)} served from cache` : '';
    const cost = t.incomplete ? `at least $${t.costUsd.toFixed(2)}` : `about $${t.costUsd.toFixed(2)}`;
    return `Run cost ${cost} — ${tokens}${saved}.`;
  }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
