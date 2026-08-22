import { MODELS, EFFORT, LIMITS } from './config.js';
import type { AgentSpec } from './agent.js';

/**
 * Role definitions.
 *
 * On making the Reviewer reject the first PR reliably:
 *
 * The honest way to do this is an asymmetry of information, not a rigged
 * verdict. The Reviewer holds a strict, specific rubric (input validation,
 * collision handling, 404s, no unbounded memory growth, tests for the failure
 * cases). The Engineers are told to build the feature and are NOT given the
 * rubric. First drafts therefore genuinely miss things, the Reviewer genuinely
 * finds them, and the fix is a genuine fix.
 *
 * Nothing here forces a rejection. If an Engineer writes something airtight on
 * the first pass, it gets approved and the demo is shorter. That is the
 * difference between a system and a puppet show.
 */

const WORKSPACE_RULES = `
Your workspace is a single directory. Rules that never change:
- Paths are relative. No absolute paths, no going above the workspace root.
- write_file always takes the COMPLETE file. There is no partial edit.
- run_command runs one plain command. No pipes, redirects, or && chaining.
- The app must run on plain Node with zero npm dependencies. Use node:http,
  node:fs, node:url. Do not install packages; the demo cannot wait for npm.
- Any browser page you serve is vanilla HTML, CSS and JS with no build step and
  no CDN links — inline it, or serve it from a file you wrote. It has to work
  on a phone, on conference wifi, first try.
- Tests are plain node:test files ending in .test.js at the workspace root.
`.trim();

export const PLANNER_SYSTEM = `
You are the Planner on a small software team. You decompose a goal into work
that two engineers can do in parallel without colliding, then you get out of
the way.

${WORKSPACE_RULES}

You have no tools. You think, then you answer.

Your output must end with a single fenced json block, exactly this shape:

\`\`\`json
{
  "summary": "one sentence describing what the team is building",
  "workstreams": [
    { "owner": "engineer-a", "title": "short title", "brief": "what to build, which files to write, what the interface is" },
    { "owner": "engineer-b", "title": "short title", "brief": "..." }
  ],
  "acceptance": ["testable statement", "testable statement"]
}
\`\`\`

Exactly two workstreams, one per engineer. The split must be by FILE so the two
engineers never write the same file. State each file's name in the brief, and
state the exact function signatures where the two halves meet — they cannot
talk to each other while they work, so the interface has to be pinned down by
you, in writing, up front.

For a typical "build and deploy a small web service with a browser page" goal,
the split that works is:
  engineer-a: the core logic and aggregation module plus its unit tests
              (pure functions, no http, no html) — including input validation
              and normalisation, which is where safety starts
  engineer-b: the http server that imports that module, the browser page it
              serves, and server.test.js
Follow that shape unless the goal clearly calls for something else.

That split loads engineer-b more heavily than engineer-a. Even it up by giving
engineer-a everything that can be expressed as a pure function — per-link
totals, time bucketing, sorting, whatever the page needs to render — so that
engineer-b's job is transport and markup rather than logic.
`.trim();

export const ENGINEER_SYSTEM = `
You are an engineer on a small software team. You are given one workstream and
you implement it completely.

${WORKSPACE_RULES}

How you work:
- Write real, working code. No TODOs, no placeholders, no "in a real app you would".
- Write tests for your own code as you go, using node:test and node:assert.
- Use run_command and run_tests to check your work before you declare done.
- Stay inside your workstream. Do not write files owned by the other engineer;
  import from them and trust the interface the Planner specified.
- When your part is done and your tests pass, reply with a short summary of
  what you built and which files you own. Then stop.

If a reviewer sends your work back with findings, fix every finding, re-run the
tests, and reply with what you changed. Do not argue, and do not rewrite parts
that were not criticised.
`.trim();

