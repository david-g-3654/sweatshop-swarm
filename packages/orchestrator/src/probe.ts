import Anthropic from '@anthropic-ai/sdk';
// config.js loads .env from the repo root; importing dotenv here as well would
// race it with a cwd-relative read.
import { PROVIDER, MODELS, OPENROUTER_BASE_URL } from './config.js';

/**
 * Capability probe.
 *
 * A gateway is not obliged to accept every parameter the first-party API takes,
 * and a rejected parameter is a 400 that kills a run rather than degrading it.
 * Rather than guess, ask: send one tiny request per feature and see what comes
 * back. Then print the .env lines that match reality.
 *
 *   npm run probe
 *
 * Costs a fraction of a cent — every request here is capped at a few hundred
 * tokens.
 */

const key = PROVIDER === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.ANTHROPIC_API_KEY;

if (!key) {
  console.error(
    PROVIDER === 'openrouter'
      ? 'OPENROUTER_API_KEY is not set. Add it to .env first.'
      : 'ANTHROPIC_API_KEY is not set. Add it to .env first.',
  );
  process.exit(1);
}

const api = new Anthropic({
  apiKey: key,
  ...(PROVIDER === 'openrouter'
    ? {
        baseURL: OPENROUTER_BASE_URL,
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/david-g-3654/sweatshop-swarm',
          'X-Title': 'Agent Arena',
        },
      }
    : {}),
});

const model = MODELS.worker;

const BASE = {
  model,
  max_tokens: 300,
  messages: [{ role: 'user' as const, content: 'Reply with the single word: ready' }],
};

const SAMPLE_TOOL: Anthropic.Tool = {
  name: 'echo',
  description: 'Echo a string back.',
  input_schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
};

interface Result {
  name: string;
  envVar: string | null;
  ok: boolean;
  /** Accepted, but did not actually deliver what it is wanted for. */
  partial: boolean;
  note: string;
}

/** An inspection either passes, or passes-but-hollow with a reason. */
type Verdict = string | { note: string; partial: true };

const results: Result[] = [];

async function probe(
  name: string,
  envVar: string | null,
  params: Anthropic.MessageCreateParamsNonStreaming,
  inspect?: (message: Anthropic.Message) => Verdict,
): Promise<boolean> {
  process.stdout.write(`  ${name.padEnd(28)} `);
  try {
    const message = await api.messages.create(params);
    const verdict: Verdict = inspect ? inspect(message) : 'accepted';
    const partial = typeof verdict === 'object';
    const note = typeof verdict === 'object' ? verdict.note : verdict;
    results.push({ name, envVar, ok: true, partial, note });
    // "Accepted" is not the same as "works". A parameter the gateway swallows
    // without honouring is the failure mode most likely to be missed, so it
    // gets its own marker rather than being rounded up to ok.
    console.log(`${partial ? '~~' : 'ok'} — ${note}`);
    return true;
  } catch (err) {
    const note =
      err instanceof Anthropic.APIError ? `${err.status}: ${String(err.message).slice(0, 120)}` : String(err);
    results.push({ name, envVar, ok: false, partial: false, note });
    console.log(`no — ${note}`);
    return false;
  }
}

console.log(`\nProbing ${PROVIDER}${PROVIDER === 'openrouter' ? ` (${OPENROUTER_BASE_URL})` : ''}`);
console.log(`Model:   ${model}\n`);

// 1. Can we talk to it at all? Nothing else matters if this fails.
const reachable = await probe('baseline request', null, BASE, (m) => {
  const text = m.content.find((b) => b.type === 'text');
  return `replied "${text && text.type === 'text' ? text.text.trim().slice(0, 20) : '?'}"`;
});

if (!reachable) {
  console.log('\nThe baseline request failed, so nothing below would be meaningful.');
  console.log('Check the key is valid and has credit, then run this again.\n');
  process.exit(1);
}

// 2. Tool calling. Non-negotiable — the agents are useless without it.
const toolsWork = await probe(
  'tool calling',
  null,
  {
    ...BASE,
    messages: [{ role: 'user', content: 'Use the echo tool with the text "hello".' }],
    tools: [SAMPLE_TOOL],
  },
  (m) => (m.content.some((b) => b.type === 'tool_use') ? 'model called the tool' : 'no tool_use block returned'),
);

