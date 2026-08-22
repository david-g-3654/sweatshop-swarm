import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Sandbox, isAllowedCommand } from '../src/tools/sandbox.js';

const sandbox = new Sandbox(path.join(os.tmpdir(), 'swarm-test-sandbox'));

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
  const sibling = new Sandbox('/tmp/swarm');
  assert.throws(() => sibling.resolve('../swarm-evil/x'), /escapes the sandbox/);
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

test('destructive commands are no longer available to agents', () => {
  // Two engineers share one directory. One of them running `rm` on a file the
  // other owns is how a run ended up shipping nothing: the module its own tests
  // imported had been deleted out from under them.
  assert.equal(isAllowedCommand('rm wordcloud.js').ok, false);
  assert.equal(isAllowedCommand('rm -rf .').ok, false);
  assert.equal(isAllowedCommand('mv a.js b.js').ok, false);
  assert.equal(isAllowedCommand('cp a.js b.js').ok, false);
});

test('the commands engineers actually need still work', () => {
  assert.equal(isAllowedCommand('node --test').ok, true);
  assert.equal(isAllowedCommand('ls').ok, true);
  assert.equal(isAllowedCommand('cat server.js').ok, true);
  assert.equal(isAllowedCommand('mkdir public').ok, true);
});
