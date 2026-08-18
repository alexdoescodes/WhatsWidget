'use strict';

const { EventEmitter } = require('node:events');
const baileys = require('baileys');
const QRCode = require('qrcode');

const { DisconnectReason, useMultiFileAuthState } = baileys;

/** Pull display text out of the many shapes a WhatsApp message can take. */
function extractText(message) {
  if (!message) return '';
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  return '[unsupported message]';
}

/**
 * Owns the Baileys connection and translates its events into a small,
 * stable surface for the HTTP/WS layer. Everything here is event driven;
 * there is no polling loop.
 */
function createWhatsAppClient({
  sessionDir,
  store,
  makeSocket = baileys.default,
  authState = (dir) => useMultiFileAuthState(dir),
  qrToBuffer = (text) => QRCode.toBuffer(text, { margin: 1, width: 320 }),
  reconnectDelayMs = 3000,
  logger = console,
} = {}) {
  const events = new EventEmitter();
  let sock = null;
  let status = 'connecting';
  let qrPng = null;

  function setStatus(next) {
    if (status === next) return;
    status = next;
    events.emit('status', status);
  }

  async function start() {
    const { state, saveCreds } = await authState(sessionDir);
    sock = makeSocket({ auth: state, printQRInTerminal: false, syncFullHistory: false });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          qrPng = await qrToBuffer(qr);
          setStatus('needs-pairing');
        } catch (err) {
          logger.error('failed to render pairing QR:', err.message);
        }
      }

      if (connection === 'open') {
        qrPng = null;
        setStatus('connected');
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          // Session revoked from the phone: fall back to pairing.
          qrPng = null;
          setStatus('needs-pairing');
        } else {
          setStatus('disconnected');
        }
        setTimeout(() => { start().catch((e) => logger.error('reconnect failed:', e.message)); }, reconnectDelayMs);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const waMessage of messages) {
        const jid = waMessage.key?.remoteJid;
        if (!jid) continue;
        const fromMe = Boolean(waMessage.key.fromMe);
        const message = {
          id: waMessage.key.id,
          fromMe,
          text: extractText(waMessage.message),
          timestamp: Number(waMessage.messageTimestamp) || 0,
        };
        store.addMessage(jid, message, { incrementUnread: !fromMe, name: waMessage.pushName });
        events.emit('message', { jid, message });
      }
    });
  }

  async function sendMessage(jid, text) {
    if (!sock) throw new Error('not connected');
    await sock.sendMessage(jid, { text });
  }

  return {
    events,
    start,
    sendMessage,
    getStatus: () => status,
    getQrPng: () => qrPng,
  };
}

module.exports = { createWhatsAppClient, extractText };
