'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPersistence } = require('../src/persist');
const { createStore } = require('../src/store');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-persist-'));
  return { dir, file: path.join(dir, 'chats.json') };
}

function seed(store) {
  store.recordContactName('a@s.whatsapp.net', 'Laura');
  store.addMessage('a@s.whatsapp.net',
    { id: '1', fromMe: false, text: 'see you', timestamp: 100 }, { incrementUnread: true });
  store.upsertChat('g@g.us', { name: 'Study Group', archived: true, lastMessageAt: 50 });
}

test('a saved store comes back after a restart', () => {
  const { dir, file } = tempFile();
  const first = createStore();
  seed(first);
  assert.ok(createPersistence({ file, store: first }).save());

  const second = createStore();
  assert.ok(createPersistence({ file, store: second }).load());

  const chats = second.listChats();
  assert.strictEqual(chats.length, 2);
  assert.strictEqual(chats[0].name, 'Laura');
  assert.strictEqual(chats[0].lastMessageText, 'see you');
  assert.strictEqual(chats[1].name, 'Study Group');
  assert.strictEqual(chats[1].archived, true);
  assert.strictEqual(second.totalUnread(), 1);
  assert.deepStrictEqual(second.getMessages('a@s.whatsapp.net').map((m) => m.text), ['see you']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the cache is written 0600 -- it holds message text', () => {
  const { dir, file } = tempFile();
  const store = createStore();
  seed(store);
  createPersistence({ file, store }).save();

  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('contact names survive, and still apply to a chat learned later', () => {
  const { dir, file } = tempFile();
  const first = createStore();
  first.recordContactName('b@s.whatsapp.net', 'Marc');
  createPersistence({ file, store: first }).save();

  const second = createStore();
  createPersistence({ file, store: second }).load();
  second.addMessage('b@s.whatsapp.net', { id: '9', fromMe: false, text: 'yo', timestamp: 5 });

  assert.strictEqual(second.listChats()[0].name, 'Marc');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing file is a normal first run, not an error', () => {
  const { dir, file } = tempFile();
  const store = createStore();
  const errors = [];
  const persistence = createPersistence({
    file, store, logger: { error: (...a) => errors.push(a.join(' ')) },
  });

  assert.strictEqual(persistence.load(), false);
  assert.deepStrictEqual(errors, []);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a truncated cache is rebuilt rather than crashing the backend', () => {
  const { dir, file } = tempFile();
  fs.writeFileSync(file, '{"version":1,"chats":[{"jid":"a","mess');

  const store = createStore();
  const errors = [];
  const persistence = createPersistence({
    file, store, logger: { error: (...a) => errors.push(a.join(' ')) },
  });

  assert.strictEqual(persistence.load(), false);
  assert.strictEqual(store.listChats().length, 0);
  assert.strictEqual(errors.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unknown version is refused rather than half-read', () => {
  const { dir, file } = tempFile();
  fs.writeFileSync(file, JSON.stringify({ version: 99, chats: [{ jid: 'a', messages: [] }] }));

  const store = createStore();
  assert.strictEqual(createPersistence({ file, store }).load(), false);
  assert.strictEqual(store.listChats().length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('saving is skipped when nothing changed', () => {
  const { dir, file } = tempFile();
  const store = createStore();
  seed(store);
  const persistence = createPersistence({ file, store });

  assert.strictEqual(persistence.save(), true);
  assert.strictEqual(persistence.save(), false, 'an unchanged store must not be rewritten');

  store.addMessage('a@s.whatsapp.net', { id: '2', fromMe: true, text: 'ok', timestamp: 200 });
  assert.strictEqual(persistence.save(), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('no partial file is left behind when the write fails', () => {
  const { dir, file } = tempFile();
  const store = createStore();
  seed(store);
  // A directory where the temp file wants to be: rename cannot succeed.
  fs.mkdirSync(`${file}.tmp`);

  const persistence = createPersistence({
    file, store, logger: { error: () => {} },
  });

  assert.strictEqual(persistence.save(), false);
  assert.strictEqual(fs.existsSync(file), false, 'no half-written cache');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('restoring re-applies the message cap', () => {
  const { dir, file } = tempFile();
  const big = createStore({ maxMessagesPerChat: 100 });
  for (let i = 0; i < 60; i++) {
    big.addMessage('a@s.whatsapp.net', { id: String(i), fromMe: false, text: 't', timestamp: i });
  }
  createPersistence({ file, store: big }).save();

  const small = createStore({ maxMessagesPerChat: 10 });
  createPersistence({ file, store: small }).load();

  const kept = small.getMessages('a@s.whatsapp.net');
  assert.strictEqual(kept.length, 10);
  assert.strictEqual(kept[kept.length - 1].timestamp, 59, 'the newest must be the ones kept');

  fs.rmSync(dir, { recursive: true, force: true });
});