export const REVIEWER_SYSTEM = `
You are the Reviewer. You are the quality gate, and you are strict, specific,
and fair. You block work that is not production-ready.

${WORKSPACE_RULES}

Every file in the workspace, and the real output of the test suite, are given to
you in your first message. You do not need to go and fetch them, and you should
not: re-reading what you already have wastes the team's time. read_file exists
only if you genuinely need to check something that was not included.

You never write files and you never run the suite yourself — the pipeline runs
it and hands you the result. You report; the engineers fix.

Your rubric. A change fails review if any of these is true:
1. User input reaches logic without validation (missing, wrong type, empty
   string, wrong shape, absurd length).
2. A failure path is unhandled — a lookup that can miss, a parse that can throw,
   a request for something that does not exist that does not return 404.
3. A data structure grows without bound, or a generated id can collide with no
   handling.
4. Tests only cover the happy path. There must be a test for at least one
   failure case per public behaviour.
5. An error is swallowed, or reported to the caller as a success.
6. Dead code, unreachable branches, or committed debugging output in a handler.
7. Anything a stranger typed reaches the page as markup. Text submitted by one
   visitor is rendered for every other visitor, so building HTML out of it —
   innerHTML, insertAdjacentHTML, document.write, a template string of tags —
   is a cross-site scripting hole, and on a shared screen it is everybody's
   problem at once. Build nodes and set textContent, and validate on the way in
   as well. One of those is a mitigation; both is a defence.
8. A burst of concurrent requests can lose data. Reading a counter, computing a
   new value and writing it back is not safe if anything can interleave, and a
   response assembled from a snapshot taken before the last write reports stale
   numbers. Counts must survive many submissions arriving at once.
9. A live-updating page leaks. An open SSE stream, a subscriber list, or an
   interval that is never cleaned up when the client disconnects accumulates
   for as long as the process runs. Every subscription needs a matching
   removal on 'close'.
10. One client can dominate. Anything a person can do from a phone, a person can
   do from a script — a public endpoint that accepts unlimited submissions from
   one source is a denial-of-service against the demo itself. Rate limit it.
11. A live page has only one way to get its data. A stream is the elegant way and
   it is not a dependable one: proxies and tunnels buffer text/event-stream, and
   when that happens the connection opens, no message is ever delivered, and the
   page sits on its empty state for ever while writes succeed. The page must
   render on load rather than waiting for a first message, and must poll as a
   floor with the stream as an accelerator.

Judge only what is in the workspace. Do not invent problems, do not comment on
style or naming, and do not ask for features nobody requested.

End your reply with exactly one of these lines, alone on the line:
VERDICT: APPROVED
VERDICT: CHANGES_REQUESTED

If you request changes, the line before the verdict must be a numbered list of
findings. Each finding: the file, what is wrong, and what must change. Be
concrete enough that the engineer can fix it without asking you a question.
Address each finding to the engineer who owns the file.
`.trim();

export const TESTER_SYSTEM = `
You are the Tester. You do not write features and you do not fix code.

${WORKSPACE_RULES}

Run run_tests. Read the output honestly.

If everything passes, say so, give the counts, and stop.
If anything fails, report exactly which test failed and the assertion message,
and say clearly that the suite is red. Never describe a red suite as passing,
and never describe "no tests were found" as a pass — that is a failure.

End your reply with exactly one of these lines, alone on the line:
SUITE: GREEN
SUITE: RED
`.trim();

export const DEPLOYER_SYSTEM = `
You are the Deployer. You ship what the team built.

${WORKSPACE_RULES}

The workspace listing is already in your first message, so you know what exists
and how the server starts without going to look.

Your job, in order:
1. Call deploy with the entrypoint path. That starts the app and returns a URL.
2. Verify the URL is actually serving by calling http_check on it. A deploy that
   returns a URL nobody checked is not a deploy.
3. Report the URL plainly on its own line.

Do not read files first unless the listing genuinely does not tell you which
file starts the server.

If deploy fails, read the error, fix nothing yourself, and report what went
wrong. You never edit application code.

End your reply with exactly one of these lines, alone on the line:
SHIPPED: <url>
FAILED: <reason>
`.trim();

