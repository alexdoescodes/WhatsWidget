'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * WhatsApp media: describing it, and fetching it on demand.
 *
 * Media is not carried inside a message. A message carries a URL, a directPath
 * and a decryption key; the bytes live on WhatsApp's CDN, encrypted, and have
 * to be downloaded and decrypted separately. That is why an image used to come
 * through as "[unsupported message]" -- nothing here ever asked for it.
 *
 * The key material is kept with the message so media stays fetchable after a
 * restart. Uint8Arrays do not survive JSON, so they are held base64 and
 * rehydrated on use.
 */

// Which proto field carries which kind, in the order they are checked.
const KINDS = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['stickerMessage', 'sticker'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
];

function unwrap(message) {
  // Disappearing messages and view-once wrap the real payload a level down.
  if (!message) return null;
  if (message.ephemeralMessage?.message) return unwrap(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrap(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrap(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage?.message) {
    return unwrap(message.documentWithCaptionMessage.message);
  }
  return message;
}

function toBase64(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return Buffer.from(value).toString('base64');
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value && typeof value.toNumber === 'function') return value.toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A JSON-safe description of a message's media, or null if it has none.
 *
 * Everything needed to fetch the bytes later is included, so a message that
 * came out of the cache after a restart is still downloadable.
 */
function describeMedia(rawMessage) {
  const message = unwrap(rawMessage);
  if (!message) return null;

  for (const [field, kind] of KINDS) {
    const node = message[field];
    if (!node) continue;
    return {
      kind,
      mimetype: node.mimetype || '',
      caption: node.caption || '',
      fileName: node.fileName || '',
      seconds: toNumber(node.seconds),
      fileLength: toNumber(node.fileLength),
      // Download material.
      mediaKey: toBase64(node.mediaKey),
      directPath: node.directPath || '',
      url: node.url || '',
    };
  }
  return null;
}

/** A short human label for a media message, used in the preview line. */
function mediaLabel(media) {
  if (!media) return '';
  switch (media.kind) {
    case 'image': return media.caption || 'Photo';
    case 'video': return media.caption || 'Video';
    case 'sticker': return 'Sticker';
    case 'audio': return 'Voice message';
    case 'document': return media.fileName || 'Document';
    default: return 'Attachment';
  }
}

/**
 * Downloads and caches decrypted media.
 *
 * Files are 0600 in a 0700 directory: this is the user's conversations, and
 * has no business being readable by other accounts on the machine. Cached by
 * message id, so a message is fetched at most once.
 */
function createMediaCache({
  dir,
  download,
  logger = console,
  maxBytes = 25 * 1024 * 1024,
} = {}) {
  if (!dir) throw new Error('createMediaCache requires a directory');
  if (typeof download !== 'function') throw new Error('createMediaCache requires download');

  const extensions = {
    image: '.jpg', video: '.mp4', sticker: '.webp', audio: '.ogg', document: '',
  };

  function fileFor(messageId, media) {
    // The id comes off the wire, so it is hashed rather than trusted as a
    // filename -- a '../' in it must not be able to escape the directory.
    const digest = crypto.createHash('sha256').update(String(messageId)).digest('hex').slice(0, 32);
    return path.join(dir, digest + (extensions[media.kind] || '.bin'));
  }

  function cached(messageId, media) {
    const file = fileFor(messageId, media);
    return fs.existsSync(file) ? file : '';
  }

  async function ensure(messageId, media) {
    if (!media) return '';
    const existing = cached(messageId, media);
    if (existing) return existing;

    if (media.fileLength > maxBytes) {
      logger.error('refusing to download media larger than the cap:', media.fileLength);
      return '';
    }
    if (!media.mediaKey || (!media.url && !media.directPath)) return '';

    const file = fileFor(messageId, media);
    const temp = `${file}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const body = await download({
        mediaKey: Buffer.from(media.mediaKey, 'base64'),
        directPath: media.directPath,
        url: media.url,
      }, media.kind, maxBytes);
      if (!body || body.length === 0) return '';

      fs.writeFileSync(temp, body, { mode: 0o600 });
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, file);
      return file;
    } catch (err) {
      logger.error('could not download media:', err.message);
      try { fs.unlinkSync(temp); } catch { /* nothing to clean up */ }
      return '';
    }
  }

  return { ensure, cached, fileFor };
}

module.exports = { describeMedia, mediaLabel, createMediaCache, unwrap };
