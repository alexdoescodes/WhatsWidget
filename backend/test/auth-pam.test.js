'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createAuthenticator } = require('../src/auth-pam');

function harness({ accept }) {
  let clock = 0;
  const calls = [];
  const auth = createAuthenticator({
    service: 'whatsapp-widget',
    username: 'tester',
    now: () => clock,
    pamAuthenticate: (user, password, cb, opts) => {
      calls.push({ user, password, opts });
      cb(accept(password) ? null : new Error('auth failed'));
    },
  });
  return { auth, calls, advance: (ms) => { clock += ms; } };
}

test('accepts the correct password and passes the dedicated service name', async () => {
  const { auth, calls } = harness({ accept: (p) => p === 'right' });
  const result = await auth.verify('right');
  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(calls[0].opts.serviceName, 'whatsapp-widget');
  assert.strictEqual(calls[0].user, 'tester');
});

test('rejects a wrong password and blocks the immediate retry', async () => {
  const { auth } = harness({ accept: (p) => p === 'right' });
  const first = await auth.verify('wrong');
  assert.strictEqual(first.ok, false);
  assert.strictEqual(first.reason, 'invalid');
  assert.strictEqual(first.retryAfterMs, 2000);

  const second = await auth.verify('right');
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'throttled');
});

test('backoff grows exponentially and is capped', async () => {
  const { auth, advance } = harness({ accept: () => false });
  const delays = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await auth.verify('wrong');
    delays.push(r.retryAfterMs);
    advance(r.retryAfterMs);
  }
  assert.deepStrictEqual(delays, [2000, 4000, 8000, 16000, 30000, 30000]);
});

test('a success resets the backoff', async () => {
  const { auth, advance } = harness({ accept: (p) => p === 'right' });
  const failed = await auth.verify('wrong');
  advance(failed.retryAfterMs);
  assert.deepStrictEqual(await auth.verify('right'), { ok: true });

  const again = await auth.verify('wrong');
  assert.strictEqual(again.retryAfterMs, 2000);
});
