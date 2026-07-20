// Contract test for the shell-guard port (T-023): the single catastrophic-command guard
// that replaces the three verbatim copies in hub-bridge.mjs, pty.mjs and ssh.mjs.
// Tests the REAL isDestructive() against the fixture corpus — a pure guard needs no fake
// (the Opus review flagged the draft's fake as a weaker oracle than the guard, so it is
// dropped rather than shipped as a false safety net; comparing real-vs-fake would go green
// even on a shared MISS). The superset invariant is proven directly: block every legacy +
// hardening pattern, pass every safe command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDestructive } from '../bridge/platform/shell-guard.mjs';
import { ALL_POSITIVE, POSITIVE_LEGACY, POSITIVE_HARDENING, NEGATIVE } from './shell-guard-fixtures.mjs';

// fixtures are { desc, line } objects
const line = (f) => (typeof f === 'string' ? f : f.line);

test('blocks every LEGACY catastrophic pattern (superset of the 3 originals)', () => {
  for (const f of POSITIVE_LEGACY) assert.equal(isDestructive(line(f)), true, `must block: ${line(f)}`);
});

test('blocks every HARDENING pattern (new coverage the originals missed)', () => {
  for (const f of POSITIVE_HARDENING) assert.equal(isDestructive(line(f)), true, `must block: ${line(f)}`);
});

test('passes every safe command (no false positives on the negative corpus)', () => {
  for (const f of NEGATIVE) assert.equal(isDestructive(line(f)), false, `must allow: ${line(f)}`);
});

test('is a pure, no-throw function — non-string input is coerced, never throws', () => {
  assert.equal(isDestructive(null), false);
  assert.equal(isDestructive(undefined), false);
  assert.equal(isDestructive(12345), false);
  assert.doesNotThrow(() => isDestructive({}));
});

test('the classic catastrophic commands are all caught', () => {
  for (const cmd of ['rm -rf /', 'rm -rf /*', 'mkfs.ext4 /dev/sda', 'dd if=/dev/zero of=/dev/sda', ':(){ :|:& };:'])
    assert.equal(isDestructive(cmd), true, cmd);
});

test('ALL_POSITIVE corpus is non-trivial and fully blocked', () => {
  assert.ok(ALL_POSITIVE.length >= 10);
  assert.ok(ALL_POSITIVE.every((f) => isDestructive(line(f))));
});
