import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Phase } from '@swarm/shared';
import { SANDBOX_ROOT, LIMITS } from './config.js';
import { randomUUID as uuid } from 'node:crypto';
import { EventBus } from './bus.js';
import { Agent, isFatalConfig, describeError } from './agent.js';
import { Sandbox } from './tools/index.js';
import { prewarmTunnel } from './tools/deploy.js';
import { executeToolWithEvents } from './tools/execute.js';
import { PORTS } from './config.js';
import { specs, parsePlan, verdictOf, suiteOf, shippedUrl, type Plan } from './roles.js';
import { UsageMeter } from './usage.js';
import { settleAgents } from './settle.js';

export interface RunOptions {
  goal: string;
  runId?: string;
}

export interface RunOutcome {
  ok: boolean;
  runId: string;
  deployUrl?: string;
  summary: string;
}

/**
 * A fallback decomposition.
 *
 * If the Planner returns something unparseable we do not stop the demo — we
 * fall back to the shape the Planner was told to produce anyway, say so in the
 * drama feed, and keep going. Visibly degrading beats a blank screen on stage.
 */
function fallbackPlan(goal: string): Plan {
  return {
    summary: goal,
    workstreams: [
      {
        owner: 'engineer-a',
        title: 'Core logic module',
        brief:
          'Write store.js: the pure logic for this feature as exported functions, no http. Also write store.test.js covering it, including failure cases.',
      },
      {
        owner: 'engineer-b',
        title: 'HTTP server',
        brief:
          'Write server.js: a node:http server that imports ./store.js and exposes the feature over HTTP. Read the port from process.env.PORT. Also write server.test.js.',
      },
    ],
    acceptance: ['the suite is green', 'the server responds over HTTP'],
  };
}

export class Orchestrator {
  readonly bus: EventBus;
  readonly meter = new UsageMeter();
  private readonly sandbox: Sandbox;
  private agents = new Map<string, Agent>();

