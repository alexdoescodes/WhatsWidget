'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { describeMedia, mediaLabel, createMediaCache } = require('../src/media');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-'));
}

const KEY = Buffer.from('secret-key');

test('a descriptor carries everything needed to fetch the bytes later', () => {
  const media = describeMedia({
    imageMessage: {
      mimetype: 'image/jpeg', caption: 'at the lake', fileLength: 4096,
      mediaKey: KEY, directPath: '/v/t62', url: 'https://mmg.whatsapp.net/x',
    },
  });

  assert.strictEqual(media.kind, 'image');
  assert.strictEqual(media.caption, 'at the lake');
  assert.strictEqual(media.fileLength, 4096);
  assert.strictEqual(media.directPath, '/v/t62');
  // Base64, not a Uint8Array: the descriptor has to survive JSON so media
  // stays downloadable after a restart.
  assert.strictEqual(typeof media.mediaKey, 'string');
  assert.strictEqual(Buffer.from(media.mediaKey, 'base64').toString(), 'secret-key');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(media)), media);
});

test('view-once and disappearing wrappers are unwrapped', () => {
  assert.strictEqual(describeMedia({ viewOnceMessageV2: { message: { imageMessage: { mediaKey: KEY } } } }).kind, 'image');
  assert.strictEqual(describeMedia({ ephemeralMessage: { message: { videoMessage: { mediaKey: KEY } } } }).kind, 'video');
});

test('a text message has no media', () => {
  assert.strictEqual(describeMedia({ conversation: 'hi' }), null);
  assert.strictEqual(describeMedia(null), null);
});

test('labels name the kind, and a caption wins', () => {
  assert.strictEqual(mediaLabel({ kind: 'image', caption: 'hi' }), 'hi');
  assert.strictEqual(mediaLabel({ kind: 'image', caption: '' }), 'Photo');
  assert.strictEqual(mediaLabel({ kind: 'sticker' }), 'Sticker');
  assert.strictEqual(mediaLabel({ kind: 'audio' }), 'Voice message');
  assert.strictEqual(mediaLabel({ kind: 'document', fileName: 'x.pdf' }), 'x.pdf');
});

test('media is downloaded once and reused', async () => {
  const dir = tempDir();
  let downloads = 0;
  const cache = createMediaCache({
    dir,
    download: async () => { downloads++; return Buffer.from('PNGBYTES'); },
  });
  const media = { kind: 'image', mediaKey: KEY.toString('base64'), url: 'https://x', fileLength: 8 };

  const first = await cache.ensure('MSGID', media);
  assert.strictEqual(fs.readFileSync(first, 'utf8'), 'PNGBYTES');
  await cache.ensure('MSGID', media);
  assert.strictEqual(downloads, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('cached media is 0600 in a 0700 directory', async () => {
  const dir = tempDir();
  fs.rmSync(dir, { recursive: true, force: true });
  const cache = createMediaCache({ dir, download: async () => Buffer.from('X') });

  const file = await cache.ensure('MSGID', { kind: 'image', mediaKey: 'a2V5', url: 'https://x' });
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an oversized file is refused before it is downloaded', async () => {
  const dir = tempDir();
  let called = false;
  const cache = createMediaCache({
    dir,
    maxBytes: 1024,
    download: async () => { called = true; return Buffer.from('X'); },
    logger: { error: () => {} },
  });

  const file = await cache.ensure('MSGID',
    { kind: 'video', mediaKey: 'a2V5', url: 'https://x', fileLength: 99 * 1024 * 1024 });
  assert.strictEqual(file, '');
  assert.strictEqual(called, false, 'the cap must be checked before downloading');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failed download leaves nothing behind', async () => {
  const dir = tempDir();
  const cache = createMediaCache({
    dir,
    download: async () => { throw new Error('CDN 410'); },
    logger: { error: () => {} },
  });

  assert.strictEqual(await cache.ensure('MSGID', { kind: 'image', mediaKey: 'a2V5', url: 'https://x' }), '');
  assert.strictEqual(fs.readdirSync(dir).length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('media with no key is not fetchable and does not throw', async () => {
  const dir = tempDir();
  const cache = createMediaCache({ dir, download: async () => Buffer.from('X') });
  assert.strictEqual(await cache.ensure('MSGID', { kind: 'image', mediaKey: '', url: '' }), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a message id never becomes a path', async () => {
  const dir = tempDir();
  const cache = createMediaCache({ dir, download: async () => Buffer.from('X') });

  const file = await cache.ensure('../../escape',
    { kind: 'image', mediaKey: 'a2V5', url: 'https://x' });
  assert.strictEqual(path.dirname(path.resolve(file)), path.resolve(dir),
    'a message id comes off the wire and must not escape the cache directory');

  fs.rmSync(dir, { recursive: true, force: true });
});
