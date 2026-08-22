import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Phase } from '@swarm/shared';
import { REPO_ROOT, SANDBOX_ROOT, REHEARSAL_SPEED, PORTS } from './config.js';
import { EventBus } from './bus.js';
import { Sandbox } from './tools/index.js';
import { executeToolWithEvents } from './tools/execute.js';
import { teardown, prewarmTunnel } from './tools/deploy.js';
import { specs } from './roles.js';
import { settleAgents } from './settle.js';

/**
 * Rehearsal mode.
 *
 * The agents' words are scripted. Everything else is real: real files written
 * to a real sandbox, `node --test` really runs, the server really starts, the
 * URL at the end really serves. Only the model calls are replaced.
 *
 * It exists for three reasons:
 *   1. I can develop and test the whole pipeline and the UI without an API key
 *      and without burning budget on every frontend tweak.
 *   2. Venue wifi. If the API is unreachable at 2pm on stage, this still ends
 *      with a working URL on the projector.
 *   3. It exercises the same event stream and the same tool executor as a live
 *      run, so the UI is never tested against a shape that cannot occur.
 *
 * It is labelled 'rehearsal' on the run.started event, so the UI badges it and
 * it can never be passed off as a live run by accident. That matters: judges
 * are told this is a demo of real agents, and it has to be true.
 */

const FIXTURES = path.join(REPO_ROOT, 'packages/orchestrator/fixtures/rehearsal');

interface Line {
  agentId: string;
  text: string;
}

const PLAN_TEXT = `Splitting this by file so the two engineers never touch the same one.

Engineer A owns everything that is a pure function: store.js plus store.test.js.
shorten(url, label) returns a code, resolve(code) returns a url, recordHit(code,
referrer) records a click, and the dashboard's numbers come from allStats(),
totalClicks() and clicksPerSecond(30). No HTTP in there, no markup.

Engineer B owns transport and markup: server.js, the dashboard page it serves,
and server.test.js. It imports ./store.js, reads its port from process.env.PORT,
and pushes updates to the browser over an SSE stream at /api/stream.

Putting the aggregation on A's side keeps the split even — B ends up with
routing and rendering rather than logic. The interface between them is those six
exported functions, fixed now, because they cannot talk while they work.

\`\`\`json
{
  "summary": "a URL shortener with a live click-analytics dashboard, on plain Node",
  "workstreams": [
    { "owner": "engineer-a", "title": "Store + analytics aggregation", "brief": "store.js and store.test.js" },
    { "owner": "engineer-b", "title": "HTTP server + live dashboard", "brief": "server.js, dashboard.js and server.test.js" }
  ],
  "acceptance": [
    "the suite is green",
    "the dashboard updates without a page reload",
    "a burst of clicks is counted exactly"
  ]
}
\`\`\``;

const REVIEW_1 = `I have read store.js, server.js and the dashboard. The tests are
green, and I am still sending this back — a green suite that only covers the
happy path is exactly the thing my rubric exists to catch. Two of these are
specific to it being a live dashboard, and they are the ones that will bite on
stage.

1. store.js — shorten() takes whatever it is handed. null, an empty string, a
   number, "not a url" all become links. Validate: non-empty string, parseable
   as a URL, http or https only, length capped.
2. store.js — createCode() can collide. On a collision shorten() silently
   overwrites somebody else's link and their traffic starts going somewhere
   else. Retry, and fail loudly if you cannot allocate one.
3. store.js — recordHit() calls hits.get(code).push(...) with no check. An
   unknown code throws TypeError on undefined. It must fail softly.
4. store.js — the hits array grows without bound. A link that gets hammered by
   a room full of people is an unbounded memory leak. Cap it.
5. server.js — the redirect route reads snapshot() BEFORE recordHit() and
   broadcasts that. Every dashboard therefore renders the counts from before
   the click that triggered the update, so under a burst the chart is
   permanently one behind. Broadcast after the write, from a fresh snapshot.
6. server.js — /api/stream adds the response to subscribers and never removes
   it. There is no 'close' handler, so every dashboard anyone opens is retained
   for the life of the process and written to forever. Delete on close and on
   error.
7. server.js — an unknown code puts undefined straight into the 302 Location
   header, and /api/stats/ on an unknown code reads .url off undefined and
   500s. Both need a 404.
8. server.js — JSON.parse on the request body is unguarded. A malformed body is
   an unhandled rejection where it should be a 400.
9. Both test files only assert the happy path. Every public behaviour needs a
   failure-case test, and given the goal, one of them has to be a burst: fire
   many clicks at once and assert the count is exact.

VERDICT: CHANGES_REQUESTED`;