// 3. Strict tool schemas.
await probe('strict tool schemas', 'ARENA_STRICT_TOOLS', {
  ...BASE,
  messages: [{ role: 'user', content: 'Use the echo tool with the text "hello".' }],
  tools: [{ ...SAMPLE_TOOL, strict: true } as Anthropic.Tool],
});

// 4. Adaptive thinking with a visible summary — the inner-monologue panel.
//
// The prompt has to be hard enough to be worth thinking about. Adaptive
// thinking decides for itself whether to engage, so an easy question produces
// no thinking block and looks exactly like an unsupported parameter.
await probe(
  'thinking + summary',
  'ARENA_THINKING',
  {
    ...BASE,
    max_tokens: 3000,
    messages: [
      {
        role: 'user',
        content:
          'Three switches outside a sealed room control three bulbs inside it. You may flip switches freely, then enter the room exactly once. Work out how to identify which switch controls which bulb, and explain why it works.',
      },
    ],
    thinking: { type: 'adaptive', display: 'summarized' },
  },
  (m) => {
    const block = m.content.find((b) => b.type === 'thinking');
    if (!block) {
      return { note: 'accepted, but no thinking block on a task that warrants one', partial: true };
    }
    const text = block.type === 'thinking' ? block.thinking : '';
    if (!text.trim()) {
      return { note: 'accepted, but the summary text was empty', partial: true };
    }
    return `summary returned (${text.trim().length} chars)`;
  },
);

// 5. Effort.
await probe('output_config.effort', 'ARENA_EFFORT', {
  ...BASE,
  output_config: { effort: 'low' },
});

// 6. Prompt caching. Worth real money over a six-agent run.
await probe(
  'prompt cache_control',
  'ARENA_PROMPT_CACHE',
  {
    ...BASE,
    system: [
      {
        type: 'text',
        // Cache writes need a sizeable prefix; a short string silently will not cache.
        text: `You are a probe. ${'Ignore this padding. '.repeat(400)}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
  },
  (m) => {
    const created = m.usage.cache_creation_input_tokens ?? 0;
    const read = m.usage.cache_read_input_tokens ?? 0;
    if (!created && !read) return { note: 'accepted, but nothing was cached', partial: true };
    return `cache active (${created} written, ${read} read)`;
  },
);

// ---- report ----------------------------------------------------------------

console.log('\n' + '─'.repeat(64));

if (!toolsWork) {
  console.log('\nTool calling did not work. The agents cannot do anything without it.');
  console.log('Check the model id supports tools before going further.\n');
  process.exit(1);
}

const CONSEQUENCE: Record<string, string> = {
  ARENA_THINKING: 'console panels stream visible text but no reasoning summary',
  ARENA_EFFORT: 'models run at their default effort',
  ARENA_STRICT_TOOLS: 'tool inputs are validated by the tools themselves, not the API',
  ARENA_PROMPT_CACHE: 'the system prompt is billed in full on every turn',
};

const flags = results.filter((r) => r.envVar);
const rejected = flags.filter((r) => !r.ok);
const hollow = flags.filter((r) => r.ok && r.partial);

console.log('\nPut these in .env:\n');
console.log(`ARENA_PROVIDER=${PROVIDER}`);
// A parameter that is accepted but not honoured still stays on: it costs
// nothing and may engage on harder prompts than this probe uses.
for (const flag of flags) console.log(`${flag.envVar}=${flag.ok ? 1 : 0}`);

if (rejected.length === 0 && hollow.length === 0) {
  console.log('\nEverything is supported and doing something. Nothing is degraded.\n');
}

if (rejected.length > 0) {
  console.log(`\n${rejected.length} rejected — the run still works, with less polish:`);
  for (const flag of rejected) {
    console.log(`  - ${flag.name}: ${CONSEQUENCE[flag.envVar!] ?? 'degraded'}`);
  }
}

if (hollow.length > 0) {
  console.log(`\n${hollow.length} accepted but had no observable effect here:`);
  for (const flag of hollow) {
    console.log(`  - ${flag.name}: ${flag.note}`);
    console.log(`      if that holds during a run: ${CONSEQUENCE[flag.envVar!] ?? 'degraded'}`);
  }
  console.log('\n  Left switched on — they cost nothing, and may behave differently');
  console.log('  on the longer, harder prompts a real run uses.');
}
console.log('');
