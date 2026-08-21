import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SwarmEvent, ClientFrame, ServerFrame } from '@swarm/shared';
import { PORTS, PROVIDER, MODELS, FEATURES, BOOTH_DWELL_SECONDS, BOOTH_ON_BOOT } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { Rehearsal } from './rehearsal.js';
import { shutdown as stopDeployments } from './tools/deploy.js';
import * as recorder from './recorder.js';
import { hasKey, keyFingerprint } from './llm/client.js';

/**
 * The server the mission-control UI talks to.
 *
 * One run at a time, on purpose. Two concurrent runs would fight over the app
 * port and the sandbox, and there is exactly one projector.
 */

let running = false;
/** Events of the most recent run (live or loaded from disk) for late joiners. */
let currentEvents: SwarmEvent[] = [];
let currentRunId: string | null = null;
let currentGoal: string | null = null;
/** True when currentEvents belong to a run this process performed. */
let currentIsLive = false;

const clients = new Set<WebSocket>();

/**
 * Booth loop.
 *
 * At a showcase the screen has to be doing something whenever anyone glances
 * over — a still frame gets walked past. Rehearsal mode costs nothing per run
 * and still ships a real, working URL, so it can run all session.
 *
 * Between runs the shipped app is deliberately left up for a dwell period. The
 * booth rhythm is: watch the agents argue for half a minute, then have several
 * minutes of a live app you can actually poke at. Restarting immediately would
 * yank the app out from under anyone using it.
 *
 * Only rehearsal loops. Looping live runs would spend real money unattended,
 * which is not a thing to leave running while you talk to someone.
 */
let loopEnabled = false;
let loopGoal: string | null = null;
let loopTimer: NodeJS.Timeout | null = null;
let nextRunAt: number | null = null;

function loopFrame(): ServerFrame {
  return {
    kind: 'loop',
    enabled: loopEnabled,
    dwellSeconds: BOOTH_DWELL_SECONDS,
    nextRunInSeconds: nextRunAt ? Math.max(0, Math.round((nextRunAt - Date.now()) / 1000)) : null,
  };
}

function cancelLoopTimer(): void {
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = null;
  nextRunAt = null;
}

function scheduleNextLoopRun(): void {
  cancelLoopTimer();
  if (!loopEnabled) return;
  nextRunAt = Date.now() + BOOTH_DWELL_SECONDS * 1000;
  broadcast(loopFrame());
  loopTimer = setTimeout(() => {
    loopTimer = null;
    nextRunAt = null;
    if (loopEnabled && !running) void startRun(loopGoal ?? DEFAULT_GOAL, 'rehearsal');
  }, BOOTH_DWELL_SECONDS * 1000);
}

function setLoop(enabled: boolean, goal?: string): void {
  loopEnabled = enabled;
  if (goal) loopGoal = goal;
  if (!enabled) {
    cancelLoopTimer();
    broadcast(loopFrame());
    return;
  }
  broadcast(loopFrame());
  // Arming it while nothing is running should start something immediately;
  // nobody taps "loop" to then watch a blank screen for two minutes.
  if (!running) void startRun(loopGoal ?? DEFAULT_GOAL, 'rehearsal');
}

const DEFAULT_GOAL =
  'Build and deploy a URL shortener with a real-time analytics dashboard showing clicks per link as a live-updating chart.';

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
  currentIsLive = true;
  broadcast({ kind: 'snapshot', runId: currentRunId, goal, events: [], live: true });

  driver.bus.subscribe((event) => {
    currentEvents.push(event);
    broadcast({ kind: 'event', event });
  });

  try {
    const outcome = await driver.run();
    const file = await recorder.save(driver.bus.toRecording());
    console.log(`[swarm] run ${outcome.runId} ${outcome.ok ? 'succeeded' : 'failed'} — recorded to ${file}`);
    broadcast({ kind: 'runs', runs: await recorder.list() });
  } catch (err) {
    console.error('[swarm] run crashed:', err);
    broadcast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
    // The deployment stays up through the dwell — that is the point of it.
    scheduleNextLoopRun();
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
  currentIsLive = false;
  broadcast({ kind: 'snapshot', runId: run.runId, goal: run.goal, events: run.events, live: false });
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

/**
 * Register the message handler before anything can yield.
 *
 * This used to send the opening frames first, one of which awaited a directory
 * read — and a frame arriving during that await was dropped on the floor, because
 * ws has no handler to deliver it to yet and does not buffer.
 *
 * The symptom was a button doing nothing when pressed straight after the page
 * loaded, which is the single worst failure mode at a booth: it looks broken,
 * and pressing it again works, so you never trust it. Handler first, greetings
 * after.
 */
wss.on('connection', (socket) => {
  clients.add(socket);

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
      case 'set-loop':
        setLoop(frame.enabled, frame.goal);
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

  // Greetings. Synchronous ones first; the run list can arrive whenever.
  send(socket, {
    kind: 'snapshot',
    runId: currentRunId,
    goal: currentGoal,
    events: currentEvents,
    live: currentIsLive,
  });
  send(socket, loopFrame());
  void recorder.list().then((runs) => send(socket, { kind: 'runs', runs }));
});

/**
 * A port collision is the likeliest thing to go wrong when restarting mid-demo,
 * and the default behaviour is an unhandled 'error' event and a stack trace.
 *
 * The handler goes on both the http server and the WebSocketServer: ws re-emits
 * the underlying server's error on itself, so handling only one of them still
 * leaves the other unhandled and still crashes.
 */
function onServerError(err: NodeJS.ErrnoException): void {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[swarm] port ${PORTS.ws} is already in use — another server is probably still running.\n` +
        `        kill it:      lsof -ti:${PORTS.ws} | xargs kill\n` +
        `        or move it:   SWARM_WS_PORT=8788 npm run server`,
    );
    process.exit(1);
  }
  console.error('[swarm] server error:', err.message);
  process.exit(1);
}

server.on('error', onServerError);
wss.on('error', onServerError);

server.listen(PORTS.ws, () => {
  // Everything that decides whether a live run can work, on four lines, before
  // anyone presses a button. A stale server or a bad key shows up here rather
  // than as a wall of identical failures a minute into a demo.
  const enabled = Object.entries(FEATURES)
    .filter(([, on]) => on)
    .map(([name]) => name);
  console.log(`[swarm] mission control feed on ws://localhost:${PORTS.ws}`);
  console.log(`[swarm] provider ${PROVIDER}  key ${keyFingerprint()}`);
  console.log(`[swarm] models   ${MODELS.planner} / ${MODELS.worker}`);
  console.log(`[swarm] features ${enabled.length ? enabled.join(' ') : 'none'}`);
  if (BOOTH_ON_BOOT) {
    console.log(`[swarm] booth loop armed — rehearsing every ${BOOTH_DWELL_SECONDS}s`);
    setLoop(true);
  }
  if (!hasKey()) {
    const key = PROVIDER === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
    console.warn(`[swarm] ${key} is missing or unusable — live runs will fail. Rehearse still works.`);
  }
});

// A run leaves a server (and maybe a tunnel) alive on purpose. Clean them up
// when the orchestrator itself goes down, or the port stays taken.
const shutdown = async () => {
  await stopDeployments();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { startRun };
