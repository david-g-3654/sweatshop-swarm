# Agent Arena

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
| **Orchestration** | Hand-rolled. ~400 lines of TypeScript, no LangGraph, no CrewAI. |
| **Agents** | A role, a system prompt, a tool whitelist, and a loop. That's it. |
| **Models** | Claude Opus 5 plans. Claude Sonnet 5 does the work. |
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
cp .env.example .env   # add your ANTHROPIC_API_KEY
```

Two processes:

```bash
npm run server
```

```bash
npm --workspace @arena/web run dev
```

Open <http://localhost:5250>, type a goal, press **Run live**.

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
