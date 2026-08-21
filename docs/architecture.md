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

## The wire

`packages/shared/src/protocol.ts` is the only thing both sides import, so the
compiler catches a mismatch rather than the demo doing it.

Server frames:

| Frame | When |
|---|---|
| `snapshot` | On connect, and again whenever a run starts or a recording is loaded. Carries the full event array. |
| `event` | One appended event. |
| `runs` | The list of recordings on disk. |
| `error` | Something the operator needs to see. |

Client frames are `start`, `list-runs`, `load-run`. That is the entire API.

A client that connects mid-run gets a `snapshot` of everything so far and then
joins the live `event` stream, which lands it in exactly the state a client
that was there from the beginning is in — because both did nothing but fold the
same events through the same reducer.

Only one run happens at a time, deliberately. Two would fight over the app port
and the sandbox, and there is one projector.

## The frontend

`packages/web/src/store.ts` holds the whole idea:

```
events: ArenaEvent[]        the log, append-only
cursor: number              how many of them are applied
derived: ArenaState         reduceEvents(events, cursor)
```

Scrubbing sets `cursor`. Following live keeps it pinned to `events.length`.
Nothing else changes, and no component knows which of those is happening.

Two details worth keeping:

- **Live extends, scrubbing rebuilds.** A new event while following applies to
  a clone of the current state; moving the cursor re-folds from zero. Same
  function, and the rebuild is a few milliseconds over hundreds of events.
- **The roster is seeded before any run starts**, so the graph renders its six
  stations greyed out rather than popping them in mid-demo.

### Why the visual language is what it is

The brief is not "dashboard", it is "broadcast": read from fifteen metres, for
three minutes, by a room. So the reference is a flight director's console, and
the mapping is structural rather than decorative — agents are console positions,
a review verdict genuinely is a GO/NO-GO gate, the drama feed is the flight
loop, the run clock is mission elapsed time.

Status colours are the only colours besides the amber, so anything coloured
means something. The one piece of choreography is the GO/NO-GO band, because
the review verdict is the one moment the audience must not miss.

## Providers

OpenRouter serves the **Anthropic Messages API**, not just an OpenAI-compatible
one, so switching providers is a base URL and a key — the agent loop, the tool
definitions and the streaming are untouched. `packages/orchestrator/src/llm/`
is the whole of it.

Two things that bite:

1. **The base URL is `https://openrouter.ai/api`, not `.../api/v1`.** The SDK
   appends `/v1/messages` itself; getting this wrong yields a 404 HTML page
   whose error message tells you nothing.
2. **Model ids are namespaced** — `anthropic/claude-sonnet-5`. Applied
   automatically when the provider is OpenRouter.

### Capability probing

A gateway may not accept every optional parameter (`thinking`,
`output_config.effort`, `strict` tools, `cache_control`), and a rejected
parameter is a 400 that kills the run instead of degrading it.

So each is a feature flag, defaulting off on OpenRouter and on for the direct
API, and `npm run probe` establishes the truth empirically — one small request
per feature — then prints the matching `.env`. Losing any of them costs polish,
not correctness; the consequences are documented in `config.ts` next to the
flags.

## Cost

`src/usage.ts` accumulates token usage per run and prices it, including the
1.25x cache-write and 0.1x cache-read multipliers. Reported in the flight loop
at the end of every run, successful or not.

It is an estimate from a local price table — the authoritative number is the
provider's dashboard — and a model with no price on file makes the figure a
stated floor rather than silently reading as zero.

### Where the money actually goes

Input, overwhelmingly. A measured live run spent 652k input tokens against 45k
output, because every turn resends the entire conversation so far, and six
agents each take several turns.

So there are two cache breakpoints, not one: the system prompt, and the last
block of the last message. The second is the one that matters — measured over
three turns, the first wrote 2235 tokens and the next two read them back while
writing only ~40 tokens of delta each. Cache writes cost 1.25x and reads 0.1x,
so it pays for itself from the second turn on.

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

## Recording

`src/recorder.ts` writes `runs/<runId>.json` when a run ends — the event log
plus enough header to list it. The filename must equal the `runId` inside it;
that is how the loader finds it, and run ids coming off the wire are pattern
checked before they touch the filesystem.

There is no separate "recorded run" format, because a recording is just the
array the UI was already consuming.

## Rehearsal mode

Scripted dialogue, real everything else. It exists because the pipeline needed
to be testable without an API key, and it stayed because it's the venue-wifi
fallback. It drives the **same** event stream through the **same** tool
executor as a live run, so the UI is never tested against a shape that can't
actually occur.

It's labelled on the `run.started` event rather than as a UI setting,
specifically so it can't be presented as a live run by mistake.
