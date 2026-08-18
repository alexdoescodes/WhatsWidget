'use strict';

const os = require('node:os');
const pam = require('authenticate-pam');

/**
 * Verifies the user's real login password through PAM.
 *
 * The dedicated 'whatsapp-widget' PAM service intentionally omits
 * pam_faillock so widget mistakes cannot lock the system account. The
 * brute-force protection that gives up is replaced here by exponential
 * backoff held purely in memory.
 */
function createAuthenticator({
  service,
  username = os.userInfo().username,
  pamAuthenticate = pam.authenticate,
  now = Date.now,
  maxDelayMs = 30000,
} = {}) {
  let failures = 0;
  let blockedUntil = 0;

  function throttleState(at = now()) {
    if (at < blockedUntil) return { allowed: false, retryAfterMs: blockedUntil - at };
    return { allowed: true, retryAfterMs: 0 };
  }

  async function verify(password) {
    const state = throttleState();
    if (!state.allowed) {
      return { ok: false, reason: 'throttled', retryAfterMs: state.retryAfterMs };
    }

    const ok = await new Promise((resolve) => {
      pamAuthenticate(username, password, (err) => resolve(!err), { serviceName: service });
    });

    if (ok) {
      failures = 0;
      blockedUntil = 0;
      return { ok: true };
    }

    failures += 1;
    const retryAfterMs = Math.min(2 ** failures * 1000, maxDelayMs);
    blockedUntil = now() + retryAfterMs;
    return { ok: false, reason: 'invalid', retryAfterMs };
  }

  return { verify, throttleState };
}

module.exports = { createAuthenticator };
