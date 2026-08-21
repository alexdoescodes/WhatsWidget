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
 * Protobuf number fields arrive as either a plain number or a protobufjs Long
 * (an object with low/high words). Number(long) yields NaN, so every timestamp
 * and count out of a sync payload has to come through here.
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value && typeof value.toNumber === 'function') {
    const n = value.toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** The best display name a contact record offers, in descending trust. */
function contactName(contact) {
  return contact.name || contact.notify || contact.verifiedName || '';
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
  let reconnectTimer = null;
  let starting = false;

  function setStatus(next) {
    if (status === next) return;
    status = next;
    events.emit('status', status);
  }

  async function start() {
    if (starting) return;
    starting = true;
    try {
      if (sock) {
        // Drop the old socket's listeners before replacing it, otherwise every
        // reconnect leaves another live listener set attached.
        sock.ev.removeAllListeners();
        if (typeof sock.end === 'function') {
          try { sock.end(); } catch { /* already closed */ }
        }
        sock = null;
      }

      const { state, saveCreds } = await authState(sessionDir);
      sock = makeSocket({ auth: state, printQRInTerminal: false, syncFullHistory: true});

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
          // Group subjects are queryable at any time, unlike history, so this
          // does not depend on a sync arriving. Without it a group only ever
          // gets the pushName of whoever last spoke in it.
          fetchGroups();
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
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            start().catch((e) => logger.error('reconnect failed:', e.message));
          }, reconnectDelayMs);
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

      // History sync: the phone pushes existing conversations when a device is
      // linked (and in batches afterwards). This is the only way to learn about
      // chats that predate this backend -- WhatsApp's servers hold no history,
      // so nothing can be fetched from them after the fact.
      sock.ev.on('messaging-history.set', ({ chats = [], contacts = [], messages = [] }) => {
        for (const contact of contacts) {
          const name = contactName(contact);
          if (contact.id && name) store.upsertChat(contact.id, { name });
        }

        for (const chat of chats) {
          if (!chat.id) continue;
          store.upsertChat(chat.id, {
            name: chat.name || undefined,
            archived: typeof chat.archived === 'boolean' ? chat.archived : undefined,
            unread: toNumber(chat.unreadCount),
            lastMessageAt: toNumber(chat.conversationTimestamp),
          });
        }

        for (const waMessage of messages) {
          const jid = waMessage.key?.remoteJid;
          if (!jid) continue;
          // Never increments unread: these are historical, and the phone
          // already told us the real per-chat count above.
          store.addMessage(jid, {
            id: waMessage.key.id,
            fromMe: Boolean(waMessage.key.fromMe),
            text: extractText(waMessage.message),
            timestamp: toNumber(waMessage.messageTimestamp),
          }, { incrementUnread: false });
        }

        events.emit('chats');
      });

      // Archive/unarchive and rename arrive here, both from the phone and from
      // other linked devices.
      const applyChats = (list) => {
        let changed = false;
        for (const chat of list) {
          if (!chat.id) continue;
          store.upsertChat(chat.id, {
            name: chat.name || undefined,
            archived: typeof chat.archived === 'boolean' ? chat.archived : undefined,
            unread: toNumber(chat.unreadCount),
            lastMessageAt: toNumber(chat.conversationTimestamp),
          });
          changed = true;
        }
        if (changed) events.emit('chats');
      };
      sock.ev.on('chats.upsert', applyChats);
      sock.ev.on('chats.update', applyChats);

      sock.ev.on('contacts.upsert', (list) => {
        let changed = false;
        for (const contact of list) {
          const name = contactName(contact);
          if (!contact.id || !name) continue;
          store.upsertChat(contact.id, { name });
          changed = true;
        }
        if (changed) events.emit('chats');
      });
    } finally {
      starting = false;
    }
  }

  /**
   * Names every group the account participates in. Failure is not fatal: the
   * chats simply keep whatever name they already had, so this never blocks or
   * breaks a connection that is otherwise fine.
   */
  async function fetchGroups() {
    if (!sock || typeof sock.groupFetchAllParticipating !== 'function') return;
    try {
      const groups = await sock.groupFetchAllParticipating();
      let changed = false;
      for (const group of Object.values(groups || {})) {
        if (!group?.id || !group.subject) continue;
        store.upsertChat(group.id, { name: group.subject });
        changed = true;
      }
      if (changed) events.emit('chats');
    } catch (err) {
      logger.error('could not fetch group list:', err.message);
    }
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
