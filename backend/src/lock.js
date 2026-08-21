'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Refuses to start a second backend against the same session directory.
 *
 * This is not tidiness. The WhatsApp session is Signal state: every message
 * advances a ratchet, and two processes advancing the same one desynchronise
 * the keys. The damage does not show up locally -- the sending side looks
 * perfectly healthy -- it shows up on the RECIPIENT's phone as "Waiting for
 * this message", forever, because what arrived cannot be decrypted. Recovering
 * means unlinking the device and pairing again.
 *
 * A stale lock from a crash is not a running instance, so the pid is checked
 * rather than the file merely existing.
 */
function acquireLock({ file, pid = process.pid, isRunning = defaultIsRunning } = {}) {
  if (!file) throw new Error('acquireLock requires a file path');

  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' fails if the file exists: the create and the check are one
      // filesystem operation, so two processes racing cannot both win.
      const handle = fs.openSync(file, 'wx');
      fs.writeFileSync(handle, String(pid));
      fs.closeSync(handle);
      return {
        release() {
          try {
            if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.unlinkSync(file);
          } catch {
            // Already gone, or taken over by someone else. Either way there is
            // nothing of ours left to remove.
          }
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      const holder = readPid(file);
      if (holder && holder !== pid && isRunning(holder)) {
        const error = new Error(
          `another whatsapp-widget backend is already running (pid ${holder}). `
          + 'Two backends would corrupt the WhatsApp session; refusing to start.',
        );
        error.code = 'ELOCKED';
        throw error;
      }

      // Stale: the holder is gone, or it is us from a previous run.
      try {
        fs.unlinkSync(file);
      } catch {
        // Someone else cleaned it up first; the retry will sort it out.
      }
    }
  }

  const error = new Error('could not acquire the backend lock');
  error.code = 'ELOCKED';
  throw error;
}

function readPid(file) {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function defaultIsRunning(pid) {
  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else.
    return err.code === 'EPERM';
  }
}

module.exports = { acquireLock };
