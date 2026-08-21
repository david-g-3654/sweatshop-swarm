import Anthropic from '@anthropic-ai/sdk';
import type { AgentStatus } from '@swarm/shared';
import { LIMITS, PROVIDER } from './config.js';
import { client, buildRequest, ConfigError } from './llm/client.js';
import type { UsageMeter } from './usage.js';
import type { EventBus } from './bus.js';
import { toolsFor, type Sandbox, type ToolExecution } from './tools/index.js';
import { executeToolWithEvents } from './tools/execute.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentSpec {
  agentId: string;
  role: string;
  label: string;
  model: string;
  effort: Effort;
  system: string;
  /** Tool whitelist. An agent literally cannot call anything outside it. */
  tools: readonly string[];
  maxTurns?: number;
  /** Ceiling on one reply. A cap, not a target — it bounds a rambler. */
  maxTokens?: number;
}

export interface AgentResult {
  ok: boolean;
  /** Everything the agent said, joined. The last block is usually its verdict. */
  text: string;
  turns: number;
  stoppedBecause: 'end_turn' | 'max_turns' | 'refusal' | 'error';
  filesTouched: string[];
  lastTests?: { passed: number; failed: number; ok: boolean };
}

/**
 * One agent: a role, a system prompt, a tool whitelist, and a loop.
 *
 * This is the whole "framework". It is deliberately not LangGraph — when an
 * agent misbehaves at 2am I want to read forty lines, not trace a DAG library.
 *
 * The loop keeps its own message history across calls to run(), which is what
 * makes the review cycle work: when the Reviewer sends a rejection back, the
 * Engineer still remembers the code it wrote.
 */
export class Agent {
  private messages: Anthropic.MessageParam[] = [];
  private turnCount = 0;
  private filesTouched = new Set<string>();

  constructor(
    private readonly spec: AgentSpec,
    private readonly bus: EventBus,
    private readonly sandbox: Sandbox,
    private readonly meter?: UsageMeter,
  ) {}

  get id(): string {
    return this.spec.agentId;
  }

  announce(): void {
    this.bus.emit({
      type: 'agent.spawned',
      agentId: this.spec.agentId,
      role: this.spec.role,
      label: this.spec.label,
      model: this.spec.model,
    });
  }

  private status(status: AgentStatus, detail?: string): void {
    this.bus.emit({
      type: 'agent.status',
      agentId: this.spec.agentId,
      status,
      ...(detail ? { detail } : {}),
    });
  }

