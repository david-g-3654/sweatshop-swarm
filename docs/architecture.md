# Architecture

## The one decision everything else follows from

**Every agent action is an append-only event, and all view state is a pure
function of the event log.**

That's it. That single constraint gives, for free:

- **Live visualisation** — the UI is a reducer over a stream.
- **Late joiners** — a browser that connects halfway through gets the backlog,
  then the live feed, and lands in identical state to one that was there from
  the start.
- **Replay** — re-run the reducer over a prefix of the array.
- **Recording** — serialise the array.

There is no separate replay code path. There's nothing to have a separate path
*for*.

## The event schema

`packages/shared/src/events.ts`. Two rules keep it honest:

1. `seq` is a monotonic integer per run. Ordering is by `seq`, never by `ts`.
2. Events are facts about the past. Nothing mutates — a status change is a new
   event, not an edit to an old one.

`ts` exists only so replay can pace itself the way the run actually ran.

## The agent loop

`packages/orchestrator/src/agent.ts`. A role, a system prompt, a tool
whitelist, and a `for` loop.

Things that are easy to get wrong and are deliberately handled:

- **Append `response.content`, not the text.** Thinking blocks have to survive
  the round trip or the model loses its own reasoning between turns.
- **All tool results from one turn go back in a single user message.**
  Splitting them across messages quietly trains the model out of parallel tool
  calls.
- **Message history lives on the `Agent`.** This is what makes the review cycle
  work: when the Reviewer bounces a PR, the Engineer still remembers writing it.
- **Refusals are worded as instructions.** A refused tool call should cost a
  turn, not derail the run.

### Streaming and the inner monologue

Adaptive thinking with `display: "summarized"` is doing double duty. It's the
model's real reasoning summary, streamed token by token into the console panel.
The "inner monologue" the audience reads is genuine — not a paraphrase the UI
made up.

### Determinism without temperature

Sampling parameters (`temperature`, `top_p`, `top_k`) are **rejected with a 400**
on Claude Sonnet 5 and Opus 5. The usual "turn the temperature down for a
reliable demo" lever does not exist.

What replaces it:

- `output_config.effort` per role
- hard turn caps per agent, hard round caps per gate
- tight tool whitelists — an agent cannot call a tool it wasn't given
- a Planner prompt carrying the expected decomposition as an explicit prior

Structure does the work temperature used to.

## The pipeline

```
planner ──assign──▶ engineer-a ──submit──▶
                    engineer-b ──submit──▶ reviewer ──approve──▶ tester ──▶ deployer
                         ▲                     │
                         └───────reject────────┘
```

Three gates, three deliberate failure directions:

| Situation | Behaviour | Why |
|---|---|---|
| Reviewer gives no parseable verdict | Treated as **rejected** | If you can't tell approval from thinking out loud, "not approved" is the safe direction. |
| Tester says `SUITE: GREEN` but `run_tests` returned failures | **Red** | The tool result wins. A cheerful summary doesn't get to ship a red suite. |
| Planner returns unparseable JSON | Fall back to the default split, and **say so** in the drama feed | Visibly degrading beats a blank screen on stage. |

## The sandbox

Agents get a directory and an allowlist. Paths that escape the root are
refused; so are shell operators, so one tool call is one intent. This is a blast
radius limit, not a security boundary against a hostile model — the goal is that
a confused agent rewrites its own sandbox rather than the laptop.

## Deployment

One rule: **never report a URL that hasn't answered a request.** Spawning a
process and printing a link is not a deploy.

Backends: `tunnel` (cloudflared quick tunnel → public https in ~2s, falls back
to localhost loudly), `local`, and `fly` as a named plan B. Fly isn't the
default because a 1–3 minute deploy doesn't fit inside a 3 minute pitch.

## Rehearsal mode

Scripted dialogue, real everything else. It exists because the pipeline needed
to be testable without an API key, and it stayed because it's the venue-wifi
fallback. It drives the **same** event stream through the **same** tool
executor as a live run, so the UI is never tested against a shape that can't
actually occur.

It's labelled on the `run.started` event rather than as a UI setting,
specifically so it can't be presented as a live run by mistake.
