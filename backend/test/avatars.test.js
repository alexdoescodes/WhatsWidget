'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAvatarCache } = require('../src/avatars');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-avatars-'));
}

test('a fetched picture is cached and reused', async () => {
  const dir = tempDir();
  let urlCalls = 0;
  let downloads = 0;
  const cache = createAvatarCache({
    dir,
    fetchUrl: async () => { urlCalls++; return 'https://example.invalid/p.jpg'; },
    download: async () => { downloads++; return Buffer.from('JPEGDATA'); },
  });

  const first = await cache.ensure('a@s.whatsapp.net');
  assert.ok(first, 'a path is returned');
  assert.strictEqual(fs.readFileSync(first, 'utf8'), 'JPEGDATA');

  const second = await cache.ensure('a@s.whatsapp.net');
  assert.strictEqual(second, first);
  assert.strictEqual(urlCalls, 1, 'a cached picture is not looked up again');
  assert.strictEqual(downloads, 1, 'nor downloaded again');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('cached pictures are 0600 in a 0700 directory', async () => {
  const dir = tempDir();
  fs.rmSync(dir, { recursive: true, force: true });
  const cache = createAvatarCache({
    dir,
    fetchUrl: async () => 'https://example.invalid/p.jpg',
    download: async () => Buffer.from('JPEGDATA'),
  });

  const file = await cache.ensure('a@s.whatsapp.net');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a contact with no picture is not an error', async () => {
  const dir = tempDir();
  const cache = createAvatarCache({
    dir,
    fetchUrl: async () => '',
    download: async () => { throw new Error('should not download'); },
  });

  assert.strictEqual(await cache.ensure('a@s.whatsapp.net'), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a lookup that throws leaves the letter avatar in place', async () => {
  const dir = tempDir();
  const cache = createAvatarCache({
    dir,
    fetchUrl: async () => { throw new Error('403 forbidden'); },
    download: async () => { throw new Error('should not download'); },
  });

  assert.strictEqual(await cache.ensure('a@s.whatsapp.net'), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failed download leaves nothing behind', async () => {
  const dir = tempDir();
  const errors = [];
  const cache = createAvatarCache({
    dir,
    fetchUrl: async () => 'https://example.invalid/p.jpg',
    download: async () => { throw new Error('HTTP 404'); },
    logger: { error: (...a) => errors.push(a.join(' ')) },
  });

  assert.strictEqual(await cache.ensure('a@s.whatsapp.net'), '');
  assert.strictEqual(fs.readdirSync(dir).length, 0, 'no partial file');
  assert.strictEqual(errors.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a jid never becomes a path', async () => {
  const dir = tempDir();
  const cache = createAvatarCache({
    dir,
    fetchUrl: async () => 'https://example.invalid/p.jpg',
    download: async () => Buffer.from('X'),
  });

  // A jid is attacker-influenced in the sense that it comes off the wire.
  const file = await cache.ensure('../../escape@s.whatsapp.net');
  assert.strictEqual(path.dirname(path.resolve(file)), path.resolve(dir),
    'the cache must not be able to write outside its own directory');

  fs.rmSync(dir, { recursive: true, force: true });
});