  /** Send the agent a task and run it to completion (or to its turn cap). */
  async run(task: string): Promise<AgentResult> {
    this.messages.push({ role: 'user', content: task });

    const maxTurns = this.spec.maxTurns ?? LIMITS.maxTurnsPerAgent;
    const tools = toolsFor(this.spec.tools);
    const said: string[] = [];
    let lastTests: AgentResult['lastTests'];
    let stoppedBecause: AgentResult['stoppedBecause'] = 'max_turns';

    for (let turn = 0; turn < maxTurns; turn++) {
      this.turnCount++;
      this.status('thinking');

      let final: Anthropic.Message;
      try {
        final = await this.streamTurn(tools);
      } catch (err) {
        this.status('failed', describeError(err));
        // A bad key or an unusable config will fail identically for every other
        // agent. Rethrowing aborts the run instead of emitting the same error
        // six times and grinding on to a meaningless verdict.
        if (isFatalConfig(err)) throw err;
        this.bus.drama('bad', `${this.spec.label} hit an API error: ${describeError(err)}`, this.spec.agentId);
        return {
          ok: false,
          text: said.join('\n\n'),
          turns: this.turnCount,
          stoppedBecause: 'error',
          filesTouched: [...this.filesTouched],
          ...(lastTests ? { lastTests } : {}),
        };
      }

      // Echo the assistant turn back verbatim. Thinking blocks must survive
      // round-trips on the same model, so we append content, never a string.
      this.messages.push({ role: 'assistant', content: final.content });

      for (const block of final.content) {
        if (block.type === 'text' && block.text.trim()) {
          said.push(block.text.trim());
          this.bus.emit({
            type: 'agent.message',
            agentId: this.spec.agentId,
            turn: this.turnCount,
            text: block.text.trim(),
          });
        }
      }

      if (final.stop_reason === 'refusal') {
        this.status('blocked', final.stop_details?.explanation ?? 'refused');
        stoppedBecause = 'refusal';
        break;
      }

      const toolUses = final.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (final.stop_reason !== 'tool_use' || toolUses.length === 0) {
        stoppedBecause = 'end_turn';
        break;
      }

      // Parallel tool use: run them together, then return every result in a
      // SINGLE user message. Splitting them teaches the model to stop batching.
      this.status('tool', toolUses.map((t) => t.name).join(', '));
      const results = await Promise.all(toolUses.map((use) => this.executeTool(use)));

      for (const { execution } of results) {
        if (execution.tests) {
          lastTests = {
            passed: execution.tests.passed,
            failed: execution.tests.failed,
            ok: execution.tests.ok,
          };
        }
      }

      this.messages.push({
        role: 'user',
        content: results.map(({ use, execution }) => ({
          type: 'tool_result' as const,
          tool_use_id: use.id,
          content: execution.content,
          ...(execution.ok ? {} : { is_error: true }),
        })),
      });
    }

    if (stoppedBecause === 'max_turns') {
      this.status('blocked', `hit the ${maxTurns}-turn cap`);
      this.bus.drama(
        'warn',
        `${this.spec.label} hit its ${maxTurns}-turn limit and was cut off.`,
        this.spec.agentId,
      );
    } else {
      this.status('idle');
    }

    return {
      ok: stoppedBecause === 'end_turn',
      text: said.join('\n\n'),
      turns: this.turnCount,
      stoppedBecause,
      filesTouched: [...this.filesTouched],
      ...(lastTests ? { lastTests } : {}),
    };
  }

  /** One streamed API call. Tokens go straight to the browser as they arrive. */
  private async streamTurn(tools: Anthropic.Tool[]): Promise<Anthropic.Message> {
    const stream = client().messages.stream(
      buildRequest({
        model: this.spec.model,
        system: this.spec.system,
        messages: this.messages,
        tools,
        effort: this.spec.effort,
        ...(this.spec.maxTokens ? { maxTokens: this.spec.maxTokens } : {}),
      }),
    );

    const turn = this.turnCount;
    stream.on('thinking', (delta) => {
      this.bus.emit({ type: 'agent.token', agentId: this.spec.agentId, turn, text: delta });
    });
    stream.on('text', (delta) => {
      this.bus.emit({ type: 'agent.token', agentId: this.spec.agentId, turn, text: delta });
    });

    const message = await stream.finalMessage();
    this.meter?.record(this.spec.model, message.usage);
    return message;
  }

  private async executeTool(
    use: Anthropic.ToolUseBlock,
  ): Promise<{ use: Anthropic.ToolUseBlock; execution: ToolExecution }> {
    const execution = await executeToolWithEvents(
      this.bus,
      this.spec.agentId,
      this.sandbox,
      use.name,
      use.input as Record<string, unknown>,
      use.id,
    );
    for (const change of execution.fileChanges ?? []) this.filesTouched.add(change.path);
    return { use, execution };
  }
}

/** Errors that no amount of retrying, by anyone, will get past. */
export function isFatalConfig(err: unknown): boolean {
  return err instanceof ConfigError || err instanceof Anthropic.AuthenticationError;
}

export function describeError(err: unknown): string {
  const keyName = PROVIDER === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
  if (err instanceof Anthropic.RateLimitError) return 'rate limited';
  if (err instanceof Anthropic.AuthenticationError) return `bad or missing ${keyName}`;
  if (err instanceof Anthropic.APIConnectionError) return 'connection failed';
  if (err instanceof Anthropic.APIError) {
    // A 400 from a gateway is usually a parameter it will not accept. Say so,
    // because the fix is a feature flag and not a code change.
    if (err.status === 400 && PROVIDER === 'openrouter') {
      return `API 400 (OpenRouter rejected a request parameter — run "npm run probe"): ${err.message}`;
    }
    return `API ${err.status}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
