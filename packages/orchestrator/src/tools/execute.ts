import type { EventBus } from '../bus.js';
import { ALL_TOOLS, type Sandbox, type ToolExecution } from './index.js';

/**
 * Run one tool and broadcast what happened.
 *
 * Shared by the live agent loop and rehearsal mode so both produce an
 * identical event stream. If rehearsal emitted its own slightly different
 * events, the UI would be exercised against a shape that never occurs in a
 * real run — and the bug would surface on stage.
 */
export async function executeToolWithEvents(
  bus: EventBus,
  agentId: string,
  sandbox: Sandbox,
  tool: string,
  input: Record<string, unknown>,
  callId: string,
): Promise<ToolExecution> {
  const started = Date.now();
  bus.emit({ type: 'tool.call', agentId, callId, tool, input });

  const impl = ALL_TOOLS[tool];
  let execution: ToolExecution;
  if (!impl) {
    execution = { ok: false, content: `No such tool: ${tool}` };
  } else {
    try {
      execution = await impl.run(input, { sandbox, agentId });
    } catch (err) {
      execution = { ok: false, content: `Tool failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  for (const change of execution.fileChanges ?? []) {
    bus.emit({
      type: 'file.changed',
      path: change.path,
      action: change.action,
      bytes: change.bytes,
      by: agentId,
    });
  }

  if (execution.tests) {
    bus.emit({
      type: 'tests.ran',
      agentId,
      passed: execution.tests.passed,
      failed: execution.tests.failed,
      ok: execution.tests.ok,
      output: execution.tests.output,
    });
  }

  bus.emit({
    type: 'tool.result',
    agentId,
    callId,
    tool,
    ok: execution.ok,
    preview: execution.content.slice(0, 400),
    durationMs: Date.now() - started,
  });

  return execution;
}
