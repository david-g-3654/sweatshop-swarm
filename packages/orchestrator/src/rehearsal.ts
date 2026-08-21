import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Phase } from '@swarm/shared';
import { REPO_ROOT, SANDBOX_ROOT, REHEARSAL_SPEED } from './config.js';
import { EventBus } from './bus.js';
import { Sandbox } from './tools/index.js';
import { executeToolWithEvents } from './tools/execute.js';
import { teardown } from './tools/deploy.js';
import { specs } from './roles.js';

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

Engineer A owns the pure logic: store.js plus store.test.js. No HTTP in there at
all — shorten(url) returns a code, resolve(code) returns a url, recordHit(code,
referrer) and stats(code) handle the analytics.

Engineer B owns the transport: server.js plus server.test.js, importing
./store.js and reading its port from process.env.PORT.

The interface between them is those four exported functions. They cannot talk
while they work, so that contract is fixed now.

\`\`\`json
{
  "summary": "a URL shortener with click analytics, on plain Node",
  "workstreams": [
    { "owner": "engineer-a", "title": "Core store + analytics", "brief": "store.js and store.test.js" },
    { "owner": "engineer-b", "title": "HTTP server", "brief": "server.js and server.test.js" }
  ],
  "acceptance": ["the suite is green", "the server responds over HTTP", "clicks are counted per code"]
}
\`\`\``;

const REVIEW_1 = `I have read store.js and server.js. The tests are green, and I am
still sending this back — a green suite that only covers the happy path is
exactly the thing my rubric exists to catch.

1. store.js — shorten() takes whatever it is handed. null, an empty string, a
   number, "not a url", a three-kilobyte string all become links. Validate the
   input: non-empty string, parseable as a URL, http or https only, length
   capped.
2. store.js — createCode() can collide. On a collision shorten() silently
   overwrites somebody else's link and their traffic starts going somewhere
   else. Retry on collision and fail loudly if you cannot allocate one.
3. store.js — recordHit() calls hits.get(code).push(...) with no check. An
   unknown code throws TypeError on undefined. It must fail softly.
4. store.js — the hits array grows without bound. One hammered link is an
   unbounded memory leak. Cap it.
5. server.js — JSON.parse on the request body is unguarded. A malformed body is
   an unhandled rejection and a 500 where it should be a 400.
6. server.js — resolve() returning undefined is passed straight into the 302
   Location header. An unknown code redirects the browser to "undefined"
   instead of returning 404. Same for /api/stats/, which serves a JSON body of
   nulls with a 200.
7. Both test files only assert the happy path. Every public behaviour needs a
   failure-case test: bad input, unknown code, malformed body.

VERDICT: CHANGES_REQUESTED`;

const REVIEW_2 = `Re-read both files.

Validation is in and normalises the URL rather than echoing it back. Collisions
retry and then fail loudly. recordHit returns false on an unknown code instead
of throwing, and the hit list is capped. The server returns 400 on a malformed
body and 404 on an unknown code for both the redirect and the stats route.

The failure cases are covered now — bad input, unknown code, malformed body,
and the 404s are asserted on both routes.

That is all seven findings addressed. Good work.

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
    this.bus.drama('good', 'Planner split the work: Core store + analytics | HTTP server', 'planner');
    this.bus.emit({ type: 'message.sent', from: 'planner', to: 'engineer-a', kind: 'assign', summary: 'Core store + analytics' });
    this.bus.emit({ type: 'message.sent', from: 'planner', to: 'engineer-b', kind: 'assign', summary: 'HTTP server' });

    // --- build (genuinely concurrent, like the real thing) ---
    this.phase('building');
    this.bus.drama('info', 'Engineer A and Engineer B are writing code in parallel.');
    await Promise.all([
      (async () => {
        await this.say({ agentId: 'engineer-a', text: 'Taking store.js. Pure functions, a Map for the links and a Map for the hits, plus tests.' });
        await this.writeFixture('engineer-a', 'v1', 'package.json');
        await this.writeFixture('engineer-a', 'v1', 'store.js');
        await this.writeFixture('engineer-a', 'v1', 'store.test.js');
      })(),
      (async () => {
        await this.pause(400);
        await this.say({ agentId: 'engineer-b', text: 'Taking server.js. node:http, POST /api/shorten, GET /:code redirect, GET /api/stats/:code.' });
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
    for (const file of ['store.js', 'server.js']) {
      await executeToolWithEvents(this.bus, 'reviewer', this.sandbox, 'read_file', { path: file }, randomUUID());
      await this.pause(180);
    }
    await this.say({ agentId: 'reviewer', text: REVIEW_1 });
    this.bus.drama('bad', 'Reviewer rejected the PR: shorten() takes whatever it is handed — no input validation.', 'reviewer');
    for (const id of ['engineer-a', 'engineer-b']) {
      this.bus.emit({ type: 'message.sent', from: 'reviewer', to: id, kind: 'reject', summary: '7 findings' });
    }

    // --- fixes ---
    await Promise.all([
      (async () => {
        await this.say({ agentId: 'engineer-a', text: 'Fair. Findings 1-4 and 7 are mine. Adding validateUrl, collision retry, a soft recordHit, a cap on the hit list, and failure-case tests.' }, 2);
        await this.writeFixture('engineer-a', 'v2', 'store.js');
        await this.writeFixture('engineer-a', 'v2', 'store.test.js');
      })(),
      (async () => {
        await this.pause(300);
        await this.say({ agentId: 'engineer-b', text: 'Findings 5, 6 and 7 are mine. Guarding the JSON parse for a 400, returning 404 on unknown codes for both routes, and adding tests for each.' }, 2);
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
