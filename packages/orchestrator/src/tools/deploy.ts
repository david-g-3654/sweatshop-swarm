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

export async function prewarmTunnel(port: number): Promise<string | null> {
  if (DEPLOY_TARGET !== 'tunnel') return null;
  if (prewarmed?.port === port) return prewarmed.url;
  const tunnel = await startTunnel(port);
  if (!tunnel) return null;
  prewarmed = { proc: tunnel.proc, url: tunnel.url, port };
  return tunnel.url;
}

/** Kill whatever the previous run left running. Called before every run. */
export async function teardown(): Promise<void> {
  if (prewarmed && prewarmed.proc !== current?.tunnel) prewarmed.proc.kill('SIGTERM');
  prewarmed = null;
  if (!current) return;
  current.tunnel?.kill('SIGTERM');
  current.app.kill('SIGTERM');
  current = null;
  // Give the OS a moment to release the port before the next run grabs it.
  await sleep(300);
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

async function waitForServer(url: string, attempts = 40): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if ((await probe(url, 1000)).ok) return true;
    await sleep(400);
  }
  return false;
}

/** Start a cloudflared quick tunnel and pull the public URL out of its output. */
async function startTunnel(port: number): Promise<{ proc: ChildProcess; url: string } | null> {
  const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const scan = (chunk: Buffer) => {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(chunk.toString());
      if (match) finish(match[0]);
    };
    proc.stdout?.on('data', scan);
    proc.stderr?.on('data', scan);
    proc.on('error', () => finish(null));
    proc.on('exit', () => finish(null));
    setTimeout(() => finish(null), 20_000);
  });

  if (!url) {
    proc.kill('SIGTERM');
    return null;
  }
  return { proc, url };
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

    // Keep a pre-warmed tunnel across the teardown; it is the slow part and it
    // has no dependency on the app process being replaced.
    const port = PORTS.app;
    const reusable = prewarmed?.port === port ? prewarmed : null;
    if (current) {
      current.app.kill('SIGTERM');
      if (current.tunnel && current.tunnel !== reusable?.proc) current.tunnel.kill('SIGTERM');
      current = null;
      await sleep(300);
    }
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
      const tunnel = reusable
        ? { proc: reusable.proc, url: reusable.url }
        : await startTunnel(port);
      if (tunnel) {
        current = { app, tunnel: tunnel.proc, url: tunnel.url, port };
        url = tunnel.url;
        note = reusable
          ? 'Served locally and exposed through the cloudflared tunnel opened earlier in the run.'
          : 'Served locally and exposed publicly through a cloudflared quick tunnel.';
      } else {
        current = { app, url: localUrl, port };
        note =
          'cloudflared was unavailable, so this is the local URL only. Install cloudflared for a public URL.';
      }
    } else if (DEPLOY_TARGET === 'fly') {
      current = { app, url: localUrl, port };
      note = 'The fly backend is not implemented; fell back to the local URL.';
    } else {
      current = { app, url: localUrl, port };
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
