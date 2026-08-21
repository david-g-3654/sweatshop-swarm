# Agent Arena

Watch a software team ship a feature live.

Give it a goal on stage — *"build and deploy a working URL shortener with analytics"* —
and a Planner decomposes it, two Engineers write code in parallel, a Reviewer
rejects the first PR and demands fixes, a Tester runs the suite, and a Deployer
ships it. At the end you open the URL and it works.

The graph isn't decoration. It's the product: agentic AI, made legible.

## Status

Early. See `docs/` for the architecture notes and the demo runbook.

## Layout

```
packages/shared/        event schema + agent roster (the contract)
packages/orchestrator/  the agent loop, tools, and WebSocket server
packages/web/           React + react-flow mission control
```

## Why hand-rolled orchestration

No LangGraph, no CrewAI. The loop is a few hundred lines of TypeScript I can
actually debug at 2am, and the interesting part of this project *is* the
orchestration — routing, review gates, conflict resolution, the observability
layer. The model writes code; everything that makes them a team is in here.
