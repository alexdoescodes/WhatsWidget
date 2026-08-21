'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

/**
 * Downloads and caches WhatsApp profile pictures.
 *
 * Cached as files rather than served over the HTTP API on purpose. Every API
 * route requires an Authorization header, and QML's Image element cannot set
 * one -- the same limitation that forced the WebSocket's query-param token.
 * Rather than widen that concession to a second route, the pictures are
 * written to disk and the widget loads them with a file:// URL, where the
 * filesystem permissions are the guard.
 *
 * The directory is 0700 and the files 0600. A profile picture is not a secret
 * on the scale of the session, but it is still personal data about the user's
 * contacts and has no business being world-readable.
 */
function createAvatarCache({
  dir,
  fetchUrl,
  download = httpsDownload,
  logger = console,
  maxBytes = 512 * 1024,
} = {}) {
  if (!dir) throw new Error('createAvatarCache requires a directory');
  if (typeof fetchUrl !== 'function') throw new Error('createAvatarCache requires fetchUrl');

  // Jids contain characters that have meaning in a path (and '@'), so the
  // filename is a digest rather than the jid itself.
  function fileFor(jid) {
    const digest = crypto.createHash('sha256').update(jid).digest('hex').slice(0, 32);
    return path.join(dir, `${digest}.jpg`);
  }

  function cached(jid) {
    const file = fileFor(jid);
    return fs.existsSync(file) ? file : '';
  }

  /**
   * Ensure a picture is on disk, returning its path or '' if there is none.
   *
   * A contact with no picture, or one whose privacy settings hide it, is a
   * normal outcome and not an error -- it just means the letter avatar stays.
   */
  async function ensure(jid) {
    const existing = cached(jid);
    if (existing) return existing;

    let url;
    try {
      url = await fetchUrl(jid, 'preview');
    } catch {
      // No picture, hidden by privacy settings, or a request that timed out.
      return '';
    }
    if (!url) return '';

    try {
      const body = await download(url, maxBytes);
      if (!body || body.length === 0) return '';
      const file = fileFor(jid);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, body, { mode: 0o600 });
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, file);
      return file;
    } catch (err) {
      logger.error('could not cache a profile picture:', err.message);
      return '';
    }
  }

  return { ensure, cached, fileFor };
}

function httpsDownload(url, maxBytes) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        // A profile picture preview is a few KB. Anything wildly bigger is not
        // one, and must not be allowed to grow the process without bound.
        if (total > maxBytes) {
          res.destroy();
          reject(new Error('profile picture larger than expected'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
  });
}

module.exports = { createAvatarCache };