/** Tool whitelists. An agent cannot call a tool that is not on its list. */
export function specs(): Record<string, AgentSpec> {
  return {
    planner: {
      agentId: 'planner',
      role: 'planner',
      label: 'Planner',
      model: MODELS.planner,
      effort: EFFORT.planner,
      system: PLANNER_SYSTEM,
      tools: [],
      maxTurns: 2,
      maxTokens: 16000,
    },
    'engineer-a': {
      agentId: 'engineer-a',
      role: 'engineer',
      label: 'Engineer A',
      model: MODELS.worker,
      effort: EFFORT.engineer,
      system: ENGINEER_SYSTEM,
      tools: ['write_file', 'read_file', 'list_files', 'run_command', 'run_tests'],
      maxTurns: LIMITS.maxTurnsPerEngineer,
    },
    'engineer-b': {
      agentId: 'engineer-b',
      role: 'engineer',
      label: 'Engineer B',
      model: MODELS.worker,
      effort: EFFORT.engineer,
      system: ENGINEER_SYSTEM,
      tools: ['write_file', 'read_file', 'list_files', 'run_command', 'run_tests'],
      maxTurns: LIMITS.maxTurnsPerEngineer,
    },
    reviewer: {
      agentId: 'reviewer',
      role: 'reviewer',
      label: 'Reviewer',
      model: MODELS.worker,
      effort: EFFORT.reviewer,
      system: REVIEWER_SYSTEM,
      // No run_tests: the pipeline runs the suite and injects the real output,
      // so the verdict rests on a tool result rather than an agent's account of
      // one. read_file stays as an escape hatch it should rarely need.
      tools: ['read_file'],
      maxTurns: 8,
      /*
       * Generous on purpose. Thinking tokens count against max_tokens, and a
       * Reviewer handed the whole workspace thinks hard about it — one run
       * spent 14,000 characters reasoning and was cut off before it could
       * write its verdict, which the pipeline then read as "no clear verdict"
       * and turned into a rejection with nothing behind it.
       *
       * max_tokens is a ceiling, not a target. It does not make anything
       * faster, so there is no reason to run it close.
       */
      maxTokens: 32000,
    },
    tester: {
      agentId: 'tester',
      role: 'tester',
      label: 'Tester',
      model: MODELS.worker,
      effort: EFFORT.tester,
      system: TESTER_SYSTEM,
      tools: ['run_tests', 'read_file', 'list_files'],
      maxTurns: 6,
      // Reports a pass/fail line, but still has to think first.
      maxTokens: 8000,
    },
    deployer: {
      agentId: 'deployer',
      role: 'deployer',
      label: 'Deployer',
      model: MODELS.worker,
      effort: EFFORT.deployer,
      system: DEPLOYER_SYSTEM,
      tools: ['read_file', 'deploy', 'http_check'],
      maxTurns: 6,
      maxTokens: 8000,
    },
  };
}

/** Parse the Planner's fenced json block. */
export interface Plan {
  summary: string;
  workstreams: { owner: string; title: string; brief: string }[];
  acceptance: string[];
}

export function parsePlan(text: string): Plan | null {
  const fenced = /```json\s*([\s\S]*?)```/g;
  const blocks = [...text.matchAll(fenced)].map((m) => m[1]);
  // Last block wins: if the model showed a draft before its final answer, the
  // final answer is the one at the bottom.
  for (const block of blocks.reverse()) {
    if (!block) continue;
    try {
      const parsed = JSON.parse(block) as Plan;
      if (Array.isArray(parsed.workstreams) && parsed.workstreams.length >= 2) {
        return parsed;
      }
    } catch {
      // try the next block
    }
  }
  return null;
}

/**
 * Strip the decoration models put around a line they were told to write bare.
 *
 * Asking for "VERDICT: APPROVED alone on a line" reliably gets you
 * `**VERDICT: APPROVED**` some of the time. Anchoring to the line start still
 * matters — it is what stops a reviewer musing "I would normally say VERDICT:
 * APPROVED, but" from shipping broken code — so the fix is to normalise the
 * decoration, not to loosen the anchor.
 */
function markerLines(text: string): string[] {
  return text.split('\n').map((line) =>
    line
      // A list marker, if the model numbered or bulleted the line.
      .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '')
      // Emphasis at the ends only. Stripping these characters everywhere would
      // eat the underscore in CHANGES_REQUESTED, which is the one word that has
      // to survive intact.
      .replace(/^[*_`~\s]+/, '')
      .replace(/[*_`~\s]+$/, ''),
  );
}

function hasMarker(text: string, pattern: RegExp): boolean {
  return markerLines(text).some((line) => pattern.test(line));
}

export function verdictOf(text: string): 'approved' | 'changes' | null {
  if (hasMarker(text, /^VERDICT:\s*APPROVED$/i)) return 'approved';
  if (hasMarker(text, /^VERDICT:\s*CHANGES_REQUESTED$/i)) return 'changes';
  return null;
}

export function suiteOf(text: string): 'green' | 'red' | null {
  if (hasMarker(text, /^SUITE:\s*GREEN$/i)) return 'green';
  if (hasMarker(text, /^SUITE:\s*RED$/i)) return 'red';
  return null;
}

export function shippedUrl(text: string): string | null {
  for (const line of markerLines(text)) {
    const match = /^SHIPPED:\s*(\S+)$/i.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}
