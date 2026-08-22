import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LIMITS } from '../config.js';

/**
 * Filesystem + process containment for agent tools.
 *
 * Agents get a directory and nothing above it. This is not a security boundary
 * against a hostile model — it's a blast radius limit so a confused agent
 * rewrites its own sandbox instead of my laptop the night before the demo.
 */
export class Sandbox {
  constructor(public readonly root: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  /** Resolve a relative path, refusing anything that escapes the root. */
  resolve(rel: string): string {
    if (path.isAbsolute(rel)) {
      throw new Error(`absolute paths are not allowed: ${rel}`);
    }
    const abs = path.resolve(this.root, rel);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (abs !== this.root && !abs.startsWith(rootWithSep)) {
      throw new Error(`path escapes the sandbox: ${rel}`);
    }
    return abs;
  }

  async readFile(rel: string): Promise<string> {
    const abs = this.resolve(rel);
    const stat = await fs.stat(abs);
    if (stat.size > LIMITS.maxFileBytes) {
      throw new Error(`file too large to read (${stat.size} bytes): ${rel}`);
    }
    return fs.readFile(abs, 'utf8');
  }

  async writeFile(rel: string, contents: string): Promise<{ bytes: number; existed: boolean }> {
    const abs = this.resolve(rel);
    let existed = true;
    try {
      await fs.access(abs);
    } catch {
      existed = false;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents, 'utf8');
    return { bytes: Buffer.byteLength(contents, 'utf8'), existed };
  }

  /** Recursive listing, relative paths, node_modules and dotfiles pruned. */
  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else {
          out.push(path.relative(this.root, abs));
        }
      }
    };
    await walk(this.root);
    return out.sort();
  }
}

/**
 * A cheap fingerprint of every file in the workspace.
 *
 * Size and mtime rather than a hash: the workspace is a handful of small files,
 * this runs either side of every command, and a write that leaves both
 * identical is not a write anyone needs to hear about.
 */
export async function snapshotWorkspace(sandbox: Sandbox): Promise<Map<string, string>> {
  const files = await sandbox.listFiles();
  const out = new Map<string, string>();
  await Promise.all(
    files.map(async (file) => {
      try {
        const stat = await fs.stat(sandbox.resolve(file));
        out.set(file, `${stat.size}:${stat.mtimeMs}`);
      } catch {
        // Vanished between listing and stat; the diff will treat it as absent.
      }
    }),
  );
  return out;
}

export interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Commands agents may run. Anything else is refused with a message telling the
 * agent what it *can* do, which turns a dead end into a recoverable turn.
 *
 * rm, mv and cp are deliberately absent. Two engineers work the same directory
 * at the same time, and one of them reaching for `rm` to tidy up a file it
 * thinks is wrong destroys work the other owns — which is exactly what happened:
 * `rm wordcloud.js` three times, and a run that could not ship because the
 * module its own tests imported was gone.
 *
 * Engineers write files. Removing one is not something a teammate gets to do
 * unilaterally, and write_file already covers replacing content.
 */
export const ALLOWED_BINARIES = new Set(['node', 'npm', 'npx', 'ls', 'cat', 'mkdir', 'echo', 'test']);

export function isAllowedCommand(command: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: 'empty command' };

  // Shell metacharacters that chain or redirect are refused: one command, one
  // intent, so the transcript stays readable and the allowlist stays meaningful.
  if (/[;&|><`$(){}]/.test(trimmed)) {
    return { ok: false, reason: 'shell operators (; & | > < ` $ ( )) are not allowed; run one plain command' };
  }
  const binary = trimmed.split(/\s+/)[0] ?? '';
  if (!ALLOWED_BINARIES.has(binary)) {
    return {
      ok: false,
      reason: `"${binary}" is not on the allowlist. Allowed: ${[...ALLOWED_BINARIES].join(', ')}`,
    };
  }
  return { ok: true };
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs = LIMITS.commandTimeoutMs,
): Promise<CommandResult> {
  const started = Date.now();
  const [binary, ...args] = command.trim().split(/\s+/);

  return new Promise((resolve) => {
    const child = spawn(binary!, args, {
      cwd,
      shell: false,
      env: { ...process.env, CI: '1', npm_config_fund: 'false', npm_config_audit: 'false' },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > LIMITS.maxToolResultChars * 4) child.kill('SIGKILL');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        timedOut,
        durationMs: Date.now() - started,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}
