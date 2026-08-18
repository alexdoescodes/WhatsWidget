'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createServer } = require('../src/server');
const { createStore } = require('../src/store');

function build({ verify = async () => ({ ok: true }), sendMessage } = {}) {
  const store = createStore({});
  const events = new EventEmitter();
  const client = {
    events,
    getStatus: () => 'connected',
    getQrPng: () => null,
    sendMessage: sendMessage || (async (jid, text) => { client.sent = { jid, text }; }),
  };
  const endpointFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ww-')), 'endpoint.json');
  const server = createServer({ client, store, authenticator: { verify }, endpointFile });
  return { server, store, client, events, endpointFile };
}

const get = (server, route, token) => fetch(`http://127.0.0.1:${server.port}${route}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
});

test('rejects requests with no token', async () => {
  const { server, endpointFile } = build();
  await server.listen();
  const res = await get(server, '/status');
  assert.strictEqual(res.status, 401);
  await server.close();
  assert.strictEqual(fs.existsSync(endpointFile), false);
});

test('rejects requests with a wrong token', async () => {
  const { server } = build();
  await server.listen();
  const res = await get(server, '/status', 'not-the-token');
  assert.strictEqual(res.status, 401);
  await server.close();
});

test('serves status with a valid token', async () => {
  const { server } = build();
  const { token } = await server.listen();
  const res = await get(server, '/status', token);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { status: 'connected', unread: 0 });
  await server.close();
});

test('writes the endpoint file 0600 with port and token', async () => {
  const { server, endpointFile } = build();
  const { token, port } = await server.listen();
  const raw = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
  assert.strictEqual(raw.token, token);
  assert.strictEqual(raw.port, port);
  assert.strictEqual(fs.statSync(endpointFile).mode & 0o777, 0o600);
  await server.close();
});

test('sends a message through the client', async () => {
  const { server, client } = build();
  const { token } = await server.listen();
  const res = await fetch(`http://127.0.0.1:${server.port}/chats/friend%40s.whatsapp.net/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.strictEqual(res.status, 204);
  assert.deepStrictEqual(client.sent, { jid: 'friend@s.whatsapp.net', text: 'hi' });
  await server.close();
});

test('unlock returns 429 with retryAfterMs when throttled', async () => {
  const { server } = build({ verify: async () => ({ ok: false, reason: 'throttled', retryAfterMs: 4000 }) });
  const { token } = await server.listen();
  const res = await fetch(`http://127.0.0.1:${server.port}/unlock`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'nope' }),
  });
  assert.strictEqual(res.status, 429);
  assert.deepStrictEqual(await res.json(), { ok: false, reason: 'throttled', retryAfterMs: 4000 });
  await server.close();
});

test('unlock returns 401 for an invalid password', async () => {
  const { server } = build({ verify: async () => ({ ok: false, reason: 'invalid', retryAfterMs: 2000 }) });
  const { token } = await server.listen();
  const res = await fetch(`http://127.0.0.1:${server.port}/unlock`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'nope' }),
  });
  assert.strictEqual(res.status, 401);
  await server.close();
});

test('pushes client events to a connected websocket subscriber', async () => {
  const { server, events } = build();
  const { token } = await server.listen();

  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const nextFrame = () => new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (err) {
        reject(err);
      }
    });
  });

  const messageFramePromise = nextFrame();
  events.emit('message', { jid: 'friend@s.whatsapp.net', message: { id: '1', text: 'hi' } });
  const messageFrame = await messageFramePromise;
  assert.strictEqual(messageFrame.type, 'message');
  assert.strictEqual(messageFrame.jid, 'friend@s.whatsapp.net');
  assert.deepStrictEqual(messageFrame.message, { id: '1', text: 'hi' });
  assert.strictEqual(typeof messageFrame.unread, 'number');

  const statusFramePromise = nextFrame();
  events.emit('status', 'connected');
  const statusFrame = await statusFramePromise;
  assert.deepStrictEqual(statusFrame, { type: 'status', status: 'connected' });

  await new Promise((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
  await server.close();
});

test('returns 503 when the client fails to send a message', async () => {
  const { server } = build({ sendMessage: async () => { throw new Error('boom'); } });
  const { token } = await server.listen();
  const res = await fetch(`http://127.0.0.1:${server.port}/chats/friend%40s.whatsapp.net/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.strictEqual(res.status, 503);
  assert.deepStrictEqual(await res.json(), { error: 'boom' });
  await server.close();
});
