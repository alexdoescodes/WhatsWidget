'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createWhatsAppClient, extractText } = require('../src/whatsapp');
const { createStore } = require('../src/store');

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
