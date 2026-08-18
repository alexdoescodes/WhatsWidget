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

test('concurrent calls are throttled', async () => {
  let clock = 0;
  const calls = [];
  let deferredCb;

  const auth = createAuthenticator({
    service: 'whatsapp-widget',
    username: 'tester',
    now: () => clock,
    pamAuthenticate: (user, password, cb, opts) => {
      calls.push({ user, password, opts });
      // Defer the callback so we can fire multiple verify() calls before PAM resolves
      deferredCb = cb;
    },
  });

  // Fire two verify calls before either PAM callback resolves
  const p1 = auth.verify('wrong');
  const p2 = auth.verify('wrong');

  // At this point, both calls have been issued, but no PAM callback has fired yet
  // The race condition would be: both calls pass throttleState and hit PAM.
  // The fix reserves the slot synchronously, so only the first should hit PAM.
  assert.strictEqual(calls.length, 1, 'exactly one PAM call should be made');

  // Now resolve the first PAM call
  deferredCb(new Error('auth failed'));

  // Both verify promises should now resolve
  const r1 = await p1;
  const r2 = await p2;

  // First should be invalid (hit PAM), second should be throttled
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.reason, 'invalid');

  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'throttled');
});

test('createAuthenticator requires an explicit service name', async () => {
  assert.throws(
    () => createAuthenticator({ service: '' }),
    /requires an explicit PAM service name/
  );

  assert.throws(
    () => createAuthenticator({}),
    /requires an explicit PAM service name/
  );
});