  constructor(private readonly options: RunOptions) {
    const runId = options.runId ?? `run-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
    this.bus = new EventBus(runId, options.goal);
    this.sandbox = new Sandbox(path.join(SANDBOX_ROOT, runId));
  }

  private phase(phase: Phase): void {
    this.bus.emit({ type: 'phase.changed', phase });
  }

  private agent(id: string): Agent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`no such agent: ${id}`);
    return agent;
  }

  private handoff(
    from: string,
    to: string,
    kind: 'assign' | 'submit' | 'reject' | 'approve' | 'report',
    summary: string,
  ): void {
    this.bus.emit({ type: 'message.sent', from, to, kind, summary });
  }

  async run(): Promise<RunOutcome> {
    const { goal } = this.options;
    /*
     * Deliberately not tearing down here.
     *
     * Killing the previous deployment at the start of a run leaves the booth
     * with a dead app for the whole run — visitors get a connection error while
     * the agents work, which is most of the time. deploy() replaces the process
     * when it has something to replace it with, and leaves it alone entirely
     * when the new build is byte-identical.
     */
    await this.sandbox.init();

    this.bus.emit({ type: 'run.started', goal, schemaVersion: 1, mode: 'live' });

    const roster = specs();
    for (const spec of Object.values(roster)) {
      const agent = new Agent(spec, this.bus, this.sandbox, this.meter);
      this.agents.set(spec.agentId, agent);
      agent.announce();
    }

    try {
      const plan = await this.plan(goal);
      await this.build(plan, goal);
      const approved = await this.review(plan);
      if (!approved) return this.finish(false, 'The Reviewer never approved the work.');

      const green = await this.test();
      if (!green) return this.finish(false, 'The suite stayed red.');

      const url = await this.deploy(goal);
      if (!url) return this.finish(false, 'The Deployer could not ship it.');

      return this.finish(true, `Shipped: ${url}`, url);
    } catch (err) {
      const message = describeError(err);
      if (isFatalConfig(err)) {
        // Configuration, not the models. Say so plainly and stop — there is
        // nothing for the rest of the team to attempt.
        this.bus.drama('bad', `Stopped before doing any work: ${message}`);
        return this.finish(false, message);
      }
      this.bus.drama('bad', `The run fell over: ${message}`);
      return this.finish(false, message);
    }
  }

  private finish(ok: boolean, summary: string, deployUrl?: string): RunOutcome {
    settleAgents(this.bus, ok);
    // Report the bill even on a failed run — a run that burned budget and shipped
    // nothing is exactly the one you want the number for.
    this.bus.drama(ok ? 'info' : 'warn', this.meter.summary());
    this.phase(ok ? 'done' : 'failed');
    this.bus.emit({
      type: 'run.finished',
      ok,
      summary,
      ...(deployUrl ? { deployUrl } : {}),
    });
    return { ok, runId: this.bus.runId, summary, ...(deployUrl ? { deployUrl } : {}) };
  }

  /**
   * Read the whole workspace into a single message.
   *
   * Measured: review round one took 102 of the run's 357 seconds, and the
   * Reviewer spent ten of its twelve tool calls just discovering and reading
   * files. Those are turns spent on I/O the orchestrator can do in parallel in
   * milliseconds, so it does — the Reviewer's first message already contains
   * everything it would have gone looking for.
   *
   * The extra input tokens are cheap and largely cached; the round trips were
   * not.
   */
  private async workspaceListing(): Promise<string> {
    const files = await this.sandbox.listFiles();
    if (files.length === 0) return '(the workspace is empty — the engineers wrote nothing)';

    const contents = await Promise.all(
      files.map(async (file) => {
        try {
          return { file, body: await this.sandbox.readFile(file) };
        } catch (err) {
          return { file, body: `(could not be read: ${err instanceof Error ? err.message : String(err)})` };
        }
      }),
    );

    return contents
      .map(({ file, body }) => `--- ${file} ---\n\`\`\`\n${body}\n\`\`\``)
      .join('\n\n');
  }

  /**
   * Run the suite ourselves and hand the Reviewer the result.
   *
   * The Reviewer used to run it too, which cost turns and, worse, made the
   * verdict depend on an agent reporting its own tool output. Running it here
   * keeps the existing rule — the tool result is the truth, never an agent's
   * claim about it — and takes the re-run off the critical path.
   */
  private async authoritativeTests(): Promise<string> {
    const result = await executeToolWithEvents(
      this.bus,
      'tester',
      this.sandbox,
      'run_tests',
      {},
      uuid(),
    );
    const outcome = result.tests;
    if (!outcome) return 'The suite could not be run.';
    return [
      `The suite has already been run for you by the pipeline. This is the real output, not a claim:`,
      `  ${outcome.passed} passing, ${outcome.failed} failing (${outcome.ok ? 'GREEN' : 'RED'})`,
      '',
      outcome.output,
    ].join('\n');
  }

  // ---- phases -------------------------------------------------------------

  private async plan(goal: string): Promise<Plan> {
    this.phase('planning');
    this.bus.drama('info', `Goal received: ${goal}`);

    const result = await this.agent('planner').run(
      `The team's goal:\n\n${goal}\n\nDecompose it into exactly two parallel workstreams and give me the json block.`,
    );

    const parsed = parsePlan(result.text);
    if (!parsed) {
      this.bus.drama('warn', 'Planner output could not be parsed. Falling back to the default split.');
      return fallbackPlan(goal);
    }

    this.bus.drama('good', `Planner split the work: ${parsed.workstreams.map((w) => w.title).join(' | ')}`, 'planner');
    for (const workstream of parsed.workstreams) {
      this.handoff('planner', workstream.owner, 'assign', workstream.title);
    }
    return parsed;
  }

  private briefFor(plan: Plan, owner: string, goal: string): string {
    const mine = plan.workstreams.find((w) => w.owner === owner) ?? plan.workstreams[0]!;
    const others = plan.workstreams.filter((w) => w !== mine);
    return [
      `Overall goal: ${goal}`,
      `Plan summary: ${plan.summary}`,
      '',
      `YOUR WORKSTREAM — ${mine.title}`,
      mine.brief,
      '',
      'The other engineer is building, in parallel:',
      ...others.map((w) => `- ${w.title}: ${w.brief}`),
      '',
      'Acceptance criteria for the team:',
      ...plan.acceptance.map((a) => `- ${a}`),
      '',
      'Build your part now. Do not write the other engineer\'s files.',
    ].join('\n');
  }

  private async build(plan: Plan, goal: string): Promise<void> {
    this.phase('building');
    this.bus.drama('info', 'Engineer A and Engineer B are writing code in parallel.');

    // Open the tunnel now, while there are minutes of agent work still to come.
    // Establishing it was most of the deploy phase and it needs nothing from
    // the app, so it has no business sitting on the critical path at the end.
    void prewarmTunnel(PORTS.app);

    // Genuinely concurrent: two independent loops, two independent token
    // streams. This is the part of the graph the audience watches light up.
    await Promise.all(
      ['engineer-a', 'engineer-b'].map(async (id) => {
        const result = await this.agent(id).run(this.briefFor(plan, id, goal));
        this.handoff(id, 'reviewer', 'submit', `${result.filesTouched.length} files`);
        this.bus.drama(
          'info',
          `${id === 'engineer-a' ? 'Engineer A' : 'Engineer B'} submitted ${result.filesTouched.length} files for review.`,
          id,
        );
      }),
    );
  }

  private async review(plan: Plan): Promise<boolean> {
    this.phase('review');

    for (let round = 1; round <= LIMITS.maxReviewRounds; round++) {
      this.bus.drama('info', `Review round ${round}.`, 'reviewer');

      // Everything the Reviewer needs, gathered in parallel before it thinks.
      const [listing, tests] = await Promise.all([this.workspaceListing(), this.authoritativeTests()]);

      const header =
        round === 1
          ? [
              'Review the work in the workspace against your rubric.',
              '',
              `What the team set out to build:\n${plan.summary}`,
              '',
              `Acceptance criteria:\n${plan.acceptance.map((a) => `- ${a}`).join('\n')}`,
            ].join('\n')
          : [
              'You have reviewed this before. The engineers say they have addressed your',
              'findings. Here is the workspace as it stands now.',
              '',
              'Check whether each finding you raised is actually fixed — including whether',
              'the fix itself is sound, because a fix can reintroduce the problem it was',
              'meant to solve, and that is worth blocking for.',
              '',
              'Do not go hunting for new problems you did not raise last time. Raise',
              'something new only if it would break the app or is a security hole. A review',
              'that finds one more thing on every pass never converges, and the engineers',
              'cannot act on findings that keep moving.',
              '',
              'If the findings you raised are addressed, approve it.',
            ].join('\n');

      const prompt = [
        header,
        '',
        tests,
        '',
        'THE COMPLETE WORKSPACE:',
        listing,
        '',
        'You have everything above already — do not re-read these files. Judge them.',
      ].join('\n');

      const result = await this.agent('reviewer').run(prompt);
      const verdict = verdictOf(result.text);

      if (verdict === 'approved') {
        this.bus.drama('good', `Reviewer approved the work on round ${round}.`, 'reviewer');
        this.handoff('reviewer', 'tester', 'approve', `approved on round ${round}`);
        return true;
      }

      if (verdict === null) {
        // No verdict line means we cannot tell approval from musing. Treat an
        // unreadable review as a rejection: failing closed is the safe direction.
        // Distinguish the two reasons, though — "it ran out of room" and "it
        // wrote something I could not parse" need different fixes.
        this.bus.drama(
          'warn',
          result.stoppedBecause === 'truncated'
            ? 'Reviewer ran out of output budget before reaching a verdict — treating it as changes requested.'
            : 'Reviewer gave no clear verdict — treating it as changes requested.',
          'reviewer',
        );
      }

      const headline = firstFinding(result.text);
      this.bus.drama('bad', `Reviewer rejected the PR: ${headline}`, 'reviewer');

      if (round === LIMITS.maxReviewRounds) {
        this.bus.drama('bad', `Still not approved after ${round} rounds. Stopping.`, 'reviewer');
        return false;
      }

      for (const id of ['engineer-a', 'engineer-b']) {
        this.handoff('reviewer', id, 'reject', headline);
      }

      await Promise.all(
        ['engineer-a', 'engineer-b'].map(async (id) => {
          await this.agent(id).run(
            [
              'The Reviewer sent your work back. Their full review:',
              '',
              result.text,
              '',
              'Fix every finding that concerns a file you own. Ignore findings about the other engineer\'s files — they are fixing those in parallel. Re-run the tests, then reply with what you changed.',
            ].join('\n'),
          );
          this.handoff(id, 'reviewer', 'submit', 'fixes applied');
        }),
      );
      this.bus.drama('info', 'Engineers pushed fixes. Back to review.');
    }
    return false;
  }

  private async test(): Promise<boolean> {
    this.phase('testing');
    const result = await this.agent('tester').run('Run the suite and report honestly.');
    const suite = suiteOf(result.text);

    if (suite === 'green' && result.lastTests?.ok) {
      this.bus.drama('good', `Suite is green: ${result.lastTests.passed} passing.`, 'tester');
      this.handoff('tester', 'deployer', 'report', 'suite green');
      return true;
    }

    // Trust the tool result over the model's summary. If run_tests says the
    // suite is red, a cheerful "SUITE: GREEN" does not get to override it.
    const failing = result.lastTests?.failed ?? 0;
    this.bus.drama('bad', `Suite is red: ${failing} failing. Not shipping.`, 'tester');
    return false;
  }

  private async deploy(goal: string): Promise<string | null> {
    this.phase('deploying');
    this.bus.emit({ type: 'deploy.started', agentId: 'deployer', target: 'app' });

    const listing = await this.workspaceListing();
    const result = await this.agent('deployer').run(
      [
        'The suite is green and the Reviewer approved. Ship it.',
        '',
        `The goal was: ${goal}`,
        '',
        'THE COMPLETE WORKSPACE:',
        listing,
      ].join('\n'),
    );
    const url = shippedUrl(result.text);

    if (!url) {
      this.bus.emit({ type: 'deploy.finished', agentId: 'deployer', ok: false, error: 'no url reported' });
      this.bus.drama('bad', 'Deployer could not ship it.', 'deployer');
      return null;
    }

    this.bus.emit({ type: 'deploy.finished', agentId: 'deployer', ok: true, url });
    this.bus.drama('good', `Shipped. It is live at ${url}`, 'deployer');
    return url;
  }
}

/**
 * Pull the first numbered finding out of a review, for the drama feed.
 *
 * Cut at a word boundary. This line lands in the middle of the GO/NO-GO band
 * at the moment a room is reading it, and "…ever made a request get" reads as
 * a bug rather than as a summary.
 */
function firstFinding(review: string): string {
  const numbered = /^\s*1[.)]\s*(.+)$/m.exec(review);
  const raw =
    numbered?.[1] ?? review.split('\n').find((l) => l.trim().length > 20) ?? 'changes requested';
  return clip(raw.trim(), 150);
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:—-]$/, '')}…`;
}
