import type Anthropic from '@anthropic-ai/sdk';
import { LIMITS } from '../config.js';
import { Sandbox, isAllowedCommand, runCommand } from './sandbox.js';

/**
 * The tool layer.
 *
 * Tools never emit events themselves. They return a structured result and let
 * the agent loop decide what to broadcast. That keeps the dependency arrow
 * pointing one way (loop -> tools) and means a tool can be unit-tested without
 * standing up a WebSocket server.
 */

export interface FileChange {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  bytes: number;
}

export interface TestOutcome {
  passed: number;
  failed: number;
  ok: boolean;
  output: string;
}

export interface ToolExecution {
  ok: boolean;
  /** What gets sent back to the model as the tool_result. */
  content: string;
  fileChanges?: FileChange[];
  tests?: TestOutcome;
  deploy?: { ok: boolean; url?: string; error?: string; target: string };
}

export interface ToolContext {
  sandbox: Sandbox;
  agentId: string;
}

export interface ToolImpl {
  definition: Anthropic.Tool;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution>;
}

function truncate(text: string, max: number = LIMITS.maxToolResultChars): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… [truncated ${text.length - max} chars]`;
}

const writeFile: ToolImpl = {
  definition: {
    name: 'write_file',
    description:
      'Create or overwrite a file in your workspace. Always write the complete file contents — there is no partial edit.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path, e.g. "src/server.js".' },
        contents: { type: 'string', description: 'The complete contents of the file.' },
      },
      required: ['path', 'contents'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const rel = String(input.path);
    const contents = String(input.contents ?? '');
    const { bytes, existed } = await ctx.sandbox.writeFile(rel, contents);
    return {
      ok: true,
      content: `Wrote ${bytes} bytes to ${rel}.`,
      fileChanges: [{ path: rel, action: existed ? 'modified' : 'created', bytes }],
    };
  },
};

const readFile: ToolImpl = {
  definition: {
    name: 'read_file',
    description: 'Read a file from your workspace.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const rel = String(input.path);
    const contents = await ctx.sandbox.readFile(rel);
    return { ok: true, content: truncate(contents) };
  },
};

const listFiles: ToolImpl = {
  definition: {
    name: 'list_files',
    description: 'List every file currently in the workspace.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  async run(_input, ctx) {
    const files = await ctx.sandbox.listFiles();
    return {
      ok: true,
      content: files.length ? files.join('\n') : '(workspace is empty)',
    };
  },
};

const runCommandTool: ToolImpl = {
  definition: {
    name: 'run_command',
    description:
      'Run a single shell command in your workspace. No pipes, redirects or chaining. Allowed binaries: node, npm, npx, ls, cat, mkdir, rm, cp, mv, echo, test.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const command = String(input.command);
    const gate = isAllowedCommand(command);
    if (!gate.ok) {
      // Refusals are phrased as recoverable instructions, not dead ends —
      // the agent gets to try again rather than burning a turn on confusion.
      return { ok: false, content: `Command refused: ${gate.reason}` };
    }
    const result = await runCommand(command, ctx.sandbox.root);
    const body = [
      `exit=${result.timedOut ? 'TIMEOUT' : result.code}`,
      result.stdout.trim() && `stdout:\n${result.stdout.trim()}`,
      result.stderr.trim() && `stderr:\n${result.stderr.trim()}`,
    ]
      .filter(Boolean)
      .join('\n');
    return { ok: result.ok, content: truncate(body || '(no output)') };
  },
};

/** node --test prints a TAP summary; these are the lines we care about. */
function parseTestOutput(output: string): { passed: number; failed: number } {
  const pass = /^#\s*pass\s+(\d+)/m.exec(output);
  const fail = /^#\s*fail\s+(\d+)/m.exec(output);
  return { passed: Number(pass?.[1] ?? 0), failed: Number(fail?.[1] ?? 0) };
}

const runTests: ToolImpl = {
  definition: {
    name: 'run_tests',
    description: 'Run the workspace test suite (node --test) and return the results.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  async run(_input, ctx) {
    const result = await runCommand('node --test', ctx.sandbox.root, LIMITS.commandTimeoutMs);
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const { passed, failed } = parseTestOutput(combined);

    // node --test exits non-zero when there are no test files at all. That is a
    // real failure for us: "no tests" must never read as "tests passed".
    const noTests = /^#\s*tests\s+0/m.test(combined) || combined.includes('no test files found');
    const ok = result.ok && !noTests && failed === 0;

    const tests: TestOutcome = {
      passed,
      failed: noTests ? 1 : failed,
      ok,
      output: truncate(combined, 4000),
    };
    const headline = noTests
      ? 'No test files were found. The suite must actually exist and run.'
      : `${passed} passed, ${failed} failed.`;
    return { ok, content: `${headline}\n\n${truncate(combined, 6000)}`, tests };
  },
};

export const ALL_TOOLS: Record<string, ToolImpl> = {
  write_file: writeFile,
  read_file: readFile,
  list_files: listFiles,
  run_command: runCommandTool,
  run_tests: runTests,
};

/** Build the tool array for one role from its whitelist. */
export function toolsFor(names: readonly string[]): Anthropic.Tool[] {
  return names.map((name) => {
    const impl = ALL_TOOLS[name];
    if (!impl) throw new Error(`unknown tool in whitelist: ${name}`);
    return impl.definition;
  });
}

export { Sandbox };
