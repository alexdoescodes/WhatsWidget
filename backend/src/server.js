'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Loopback HTTP + WebSocket API for the widget.
 *
 * QML can only speak TCP (no QLocalSocket binding), so this cannot be a Unix
 * socket. To compensate, every request must present a bearer token that only
 * ever exists in a 0600 file under the user's runtime dir, and non-loopback
 * peers are refused outright.
 */
function createServer({ client, store, authenticator, endpointFile }) {
  const token = crypto.randomBytes(32).toString('hex');
  const httpServer = http.createServer(handleRequest);
  const wss = new WebSocketServer({ noServer: true });

  function authorized(req) {
    if (!LOOPBACK.has(req.socket.remoteAddress)) return false;
    const header = req.headers.authorization || '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    return supplied.length > 0 && timingSafeEqual(supplied, token);
  }

  function json(res, code, body) {
    const payload = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(payload);
  }

  async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return {};
    }
  }

  async function handleRequest(req, res) {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });

    const url = new URL(req.url, 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, { status: client.getStatus(), unread: store.totalUnread() });
    }

    if (req.method === 'GET' && url.pathname === '/qr') {
      const png = client.getQrPng();
      if (!png) return json(res, 404, { error: 'no pairing code available' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(png);
    }

    if (req.method === 'GET' && url.pathname === '/chats') {
      return json(res, 200, { chats: store.listChats() });
    }

    if (segments[0] === 'chats' && segments.length === 3) {
      const jid = decodeURIComponent(segments[1]);

      if (req.method === 'GET' && segments[2] === 'messages') {
        return json(res, 200, { messages: store.getMessages(jid) });
      }

      if (req.method === 'POST' && segments[2] === 'messages') {
        const body = await readJsonBody(req);
        if (!body.text) return json(res, 400, { error: 'text is required' });
        try {
          await client.sendMessage(jid, body.text);
        } catch (err) {
          return json(res, 503, { error: err.message });
        }
        res.writeHead(204);
        return res.end();
      }

      if (req.method === 'POST' && segments[2] === 'read') {
        store.markRead(jid);
        broadcast({ type: 'unread', unread: store.totalUnread() });
        res.writeHead(204);
        return res.end();
      }
    }

    if (req.method === 'POST' && url.pathname === '/unlock') {
      const body = await readJsonBody(req);
      const result = await authenticator.verify(String(body.password || ''));
      if (result.ok) return json(res, 200, { ok: true });
      const code = result.reason === 'throttled' ? 429 : 401;
      return json(res, code, result);
    }

    return json(res, 404, { error: 'not found' });
  }

  function broadcast(payload) {
    const message = JSON.stringify(payload);
    for (const socket of wss.clients) {
      if (socket.readyState === socket.OPEN) socket.send(message);
    }
  }

  httpServer.on('upgrade', (req, socket, head) => {
    if (!authorized(req) || new URL(req.url, 'http://127.0.0.1').pathname !== '/events') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  client.events.on('status', (status) => broadcast({ type: 'status', status }));
  client.events.on('message', ({ jid, message }) => {
    broadcast({ type: 'message', jid, message, unread: store.totalUnread() });
  });

  const api = {
    token,
    port: 0,
    listen() {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', () => {
          api.port = httpServer.address().port;
          fs.mkdirSync(path.dirname(endpointFile), { recursive: true });
          fs.writeFileSync(endpointFile, JSON.stringify({ port: api.port, token }), { mode: 0o600 });
          // writeFileSync only applies mode when creating; enforce on reuse.
          fs.chmodSync(endpointFile, 0o600);
          resolve({ port: api.port, token });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        try { fs.unlinkSync(endpointFile); } catch { /* already gone */ }
        for (const socket of wss.clients) socket.terminate();
        httpServer.close(() => resolve());
      });
    },
    broadcast,
  };

  return api;
}

module.exports = { createServer };
