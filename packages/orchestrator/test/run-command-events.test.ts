import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Sandbox, ALL_TOOLS } from '../src/tools/index.js';

/**
 * run_command used to be able to change the workspace without saying so, which
 * meant the event log could disagree with the disk. These pin the fix.
 *
 * The mutations run from a script file rather than `node -e`, because the
 * command gate refuses shell metacharacters and `-e` needs parentheses — which
 * is the same gate doing its job.
 */
async function freshSandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-cmd-'));
  const sandbox = new Sandbox(dir);
  await sandbox.init();
  return { sandbox, ctx: { sandbox, agentId: 'engineer-a' } };
}

const changes = (result: { fileChanges?: { path: string; action: string }[] }) =>
  (result.fileChanges ?? [])
    .filter((c) => c.path !== 'helper.js')
    .map((c) => [c.path, c.action]);

test('a command that creates a file reports it', async () => {
  const { sandbox, ctx } = await freshSandbox();
  await sandbox.writeFile('helper.js', `require('fs').writeFileSync('made.js', 'x=1');`);

  const result = await ALL_TOOLS.run_command!.run({ command: 'node helper.js' }, ctx);
  assert.equal(result.ok, true, result.content);
  assert.deepEqual(changes(result), [['made.js', 'created']]);
});

test('a command that changes a file reports it as modified', async () => {
  const { sandbox, ctx } = await freshSandbox();
  await sandbox.writeFile('edit.js', 'original');
  await sandbox.writeFile('helper.js', `require('fs').writeFileSync('edit.js', 'changed and longer');`);
  await new Promise((r) => setTimeout(r, 5)); // mtime granularity

  const result = await ALL_TOOLS.run_command!.run({ command: 'node helper.js' }, ctx);
  assert.equal(result.ok, true, result.content);
  assert.deepEqual(changes(result), [['edit.js', 'modified']]);
});

test('a command that deletes a file reports the deletion', async () => {
  const { sandbox, ctx } = await freshSandbox();
  await sandbox.writeFile('doomed.js', 'x=1');
  await sandbox.writeFile('helper.js', `require('fs').unlinkSync('doomed.js');`);

  const result = await ALL_TOOLS.run_command!.run({ command: 'node helper.js' }, ctx);
  assert.equal(result.ok, true, result.content);
  assert.deepEqual(
    changes(result),
    [['doomed.js', 'deleted']],
    'a file leaving the workspace has to become an event, or the log lies about it',
  );
});

test('a command that changes nothing reports nothing', async () => {
  const { sandbox, ctx } = await freshSandbox();
  await sandbox.writeFile('quiet.js', 'x=1');
  const result = await ALL_TOOLS.run_command!.run({ command: 'ls' }, ctx);
  assert.equal(result.fileChanges, undefined);
});