const REVIEW_2 = `Re-read both files.

Validation is in and normalises the URL rather than echoing it back. Collisions
retry and then fail loudly. recordHit returns false on an unknown code instead
of throwing, and the hit list is capped.

The two live-dashboard problems are fixed properly. The redirect route now
broadcasts after recording, building a fresh snapshot each time, so the chart
cannot sit one click behind. /api/stream removes its subscriber on both 'close'
and 'error', and there is a test that opens a stream, drops it, and asserts the
subscriber set returns to its previous size — that is the right way to prove a
leak is gone.

404s on unknown codes for both the redirect and the stats route, 400 on a
malformed body, and the failure cases are covered. The burst test fires 200
concurrent clicks and asserts the total is exactly 200.

That is all nine findings addressed. Good work.

VERDICT: APPROVED`;

export class Rehearsal {
  readonly bus: EventBus;
  private readonly sandbox: Sandbox;
  /** Multiplier on every scripted pause. Lower is faster. */
  constructor(
    readonly goal: string,
    private readonly speed = REHEARSAL_SPEED,
  ) {
    const runId = `rehearsal-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
    this.bus = new EventBus(runId, goal);
    this.sandbox = new Sandbox(path.join(SANDBOX_ROOT, runId));
  }

  private pause(ms: number): Promise<void> {
    return sleep(ms * this.speed);
  }

  private phase(phase: Phase): void {
    this.bus.emit({ type: 'phase.changed', phase });
  }

  /** Stream a scripted line out as tokens, so the panels look alive. */
  private async say({ agentId, text }: Line, turn = 1): Promise<void> {
    this.bus.emit({ type: 'agent.status', agentId, status: 'thinking' });
    await this.pause(250);
    // Word-sized chunks: close enough to real token cadence to look right.
    const chunks = text.match(/\S+\s*/g) ?? [text];
    for (const chunk of chunks) {
      this.bus.emit({ type: 'agent.token', agentId, turn, text: chunk });
      await this.pause(9);
    }
    this.bus.emit({ type: 'agent.message', agentId, turn, text });
    this.bus.emit({ type: 'agent.status', agentId, status: 'idle' });
  }

  private async writeFixture(agentId: string, version: 'v1' | 'v2', file: string): Promise<void> {
    const contents = await fs.readFile(path.join(FIXTURES, version, file), 'utf8');
    this.bus.emit({ type: 'agent.status', agentId, status: 'tool', detail: 'write_file' });
    await executeToolWithEvents(this.bus, agentId, this.sandbox, 'write_file', { path: file, contents }, randomUUID());
    // Back to idle, or the agent sits there claiming to be writing a file for
    // the rest of the run — and on a booth loop, for the rest of the day.
    this.bus.emit({ type: 'agent.status', agentId, status: 'idle' });
    await this.pause(220);
  }

  async run(): Promise<{ ok: boolean; runId: string; deployUrl?: string }> {
    await teardown();
    await this.sandbox.init();
    this.bus.emit({ type: 'run.started', goal: this.goal, schemaVersion: 1, mode: 'rehearsal' });

    for (const spec of Object.values(specs())) {
      this.bus.emit({
        type: 'agent.spawned',
        agentId: spec.agentId,
        role: spec.role,
        label: spec.label,
        model: `${spec.model} (scripted)`,
      });
    }

    this.bus.drama('info', `Goal received: ${this.goal}`);
    this.bus.drama('warn', 'Rehearsal mode: agent dialogue is scripted. Tools, tests and the deploy are real.');

    // --- plan ---
    this.phase('planning');
    await this.say({ agentId: 'planner', text: PLAN_TEXT });
    this.bus.drama('good', 'Planner split the work: Store + analytics aggregation | HTTP server + live dashboard', 'planner');
    this.bus.emit({ type: 'message.sent', from: 'planner', to: 'engineer-a', kind: 'assign', summary: 'Store + analytics aggregation' });
    this.bus.emit({ type: 'message.sent', from: 'planner', to: 'engineer-b', kind: 'assign', summary: 'HTTP server + live dashboard' });

    // --- build (genuinely concurrent, like the real thing) ---
    this.phase('building');
    // Same as a live run: open the tunnel while there is still work to do, so
    // establishing it is not sitting on the critical path at the end. A quick
    // tunnel needs several seconds before its hostname routes anywhere.
    void prewarmTunnel(PORTS.app);
    this.bus.drama('info', 'Engineer A and Engineer B are writing code in parallel.');
    await Promise.all([
      (async () => {
        await this.say({ agentId: 'engineer-a', text: 'Taking store.js. Pure functions — a Map for the links, a Map for the hits, and the aggregation the dashboard renders: allStats, totalClicks, clicksPerSecond. Plus tests.' });
        await this.writeFixture('engineer-a', 'v1', 'package.json');
        await this.writeFixture('engineer-a', 'v1', 'store.js');
        await this.writeFixture('engineer-a', 'v1', 'store.test.js');
      })(),
      (async () => {
        await this.pause(400);
        await this.say({ agentId: 'engineer-b', text: 'Taking the server and the page. node:http, POST /api/links, GET /:code redirect, and an SSE stream at /api/stream so the chart moves without a reload.' });
        await this.writeFixture('engineer-b', 'v1', 'dashboard.js');
        await this.writeFixture('engineer-b', 'v1', 'server.js');
        await this.writeFixture('engineer-b', 'v1', 'server.test.js');
      })(),
    ]);
    this.bus.emit({ type: 'message.sent', from: 'engineer-a', to: 'reviewer', kind: 'submit', summary: '3 files' });
    this.bus.emit({ type: 'message.sent', from: 'engineer-b', to: 'reviewer', kind: 'submit', summary: '2 files' });

    // --- review round 1: rejected ---
    this.phase('review');
    this.bus.drama('info', 'Review round 1.', 'reviewer');
    this.bus.emit({ type: 'agent.status', agentId: 'reviewer', status: 'tool', detail: 'read_file' });
    for (const file of ['store.js', 'server.js', 'dashboard.js']) {
      await executeToolWithEvents(this.bus, 'reviewer', this.sandbox, 'read_file', { path: file }, randomUUID());
      await this.pause(180);
    }
    await this.say({ agentId: 'reviewer', text: REVIEW_1 });
    this.bus.drama('bad', 'Reviewer rejected the PR: the dashboard broadcasts a snapshot taken before the click it is reporting, so the chart is permanently one behind.', 'reviewer');
    for (const id of ['engineer-a', 'engineer-b']) {
      this.bus.emit({ type: 'message.sent', from: 'reviewer', to: id, kind: 'reject', summary: '9 findings' });
    }

    // --- fixes ---
    await Promise.all([
      (async () => {
        await this.say({ agentId: 'engineer-a', text: 'Fair. Findings 1-4 and 9 are mine. Adding validateUrl, collision retry, a soft recordHit, a cap on the hit list, and a burst test that fires 500 clicks and asserts the count is exact.' }, 2);
        await this.writeFixture('engineer-a', 'v2', 'store.js');
        await this.writeFixture('engineer-a', 'v2', 'store.test.js');
      })(),
      (async () => {
        await this.pause(300);
        await this.say({ agentId: 'engineer-b', text: 'Findings 5 to 9 are mine. Broadcasting after the write from a fresh snapshot, dropping subscribers on close and error, 404s on unknown codes, guarding the JSON parse, and a test that proves the stream stops leaking.' }, 2);
        await this.writeFixture('engineer-b', 'v2', 'dashboard.js');
        await this.writeFixture('engineer-b', 'v2', 'server.js');
        await this.writeFixture('engineer-b', 'v2', 'server.test.js');
      })(),
    ]);
    this.bus.drama('info', 'Engineers pushed fixes. Back to review.');

    // --- review round 2: approved ---
    this.bus.drama('info', 'Review round 2.', 'reviewer');
    await executeToolWithEvents(this.bus, 'reviewer', this.sandbox, 'read_file', { path: 'store.js' }, randomUUID());
    await this.say({ agentId: 'reviewer', text: REVIEW_2 }, 2);
    this.bus.drama('good', 'Reviewer approved the work on round 2.', 'reviewer');
    this.bus.emit({ type: 'message.sent', from: 'reviewer', to: 'tester', kind: 'approve', summary: 'approved on round 2' });

    // --- test (really runs) ---
    this.phase('testing');
    this.bus.emit({ type: 'agent.status', agentId: 'tester', status: 'tool', detail: 'run_tests' });
    const tests = await executeToolWithEvents(this.bus, 'tester', this.sandbox, 'run_tests', {}, randomUUID());
    const passed = tests.tests?.passed ?? 0;
    await this.say({
      agentId: 'tester',
      text: `Ran the suite. ${passed} passing, ${tests.tests?.failed ?? 0} failing.\n\nSUITE: ${tests.ok ? 'GREEN' : 'RED'}`,
    });
    if (!tests.ok) {
      this.bus.drama('bad', 'Suite is red. Not shipping.', 'tester');
      return this.finish(false);
    }
    this.bus.drama('good', `Suite is green: ${passed} passing.`, 'tester');
    this.bus.emit({ type: 'message.sent', from: 'tester', to: 'deployer', kind: 'report', summary: 'suite green' });

    // --- deploy (really deploys) ---
    this.phase('deploying');
    this.bus.emit({ type: 'deploy.started', agentId: 'deployer', target: 'app' });
    this.bus.emit({ type: 'agent.status', agentId: 'deployer', status: 'tool', detail: 'deploy' });
    const deployed = await executeToolWithEvents(this.bus, 'deployer', this.sandbox, 'deploy', { entry: 'server.js' }, randomUUID());
    const url = deployed.deploy?.url;

    if (!url) {
      this.bus.emit({ type: 'deploy.finished', agentId: 'deployer', ok: false, error: 'no url' });
      this.bus.drama('bad', 'Deployer could not ship it.', 'deployer');
      return this.finish(false);
    }

    await executeToolWithEvents(this.bus, 'deployer', this.sandbox, 'http_check', { url, path: '/health' }, randomUUID());
    await this.say({ agentId: 'deployer', text: `Started it and checked it answers on /health.\n\nSHIPPED: ${url}` });
    this.bus.emit({ type: 'deploy.finished', agentId: 'deployer', ok: true, url });
    this.bus.drama('good', `Shipped. It is live at ${url}`, 'deployer');

    return this.finish(true, url);
  }

  private finish(ok: boolean, deployUrl?: string): { ok: boolean; runId: string; deployUrl?: string } {
    settleAgents(this.bus, ok);
    this.phase(ok ? 'done' : 'failed');
    this.bus.emit({
      type: 'run.finished',
      ok,
      summary: ok ? `Shipped: ${deployUrl}` : 'Rehearsal did not ship.',
      ...(deployUrl ? { deployUrl } : {}),
    });
    return { ok, runId: this.bus.runId, ...(deployUrl ? { deployUrl } : {}) };
  }
}
