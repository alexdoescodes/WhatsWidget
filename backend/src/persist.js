'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Keeps the chat store on disk across restarts.
 *
 * WhatsApp only hands over history when a device is *linked*. Without a copy
 * on disk, every restart -- a reboot, a logout, a crash, an `npm install` --
 * leaves the widget with an empty chat list and no way to refill it short of
 * unlinking the device and scanning a QR again.
 *
 * The file holds message text, so it is written 0600 and lives beside the
 * session directory, which is a strictly more powerful secret: anyone holding
 * the session can read every message live and send as the user. This cache is
 * a bounded, older subset of what that already grants.
 */
function createPersistence({
  file,
  store,
  intervalMs = 10000,
  logger = console,
  now = Date.now,
} = {}) {
  if (!file) throw new Error('createPersistence requires a file path');

  let timer = null;
  let savedRevision = -1;
  let lastError = 0;

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      // A missing file is the normal first run, not a problem.
      if (err.code !== 'ENOENT') logger.error('could not read the chat cache:', err.message);
      return false;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // A truncated file from a kill mid-write. Starting empty is recoverable;
      // refusing to start is not.
      logger.error('the chat cache is unreadable and will be rebuilt');
      return false;
    }

    const restored = store.restore(data);
    if (restored) savedRevision = store.getRevision();
    return restored;
  }

  function save() {
    const revision = store.getRevision();
    if (revision === savedRevision) return false;

    // Write beside the target and rename: rename is atomic within a
    // filesystem, so a crash mid-write leaves the previous good file rather
    // than a half-written one.
    const temp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(store.snapshot()), { mode: 0o600 });
      // writeFileSync only applies mode on create; enforce it on reuse.
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, file);
      savedRevision = revision;
      return true;
    } catch (err) {
      // Throttled: a full disk would otherwise log on every tick.
      if (now() - lastError > 60000) {
        lastError = now();
        logger.error('could not write the chat cache:', err.message);
      }
      try { fs.unlinkSync(temp); } catch { /* nothing to clean up */ }
      return false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(save, intervalMs);
    // Never hold the process open just to save.
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { load, save, start, stop };
}

module.exports = { createPersistence };
