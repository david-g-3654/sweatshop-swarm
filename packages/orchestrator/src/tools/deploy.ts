import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEPLOY_TARGET, PORTS } from '../config.js';
import type { ToolImpl } from './index.js';

/**
 * Deployment.
 *
 * The demo climax is clicking a URL that actually serves, so this module cares
 * about exactly one thing: never report a URL that has not answered a request.
 *
 * Backends:
 *   local  — start the app, return http://localhost:PORT. Always works.
 *   tunnel — local, plus a cloudflared quick tunnel for a public https URL.
 *            Falls back to local (loudly) if cloudflared is not installed.
 *   fly    — not wired up. Kept as a named plan B; a 1-3 minute deploy does not
 *            fit inside a 3-minute pitch, which is why it is not the default.
 */

interface Deployment {
  app: ChildProcess;
  tunnel?: ChildProcess;
  url: string;
  port: number;
  /** Content hash of the workspace this process is running. */
  fingerprint: string;
}

/**
 * A content hash of everything in the workspace.
 *
 * The sandbox directory is named after the run, so every run looks like new
 * code even when it is byte-identical — which it is, every single cycle, in
 * rehearsal. Hashing the contents instead of trusting the path is what lets a
 * booth loop leave a working app alone.
 */
async function fingerprintWorkspace(sandbox: { listFiles(): Promise<string[]>; readFile(p: string): Promise<string> }) {
  const files = (await sandbox.listFiles()).sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    try {
      hash.update(await sandbox.readFile(file));
    } catch {
      hash.update('<unreadable>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

let current: Deployment | null = null;

/**
 * A tunnel opened before there is anything to serve.
 *
 * Establishing a cloudflared quick tunnel took most of the measured 13s deploy
 * phase, and it does not depend on the app at all — the tunnel will happily
 * point at a port nothing is listening on yet and start working the moment
 * something does. So it is opened early, while the agents are still arguing,
 * and by the time the Deployer runs the only remaining work is spawning the
 * app and checking it answers.
 *
 * This pre-warms the transport, never the application. There is no chance of
 * serving stale code, because no code is running yet.
 */
let prewarmed: { proc: ChildProcess; url: string; port: number } | null = null;

/**
 * Is this tunnel hostname still real?
 *
 * A quick tunnel can disappear without the local cloudflared process noticing
 * in any way we can see — the machine sleeps, the network blips, the edge drops
 * it. The hostname then stops resolving while our cached copy of it looks
 * perfectly fine. Any HTTP answer counts as alive, including a 502 from the
 * edge when the origin is not up yet, because that still proves the hostname
 * routes somewhere.
 */
async function tunnelAlive(url: string): Promise<boolean> {
  return (await probe(url, 8000)).ok;
}

export async function prewarmTunnel(port: number): Promise<string | null> {
  if (DEPLOY_TARGET !== 'tunnel') return null;

  if (prewarmed?.port === port) {
    if (await tunnelAlive(prewarmed.url)) return prewarmed.url;
    // Cached but dead. This is how a booth ends up showing a QR code and a
    // link that both go nowhere while the app itself is running fine.
    console.warn('[swarm] the existing tunnel stopped resolving — opening a new one');
    prewarmed.proc.kill('SIGTERM');
    prewarmed = null;
  }

  const tunnel = await startTunnel(port);
  if (!tunnel) return null;
  prewarmed = { proc: tunnel.proc, url: tunnel.url, port };
  // If cloudflared dies, forget its hostname rather than handing it out again.
  tunnel.proc.on('exit', () => {
    if (prewarmed?.proc === tunnel.proc) prewarmed = null;
  });
  return tunnel.url;
}

/**
 * Stop the app from the previous run, and keep the tunnel.
 *
 * The tunnel deliberately outlives runs. A cloudflared quick tunnel gets a new
 * random hostname every time it is opened, so recycling it between runs would
 * invalidate any QR code on a booth table — which is the whole point of having
 * one. The port never changes, so there is never a reason to recycle it.
 *
 * It also means the second run onward pays nothing for the tunnel at all.
 */
export async function teardown(): Promise<void> {
  if (!current) return;
  current.app.kill('SIGTERM');
  current = null;
  // Give the OS a moment to release the port before the next run grabs it.
  await sleep(300);
}

/** Stop everything, tunnel included. For process exit only. */
export async function shutdown(): Promise<void> {
  await teardown();
  prewarmed?.proc.kill('SIGTERM');
  prewarmed = null;
}

export function currentUrl(): string | null {
  return current?.url ?? null;
}

async function probe(url: string, timeoutMs = 2000): Promise<{ ok: boolean; status?: number; body?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    const body = (await res.text()).slice(0, 600);
    // Any HTTP answer means something is listening and speaking HTTP. A 404 from
    // a live server is a successful probe; only a dead socket is a failure.
    return { ok: true, status: res.status, body };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll a URL until something answers.
 *
 * The per-attempt timeout matters more than it looks. A local process either
 * answers in milliseconds or is not listening, so one second is plenty. A
 * tunnel hostname has to resolve through DNS that may not have propagated and
 * then reach a Cloudflare edge — one second times out every single attempt, and
 * the caller concludes the tunnel is dead when it is merely cold. That is
 * exactly what made working tunnels look broken.
 */
async function waitForServer(
  url: string,
  attempts = 40,
  { timeoutMs = 1000, gapMs = 400 }: { timeoutMs?: number; gapMs?: number } = {},
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if ((await probe(url, timeoutMs)).ok) return true;
    await sleep(gapMs);
  }
  return false;
}

/**
 * Does this URL actually reach the application, rather than a Cloudflare error?
 *
 * Deliberately stricter than `waitForServer`, which accepts any HTTP answer —
 * that is the right test for "does this hostname route", and the wrong one for
 * "is this a link I can put on a projector".
 */
async function reachesApp(url: string, attempts = 10): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const result = await probe(url, 6000);
    if (result.ok && (result.status ?? 500) < 500) return true;
    await sleep(1500);
  }
  return false;
}

/** Remote URLs need patience: DNS propagation plus a cold edge. */
const TUNNEL_WAIT = { timeoutMs: 6000, gapMs: 1500 } as const;

/**
 * Start a cloudflared quick tunnel and return a hostname that actually routes.
 *
 * cloudflared prints the hostname before the tunnel is usable — the URL appears
 * in its output, and only a second or so later does it log "Registered tunnel
 * connection", after which DNS still has to catch up. Taking the URL at face
 * value the moment it is printed is how you end up publishing a QR code and an
 * iframe that both point at a hostname which does not yet resolve.
 *
 * So: read the hostname, then poll it until something answers. A 502 from the
 * Cloudflare edge counts — it means the hostname routes and the origin simply
 * is not up yet, which at pre-warm time is exactly the expected state.
 */
async function startTunnel(port: number): Promise<{ proc: ChildProcess; url: string } | null> {
  const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Keep the tail of its output so a failure can be explained rather than guessed at.
  const log: string[] = [];

  /**
   * Wait for cloudflared to say the tunnel is connected, not merely named.
   *
   * This must happen before the first HTTP probe. Probing a hostname that does
   * not resolve yet gets ENOTFOUND, and Node's fetch caches that negative
   * lookup for the life of the process — so one early probe poisons every
   * later one and a perfectly healthy tunnel looks permanently dead. That is
   * what made every in-run tunnel fail while the same tunnel probed by hand a
   * few seconds later worked fine.
   *
   * cloudflared logs "Registered tunnel connection" about a second after it
   * prints the hostname. Waiting for that, plus a moment for DNS, means the
   * first probe has something to find.
   */
  const ready = await new Promise<{ url: string } | null>((resolve) => {
    let settled = false;
    let url: string | null = null;
    let registered = false;

    const finish = (value: { url: string } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const scan = (chunk: Buffer) => {
      const text = chunk.toString();
      log.push(text);
      if (log.length > 40) log.shift();

      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
      if (match && !url) url = match[0];
      if (/Registered tunnel connection/i.test(text)) registered = true;
      if (url && registered) finish({ url });
    };

    proc.stdout?.on('data', scan);
    proc.stderr?.on('data', scan);
    proc.on('error', () => finish(null));
    proc.on('exit', () => finish(null));
    setTimeout(() => finish(url && registered ? { url } : null), 45_000);
  });

  if (!ready) {
    proc.kill('SIGTERM');
    const output = log.join('');
    if (/error code: 1015|429/.test(output)) {
      // Worth naming, because it looks exactly like a broken program and is not.
      console.warn(
        '[swarm] Cloudflare is rate-limiting quick tunnels from this IP (error 1015).\n' +
          '        Nothing is wrong with the app — it will keep serving on localhost.\n' +
          '        Quick tunnels are per-IP limited; wait a while, use a phone hotspot,\n' +
          '        or run with SWARM_DEPLOY_TARGET=local and show it on this machine.',
      );
    } else {
      console.warn(`[swarm] cloudflared never established a tunnel:\n${log.slice(-8).join('')}`);
    }
    return null;
  }

  // Give DNS a moment before the first lookup, for the reason above.
  await sleep(3000);

  if (!(await waitForServer(ready.url, 20, TUNNEL_WAIT))) {
    console.warn(
      `[swarm] ${ready.url} registered but never answered — giving up on the tunnel.\n` +
        `        cloudflared said:\n${log.slice(-6).join('')}`,
    );
    proc.kill('SIGTERM');
    return null;
  }

  return { proc, url: ready.url };
}

export const deployTool: ToolImpl = {
  definition: {
    name: 'deploy',
    description:
      'Start the application and return the URL it is served on. Give it the path to the server entrypoint, e.g. "server.js". The app must read its port from process.env.PORT.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'Workspace-relative path to the server entrypoint.' },
      },
      required: ['entry'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const entry = String(input.entry);
    ctx.sandbox.resolve(entry); // throws if the entrypoint escapes the workspace

    /*
     * If the running app is the same code and still healthy, leave it alone.
     *
     * The booth loop rehearses the same build every couple of minutes. Killing
     * and respawning the app each cycle wipes whatever is in its memory — which
     * for a word cloud means the words the room typed disappear, seconds after
     * someone was told "Added". Restarting a process to arrive at a byte-for-byte
     * identical process is not worth that.
     */
    const fingerprint = await fingerprintWorkspace(ctx.sandbox);
    if (current && current.fingerprint === fingerprint && current.port === PORTS.app) {
      const alive = await probe(`http://localhost:${PORTS.app}`, 2500);
      if (alive.ok) {
        return {
          ok: true,
          content: `Already deployed and healthy on identical code — left running so its state survives.\nURL: ${current.url}`,
          deploy: { ok: true, url: current.url, target: DEPLOY_TARGET },
        };
      }
    }

    // The tunnel survives; only the app process is replaced. Joining the
    // pre-warm rather than inspecting `prewarmed` is what stops deploy racing
    // it and opening a rival tunnel.
    const port = PORTS.app;
    await teardown();
    const tunnelUrl = DEPLOY_TARGET === 'tunnel' ? await prewarmTunnel(port) : null;
    const app = spawn('node', [entry], {
      cwd: ctx.sandbox.root,
      env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let startupLog = '';
    app.stdout?.on('data', (d) => (startupLog += d.toString()));
    app.stderr?.on('data', (d) => (startupLog += d.toString()));

    const localUrl = `http://localhost:${port}`;
    const alive = await waitForServer(localUrl);

    if (!alive) {
      app.kill('SIGKILL');
      return {
        ok: false,
        content: `The app never started listening on port ${port}. Output was:\n${startupLog.slice(0, 2000) || '(nothing)'}`,
        deploy: { ok: false, error: 'server did not start', target: DEPLOY_TARGET },
      };
    }

    let url = localUrl;
    let note = 'Served locally.';

    if (DEPLOY_TARGET === 'tunnel') {
      if (tunnelUrl && prewarmed) {
        current = { app, tunnel: prewarmed.proc, url: tunnelUrl, port, fingerprint };
        url = tunnelUrl;
        note = 'Served locally and exposed publicly through a cloudflared quick tunnel.';
      } else {
        current = { app, url: localUrl, port, fingerprint };
        note =
          'No working tunnel, so this is the local URL only. Nobody outside this machine can open it.';
      }
    } else if (DEPLOY_TARGET === 'fly') {
      current = { app, url: localUrl, port, fingerprint };
      note = 'The fly backend is not implemented; fell back to the local URL.';
    } else {
      current = { app, url: localUrl, port, fingerprint };
    }

    /*
     * Check the URL we are about to report — not the one we happen to know is
     * up.
     *
     * The whole point of this module is never reporting a URL that has not
     * answered a request, and until now it checked localhost and then handed
     * back a tunnel hostname it had never probed. A dead tunnel therefore
     * produced a perfectly confident deploy, a QR code pointing at nothing, and
     * an empty iframe, while the app itself ran fine on the machine.
     *
     * Give the tunnel a few seconds to route to a just-started origin before
     * giving up on it.
     */
    /*
     * Cloudflare answering is not the app answering.
     *
     * A tunnel whose connector is gone still returns a page — 530, 502, 1033 —
     * so "did anything reply?" is too weak a test for the URL we are about to
     * publish. Anything 5xx from the edge means the request never reached the
     * app, which is indistinguishable from a dead link for the person scanning
     * the QR code.
     */
    if (url !== localUrl && !(await reachesApp(url))) {
      console.warn(`[swarm] ${url} did not answer — falling back to the local URL`);
      current = { app, url: localUrl, port, fingerprint };
      url = localUrl;
      note =
        'The tunnel did not answer, so this is the local URL only. Nobody outside this machine can open it.';
    }

    return {
      ok: true,
      content: `Deployed. ${note}\nURL: ${url}`,
      deploy: { ok: true, url, target: DEPLOY_TARGET },
    };
  },
};

export const httpCheckTool: ToolImpl = {
  definition: {
    name: 'http_check',
    description:
      'Make a GET request to a URL and return the status code and the start of the body. Use this to prove a deployment is actually serving.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        path: { type: 'string', description: 'Optional path to append, e.g. "/health".' },
      },
      required: ['url', 'path'],
      additionalProperties: false,
    },
  },
  async run(input) {
    const base = String(input.url).replace(/\/$/, '');
    const suffix = String(input.path ?? '');
    const target = suffix && suffix !== '/' ? `${base}${suffix.startsWith('/') ? '' : '/'}${suffix}` : base;

    const result = await probe(target, 6000);
    if (!result.ok) {
      return { ok: false, content: `No response from ${target}. Nothing is listening, or it timed out.` };
    }
    return {
      ok: true,
      content: `GET ${target}\nstatus: ${result.status}\nbody:\n${result.body}`,
    };
  },
};
