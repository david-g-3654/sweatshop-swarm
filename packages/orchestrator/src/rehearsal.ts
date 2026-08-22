import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Phase } from '@swarm/shared';
import { REPO_ROOT, SANDBOX_ROOT, REHEARSAL_SPEED, PORTS } from './config.js';
import { EventBus } from './bus.js';
import { Sandbox } from './tools/index.js';
import { executeToolWithEvents } from './tools/execute.js';
import { prewarmTunnel } from './tools/deploy.js';
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
normalise(word) folds case and spacing and decides what a word is even allowed
to be, submit(word) counts it, and the page's numbers come from ranked(),
total(), uniqueWords() and weighted(). No HTTP in there, no markup.

Validation living on A's side is deliberate. Everything a stranger types passes
through normalise() before it exists anywhere else, so that is where safety
starts rather than something bolted on at the edge.

Engineer B owns transport and markup: server.js, the page it serves, and
server.test.js. It imports ./store.js, reads its port from process.env.PORT, and
pushes updates to every open screen over SSE at /api/stream.

The interface between them is those six exported functions, fixed now, because
they cannot talk while they work.

\`\`\`json
{
  "summary": "a live word cloud on plain Node, updating for everyone at once",
  "workstreams": [
    { "owner": "engineer-a", "title": "Word store + validation", "brief": "store.js and store.test.js" },
    { "owner": "engineer-b", "title": "HTTP server + live cloud", "brief": "server.js and server.test.js" }
  ],
  "acceptance": [
    "the suite is green",
    "the cloud updates without a page reload",
    "nothing a visitor types can reach another visitor as markup"
  ]
}
\`\`\``;

const REVIEW_1 = `I have read store.js, server.js and the page it serves. The
tests are green, and I am blocking this — the first finding is the kind that
ends up on a screen in front of a room.

1. server.js — the page builds its cloud by concatenating submitted words into
   an HTML string and assigning it to innerHTML. Every word came from a stranger
   and is rendered to every other visitor, so this is cross-site scripting on a
   shared screen. Submitting <img src=x onerror=...> runs script in the browser
   of everyone watching. Build nodes and set textContent instead.
2. store.js — normalise() only trims and lowercases. Anything at all is a valid
   word: an empty string, a number, an entire HTML document, three kilobytes of
   text. Validate it — non-empty string, length capped, and reduced to letters,
   digits and the punctuation that legitimately sits inside a word.
3. store.js — normalise() calls raw.trim() with no type check, so a non-string
   submission throws TypeError and takes the request down with it.
4. store.js — weighted() reads list[0].count without checking the list is
   non-empty, so the very first request to an empty cloud is a 500. The empty
   state is a state, and it is the one every visitor sees first.
5. store.js — counts and submissions both grow without limit. A booth running
   all day with an open submission endpoint is an unbounded memory leak.
6. server.js — nothing rate limits submissions. One person with a loop owns the
   entire cloud, which on a shared screen is a denial of service against the
   demo itself.
7. server.js — the POST handler builds its snapshot BEFORE recording the word
   and broadcasts that, so every screen renders the state from before the
   submission that triggered it. The cloud is permanently one word behind.
8. server.js — /api/stream adds the response to subscribers and never removes
   it. No 'close' handler, so every screen anyone opens is retained and written
   to for the life of the process.
9. server.js — JSON.parse on the body is unguarded, and any unknown path returns
   the page with a 200 instead of a 404.
10. Both test files only assert the happy path. Every public behaviour needs a
   failure-case test, and given finding 1, one of them has to be an attempt to
   submit markup and an assertion that it cannot survive.

VERDICT: CHANGES_REQUESTED`;

const REVIEW_2 = `Re-read both files.

The cross-site scripting hole is closed properly, and closed twice over.
normalise() now reduces a submission to letters, digits, hyphens and
apostrophes, so a tag cannot survive being stored; and the renderer builds
elements and sets textContent, so even if something did survive it would be
displayed rather than executed. Either one would have fixed it. Having both is
the right call for something a room is pointed at.

Validation covers type, emptiness and length, and rejects input with no letters
at all. weighted() handles the empty cloud. Both maps are bounded and the store
says the cloud is full rather than growing for ever. Submissions are rate
limited per client.

The broadcast happens after the write and builds a fresh snapshot, so screens
cannot sit one word behind. /api/stream drops its subscriber on close and on
error, and there is a test that opens a stream, drops it, and asserts the
subscriber set returns to its previous size — that is how you prove a leak is
gone rather than asserting it is.

400 on a malformed body, 404 on unknown paths, and the failure cases are
covered, including a submitted <img> tag asserted not to survive.

That is all ten findings addressed. Good work.

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
    this.bus.drama('good', 'Planner split the work: Word store + validation | HTTP server + live cloud', 'planner');
    this.bus.emit({ type: 'message.sent', from: 'planner', to: 'engineer-a', kind: 'assign', summary: 'Word store + validation' });
    this.bus.emit({ type: 'message.sent', from: 'planner', to: 'engineer-b', kind: 'assign', summary: 'HTTP server + live cloud' });

    // --- build (genuinely concurrent, like the real thing) ---
    this.phase('building');
    // Same as a live run: open the tunnel while there is still work to do, so
    // establishing it is not sitting on the critical path at the end. A quick
    // tunnel needs several seconds before its hostname routes anywhere.
    void prewarmTunnel(PORTS.app);
    this.bus.drama('info', 'Engineer A and Engineer B are writing code in parallel.');
    await Promise.all([
      (async () => {
        await this.say({ agentId: 'engineer-a', text: 'Taking store.js. Pure functions — a Map of word counts, normalise to fold case and spacing, and the aggregation the page renders: ranked, total, weighted. Plus tests.' });
        await this.writeFixture('engineer-a', 'v1', 'package.json');
        await this.writeFixture('engineer-a', 'v1', 'store.js');
        await this.writeFixture('engineer-a', 'v1', 'store.test.js');
      })(),
      (async () => {
        await this.pause(400);
        await this.say({ agentId: 'engineer-b', text: 'Taking the server and the page. node:http, POST /api/words, and an SSE stream at /api/stream so every screen updates the moment somebody submits.' });
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
    this.bus.drama('bad', 'Reviewer rejected the PR: submitted words are concatenated into innerHTML — anyone can run script in every viewer\'s browser.', 'reviewer');
    for (const id of ['engineer-a', 'engineer-b']) {
      this.bus.emit({ type: 'message.sent', from: 'reviewer', to: id, kind: 'reject', summary: '10 findings' });
    }

    // --- fixes ---
    await Promise.all([
      (async () => {
        await this.say({ agentId: 'engineer-a', text: 'Findings 2 to 5 and 10 are mine, and 2 is really half of finding 1. Adding a type check, a length cap, and reducing a submission to letters and digits so a tag cannot survive being stored. Fixing the empty-cloud crash, bounding both maps, and adding tests that try to submit markup.' }, 2);
        await this.writeFixture('engineer-a', 'v2', 'store.js');
        await this.writeFixture('engineer-a', 'v2', 'store.test.js');
      })(),
      (async () => {
        await this.pause(300);
        await this.say({ agentId: 'engineer-b', text: 'Finding 1 is mine and it is the bad one — the page concatenates submitted words into innerHTML. Rewriting the renderer to build elements and set textContent. Then rate limiting, broadcasting after the write, dropping subscribers on close, guarding the parse, and 404s.' }, 2);
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
