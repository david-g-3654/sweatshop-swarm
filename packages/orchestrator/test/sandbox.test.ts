import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Sandbox, isAllowedCommand } from '../src/tools/sandbox.js';

const sandbox = new Sandbox(path.join(os.tmpdir(), 'arena-test-sandbox'));

test('resolves paths inside the sandbox', () => {
  assert.equal(sandbox.resolve('src/app.js'), path.join(sandbox.root, 'src/app.js'));
});

test('refuses traversal out of the sandbox', () => {
  assert.throws(() => sandbox.resolve('../../etc/passwd'), /escapes the sandbox/);
  assert.throws(() => sandbox.resolve('a/../../b'), /escapes the sandbox/);
});

test('refuses absolute paths', () => {
  assert.throws(() => sandbox.resolve('/etc/passwd'), /absolute paths/);
});

test('does not treat a sibling directory as inside the root', () => {
  const sibling = new Sandbox('/tmp/arena');
  assert.throws(() => sibling.resolve('../arena-evil/x'), /escapes the sandbox/);
});

test('allows plain allowlisted commands', () => {
  assert.equal(isAllowedCommand('node --test').ok, true);
  assert.equal(isAllowedCommand('npm install express').ok, true);
});

test('refuses chaining, redirects and unknown binaries', () => {
  assert.equal(isAllowedCommand('node x.js && rm -rf /').ok, false);
  assert.equal(isAllowedCommand('cat /etc/passwd > out').ok, false);
  assert.equal(isAllowedCommand('curl example.com').ok, false);
  assert.equal(isAllowedCommand('rm -rf .').ok, false);
});
