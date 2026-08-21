import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ArenaEvent, ClientFrame, ServerFrame } from '@arena/shared';
import { PORTS, PROVIDER } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { Rehearsal } from './rehearsal.js';
import { teardown } from './tools/deploy.js';
import * as recorder from './recorder.js';
import { hasKey } from './llm/client.js';

/**
 * The server the mission-control UI talks to.
 *
 * One run at a time, on purpose. Two concurrent runs would fight over the app
 * port and the sandbox, and there is exactly one projector.
 */

let running = false;
/** Events of the most recent run (live or loaded from disk) for late joiners. */
let currentEvents: ArenaEvent[] = [];
let currentRunId: string | null = null;
let currentGoal: string | null = null;

const clients = new Set<WebSocket>();

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

function broadcast(frame: ServerFrame): void {
  for (const client of clients) send(client, frame);
}

async function startRun(goal: string, mode: 'live' | 'rehearsal' = 'live'): Promise<void> {
  if (running) {
    broadcast({ kind: 'error', message: 'A run is already in progress.' });
    return;
  }
  running = true;

  const driver = mode === 'rehearsal' ? new Rehearsal(goal) : new Orchestrator({ goal });
  currentEvents = [];
  currentRunId = driver.bus.runId;
  currentGoal = goal;

  // Reset every connected client to the new run before anything else arrives.
  broadcast({ kind: 'snapshot', runId: currentRunId, goal, events: [] });

  driver.bus.subscribe((event) => {
    currentEvents.push(event);
    broadcast({ kind: 'event', event });
  });

  try {
    const outcome = await driver.run();
    const file = await recorder.save(driver.bus.toRecording());
    console.log(`[arena] run ${outcome.runId} ${outcome.ok ? 'succeeded' : 'failed'} — recorded to ${file}`);
    broadcast({ kind: 'runs', runs: await recorder.list() });
  } catch (err) {
    console.error('[arena] run crashed:', err);
    broadcast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
  }
}

async function loadRun(runId: string): Promise<void> {
  const run = await recorder.load(runId);
  if (!run) {
    broadcast({ kind: 'error', message: `No recorded run "${runId}".` });
    return;
  }
  // Hand the client the whole log at once. The scrubber does the pacing —
  // replay is the same events through the same reducer, not a video.
  currentEvents = run.events;
  currentRunId = run.runId;
  currentGoal = run.goal;
  broadcast({ kind: 'snapshot', runId: run.runId, goal: run.goal, events: run.events });
}

const server = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, running, runId: currentRunId }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (socket) => {
  clients.add(socket);
  send(socket, { kind: 'snapshot', runId: currentRunId, goal: currentGoal, events: currentEvents });
  send(socket, { kind: 'runs', runs: await recorder.list() });

  socket.on('message', async (raw) => {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(raw.toString()) as ClientFrame;
    } catch {
      send(socket, { kind: 'error', message: 'unparseable frame' });
      return;
    }

    switch (frame.kind) {
      case 'start':
        void startRun(frame.goal, frame.mode ?? 'live');
        break;
      case 'list-runs':
        send(socket, { kind: 'runs', runs: await recorder.list() });
        break;
      case 'load-run':
        void loadRun(frame.runId);
        break;
      default:
        send(socket, { kind: 'error', message: 'unknown frame' });
    }
  });

  socket.on('close', () => clients.delete(socket));
});

server.listen(PORTS.ws, () => {
  console.log(`[arena] mission control feed on ws://localhost:${PORTS.ws}`);
  console.log(`[arena] provider: ${PROVIDER}`);
  if (!hasKey()) {
    const key = PROVIDER === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
    console.warn(`[arena] ${key} is not set — live runs will fail, but Rehearse still works.`);
  }
});

// A run leaves a server (and maybe a tunnel) alive on purpose. Clean them up
// when the orchestrator itself goes down, or the port stays taken.
const shutdown = async () => {
  await teardown();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { startRun };
