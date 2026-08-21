'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createWhatsAppClient, extractText, isConversation } = require('../src/whatsapp');
const { createStore } = require('../src/store');
const { DisconnectReason } = require('baileys');

function fakeSocket() {
  const ev = new EventEmitter();
  return { ev, sendMessage: async () => {}, sent: [] };
}

function build({ store = createStore({}) } = {}) {
  const sock = fakeSocket();
  const client = createWhatsAppClient({
    sessionDir: '/tmp/unused',
    store,
    makeSocket: () => sock,
    authState: async () => ({ state: {}, saveCreds: async () => {} }),
    qrToBuffer: async (text) => Buffer.from(`png:${text}`),
    reconnectDelayMs: 0,
  });
  return { client, sock, store };
}

test('starts in connecting and reports needs-pairing with a QR image', async () => {
  const { client, sock } = build();
  assert.strictEqual(client.getStatus(), 'connecting');
  await client.start();

  sock.ev.emit('connection.update', { qr: 'QRDATA' });
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(client.getStatus(), 'needs-pairing');
  assert.strictEqual(client.getQrPng().toString(), 'png:QRDATA');
});

test('clears the QR once the connection opens', async () => {
  const { client, sock } = build();
  await client.start();
  sock.ev.emit('connection.update', { qr: 'QRDATA' });
  await new Promise((r) => setImmediate(r));
  sock.ev.emit('connection.update', { connection: 'open' });

  assert.strictEqual(client.getStatus(), 'connected');
  assert.strictEqual(client.getQrPng(), null);
});

test('emits status changes exactly once per transition', async () => {
  const { client, sock } = build();
  const seen = [];
  client.events.on('status', (s) => seen.push(s));
  await client.start();

  sock.ev.emit('connection.update', { connection: 'open' });
  sock.ev.emit('connection.update', { connection: 'open' });

  assert.deepStrictEqual(seen, ['connected']);
});

test('stores an incoming message and counts it unread', async () => {
  const { client, sock, store } = build();
  await client.start();

  sock.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{
      key: { id: 'M1', remoteJid: 'friend@s.whatsapp.net', fromMe: false },
      pushName: 'Friend',
      messageTimestamp: 1700000000,
      message: { conversation: 'hello there' },
    }],
  });

  const chats = store.listChats();
  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].name, 'Friend');
  assert.strictEqual(chats[0].unread, 1);
  assert.strictEqual(store.getMessages('friend@s.whatsapp.net')[0].text, 'hello there');
});

test('does not count our own outgoing messages as unread', async () => {
  const { client, sock, store } = build();
  await client.start();

  sock.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{
      key: { id: 'M2', remoteJid: 'friend@s.whatsapp.net', fromMe: true },
      messageTimestamp: 1700000001,
      message: { conversation: 'my reply' },
    }],
  });

  assert.strictEqual(store.totalUnread(), 0);
});

test('extractText handles plain and extended text, and unsupported kinds', () => {
  assert.strictEqual(extractText({ conversation: 'a' }), 'a');
  assert.strictEqual(extractText({ extendedTextMessage: { text: 'b' } }), 'b');
  assert.strictEqual(extractText({ imageMessage: { caption: 'c' } }), 'c');
  assert.strictEqual(extractText({ stickerMessage: {} }), '[unsupported message]');
  assert.strictEqual(extractText(null), '');
});

test('duplicate close events arm only one reconnect', async () => {
  const store = createStore({});
  let calls = 0;
  const socks = [];
  function countingMakeSocket() {
    calls += 1;
    const s = fakeSocket();
    socks.push(s);
    return s;
  }
  const client = createWhatsAppClient({
    sessionDir: '/tmp/unused',
    store,
    makeSocket: countingMakeSocket,
    authState: async () => ({ state: {}, saveCreds: async () => {} }),
    qrToBuffer: async (text) => Buffer.from(`png:${text}`),
    reconnectDelayMs: 0,
  });

  await client.start();
  assert.strictEqual(calls, 1);

  const sock = socks[0];
  const closeUpdate = {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 428 } } },
  };
  sock.ev.emit('connection.update', closeUpdate);
  sock.ev.emit('connection.update', closeUpdate);

  // Let the (single, guarded) reconnect timer flush.
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(calls, 2);
});

test('logged-out close goes to needs-pairing, not disconnected', async () => {
  const { client, sock } = build();
  await client.start();

  sock.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
  });
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(client.getStatus(), 'needs-pairing');
  assert.strictEqual(client.getQrPng(), null);

  // The close handler still arms a reconnect timer (reconnectDelayMs: 0
  // from build()) even on a logged-out close; let it flush before the
  // test ends so no timer is left dangling.
  await new Promise((r) => setTimeout(r, 20));
});

test('a revoked session is cleared from disk so a QR can be issued', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-session-'));
  fs.writeFileSync(path.join(dir, 'creds.json'), '{"me":"stale"}');
  fs.writeFileSync(path.join(dir, 'app-state-sync-key-A.json'), '{}');

  const sock = fakeSocket();
  const client = createWhatsAppClient({
    sessionDir: dir,
    store: createStore(),
    makeSocket: () => sock,
    authState: async () => ({ state: {}, saveCreds: async () => {} }),
    reconnectDelayMs: 10000,
  });
  await client.start();

  assert.strictEqual(fs.readdirSync(dir).length, 2, 'precondition: credentials on disk');

  sock.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
  });

  assert.strictEqual(client.getStatus(), 'needs-pairing');
  assert.strictEqual(fs.readdirSync(dir).length, 0,
    'revoked credentials must be gone, or Baileys retries them instead of offering a QR');
  assert.ok(fs.existsSync(dir), 'the directory itself must survive for the next pairing');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an ordinary disconnect leaves the credentials alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-session-'));
  fs.writeFileSync(path.join(dir, 'creds.json'), '{"me":"good"}');

  const sock = fakeSocket();
  const client = createWhatsAppClient({
    sessionDir: dir,
    store: createStore(),
    makeSocket: () => sock,
    authState: async () => ({ state: {}, saveCreds: async () => {} }),
    reconnectDelayMs: 10000,
  });
  await client.start();

  sock.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 500 } } },
  });

  assert.strictEqual(client.getStatus(), 'disconnected');
  assert.ok(fs.existsSync(path.join(dir, 'creds.json')),
    'a dropped connection must not force a re-pair');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Channels are conversations; the status carousel is not', () => {
  assert.strictEqual(isConversation('120363169319669622@newsletter'), true);
  assert.strictEqual(isConversation('4917@s.whatsapp.net'), true);
  assert.strictEqual(isConversation('86247305392309@lid'), true);
  assert.strictEqual(isConversation('x@g.us'), true);
  assert.strictEqual(isConversation('status@broadcast'), false);
  assert.strictEqual(isConversation(''), false);
  assert.strictEqual(isConversation(undefined), false);
});
