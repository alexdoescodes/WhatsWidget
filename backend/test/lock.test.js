'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { acquireLock } = require('../src/lock');

function tempLock() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lock-')), 'backend.lock');
}

test('a second backend is refused while the first is running', () => {
  const file = tempLock();
  const first = acquireLock({ file, pid: 1111, isRunning: () => true });

  assert.throws(
    () => acquireLock({ file, pid: 2222, isRunning: () => true }),
    (err) => err.code === 'ELOCKED' && /already running \(pid 1111\)/.test(err.message),
  );

  first.release();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('a stale lock from a crashed backend does not block startup', () => {
  const file = tempLock();
  fs.writeFileSync(file, '4242');

  // The holder is gone, so this must not be treated as a live instance.
  const lock = acquireLock({ file, pid: 2222, isRunning: () => false });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '2222');

  lock.release();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('releasing removes the lock', () => {
  const file = tempLock();
  const lock = acquireLock({ file, pid: 1111, isRunning: () => true });
  lock.release();
  assert.strictEqual(fs.existsSync(file), false);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('releasing does not remove a lock another process now holds', () => {
  const file = tempLock();
  const mine = acquireLock({ file, pid: 1111, isRunning: () => true });
  // Someone else took over after we crashed and our lock went stale.
  fs.writeFileSync(file, '9999');

  mine.release();
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '9999',
    'a late release must not unlock the instance that is actually running');

  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('a garbage lock file is treated as stale', () => {
  const file = tempLock();
  fs.writeFileSync(file, 'not-a-pid');
  const lock = acquireLock({ file, pid: 2222, isRunning: () => true });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '2222');
  lock.release();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
