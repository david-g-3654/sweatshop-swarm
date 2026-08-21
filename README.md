# Sweatshop Swarm

**Watch a software team ship a feature live.**

Give it a goal — *"build and deploy a working URL shortener with click
analytics"* — and six agents go to work in front of you. A Planner decomposes
it. Two Engineers write code in parallel. A Reviewer reads what they wrote and
sends it back. The Engineers fix it. A Tester runs the suite. A Deployer ships
it.

At the end there is a URL. You click it. It works.

The graph isn't decoration — it's the product. This is agentic AI made legible.

---

## What's actually happening

| | |
|---|---|
| **Orchestration** | Hand-rolled. No LangGraph, no CrewAI. ~780 lines: the agent loop (195), the pipeline (236), the role prompts (205), the provider layer (79), the event bus (61). |
| **Agents** | A role, a system prompt, a tool whitelist, and a loop. That's it. |
| **Models** | Claude Opus 5 plans. Claude Sonnet 5 does the work. |
| **Providers** | Anthropic directly, or OpenRouter — which serves the same Messages API, so it's a base-URL swap, not a second code path. |
| **Tools** | `write_file`, `read_file`, `list_files`, `run_command`, `run_tests`, `deploy`, `http_check` — all sandboxed. |
| **Transport** | Every agent action is an event on a WebSocket. The event schema is the contract. |
| **UI** | React + React Flow, driven entirely by that event stream. |

### The review loop is real

The Reviewer rejecting the first pass is the moment the demo turns on, so it
happens for a real reason rather than a scripted one.

The Reviewer holds a strict rubric — input validation, unhandled failure paths,
unbounded growth, id collisions, failure-case test coverage. **The Engineers are
never shown that rubric.** First drafts genuinely miss things; the Reviewer
genuinely finds them.

Nothing forces a rejection. If an Engineer writes something airtight first time,
it gets approved and the demo is shorter. Rigging the verdict would make this a
puppet show instead of a system.

Here is what it actually caught on a live run — after running the suite itself
and watching **29 of 29 tests pass**:

> `store.js`, `addLink`: the custom-code validation only ever runs
> `/^[A-Za-z0-9_-]{1,32}$/.test(code)` against `opts.code` without first
> checking `typeof code === 'string'`. Because `RegExp.prototype.test` coerces
> its argument to a string, non-string inputs sneak through validation when
> their string form happens to match the pattern: `code: null` stringifies to
> `"null"` (passes, gets stored, and echoed back to the caller).
>
> **VERDICT: CHANGES_REQUESTED**

A green suite, a real type-coercion bug, and a reviewer that blocked the merge
anyway. Nobody scripted that.

### It has actually done this

A full live run, end to end, against OpenRouter:

| | |
|---|---|
| Duration | **5.9 min** — 55s planning, 1m56s building, 2m47s review, 5s tests, 13s deploy |
| Outcome | Rejected on round 1, fixed, approved on round 2 |
| Tests | Went red mid-run (13 passed / 3 failed), ended **30 passing** |
| Deploy | Health check returned `200 {"ok":true}` |
| Events | 530 |

Review is the longest phase, which is the right shape for the thing being
demonstrated.

### Replay is not a video

A recorded run is the event log and nothing else, because the event log is the
only thing the UI ever consumed. Replaying one re-runs the same pure reducer
over a prefix of the same array — same events, same order, same durations.

There is no "replay mode" branch in the frontend, because there's nothing to
branch on. That's why the scrubber is honest to put on a projector.

---

## Running it

```bash
npm install
cp .env.example .env
```

Put **one** key in `.env` — `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`. The
provider is detected from whichever is there.

Then find out what your provider actually supports:

```bash
npm run probe
```

A gateway isn't obliged to accept every parameter the first-party API takes, and
a rejected parameter is a 400 that kills a run rather than degrading it. So the
probe sends one tiny request per feature, reports what came back, and prints the
`.env` lines that match reality. Costs a fraction of a cent.

Two processes:

```bash
npm run server
```

```bash
npm --workspace @swarm/web run dev
```

Open <http://localhost:5250>, type a goal, press **Run live**.

### Commands

| | |
|---|---|
| `npm run server` | The orchestrator and the WebSocket feed. |
| `npm run probe` | Ask your provider which features it really supports. |
| `npm run rehearse` | Full pipeline, scripted dialogue, no API calls. |
| `npm run swarm` | One live run, headless. `-- --goal "..."` to set the goal. |
| `npm test` | Unit tests for the sandbox, parsers and cost meter. |
| `npm run typecheck` | |

Both CLI runners tear the deployment down when they exit. Pass `--keep-alive`
to leave the URL serving afterwards:

```bash
npm run swarm -- --keep-alive --goal "Build and deploy a paste bin."
```

The UI's **Run live** button leaves it up regardless.

### What a run costs

Every run reports its own bill in the flight loop — *"Run cost about $0.38 —
294k in, 21k out, 180k served from cache"* — including failed runs, since those
are the ones you most want the number for.

Measured, on the default models (Opus 5 planning, Sonnet 5 working), for a full
run that went through a review rejection and 30 passing tests:

| | |
|---|---|
| First measured run | **$1.75** — 652k in, 45k out, only 44k from cache |
| After caching conversation history | roughly **half that** |

The first figure is what it cost before the loop cached anything but the system
prompt. The agent loop resends the entire conversation every turn, so those
tokens were billed at full price a dozen times over; a second cache breakpoint
on the last message means each turn now reads the prior turn's whole prefix at
a tenth of the price, writing only the delta.

Budget from your own number, not this one — the flight loop prints the run's
actual cost every time.

To stretch a small balance further: put Sonnet on the Planner too, or drop the
workers to Haiku 4.5 (see `.env.example`), and lower `SWARM_MAX_TURNS`.

**Rehearsal mode costs nothing**, so iterate on the UI with that and spend
credit only on real rehearsals.

### Without an API key

**Rehearsal mode** scripts the agents' dialogue and leaves everything else real:
real files, `node --test` really runs, the server really starts, the URL really
serves. Only the model calls are replaced.

```bash
npm run rehearse
```

Or press **Rehearse** in the UI. Runs are badged `REHEARSAL` from the event
stream itself, not from a UI toggle, so a rehearsal can't be shown as a live run
by accident.

---

## Layout

```
packages/shared/        event schema, roster, wire protocol — the contract
packages/orchestrator/  agent loop, tools, pipeline, WebSocket server
packages/web/           React Flow mission control
runs/                   recorded runs, replayable through the scrubber
sandbox/                where the agents actually work (gitignored)
docs/                   architecture notes and the demo runbook
```

## Docs

- [Architecture](docs/architecture.md) — the event schema, the loop, why it's shaped this way
- [Demo runbook](docs/runbook.md) — what to do on stage, and what to do when it breaks

## Why hand-rolled orchestration

Because the interesting part of this project *is* the orchestration. The model
writes code; everything that makes six models into a team — routing, review
gates, conflict resolution, the observability layer — is the thing being built
here. A framework would have hidden exactly the part worth showing.
