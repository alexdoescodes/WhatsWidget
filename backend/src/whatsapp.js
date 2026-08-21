'use strict';

const fs = require('node:fs');
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

/**
 * Whether a jid is a conversation the panel should list.
 *
 * Newsletters (WhatsApp Channels) count: they are followed feeds that sit in
 * the chat list like anything else. Their names are not in history sync
 * though, so they need resolveNewsletterNames() or they render as a bare
 * 120363...@newsletter row.
 *
 * The status broadcast does not count -- that is the Status carousel, not a
 * conversation.
 */
function isConversation(jid) {
  if (typeof jid !== 'string' || !jid) return false;
  if (jid === 'status@broadcast') return false;
  return !jid.endsWith('@broadcast');
}

function isNewsletter(jid) {
  return typeof jid === 'string' && jid.endsWith('@newsletter');
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
          resolveNewsletterNames();
          resyncMetadata();
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) {
            // Session revoked from the phone: fall back to pairing.
            //
            // The stored credentials MUST go with it. They are already dead
            // server-side, but useMultiFileAuthState will happily load them
            // again, and Baileys only offers a QR when it has no credentials
            // to try -- with these still on disk it retries "logging in..."
            // against a revoked session forever and no QR is ever produced.
            // The widget then sits on "needs-pairing" with /qr returning 404,
            // which is indistinguishable from a hang.
            clearSession();
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
          if (!isConversation(jid)) continue;
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
        for (const contact of contacts) rememberContact(contact);

        for (const chat of chats) {
          if (!isConversation(chat.id)) continue;
          store.upsertChat(chat.id, {
            name: chat.name || undefined,
            archived: typeof chat.archived === 'boolean' ? chat.archived : undefined,
            unread: toNumber(chat.unreadCount),
            lastMessageAt: toNumber(chat.conversationTimestamp),
          });
        }

        for (const waMessage of messages) {
          const jid = waMessage.key?.remoteJid;
          if (!isConversation(jid)) continue;
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
        resolveNewsletterNames();
      });

      // Archive/unarchive and rename arrive here, both from the phone and from
      // other linked devices.
      const applyChats = (list) => {
        let changed = false;
        for (const chat of list) {
          if (!isConversation(chat.id)) continue;
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

      const applyContacts = (list) => {
        let changed = false;
        for (const contact of list) changed = rememberContact(contact) || changed;
        if (changed) events.emit('chats');
      };
      sock.ev.on('contacts.upsert', applyContacts);
      sock.ev.on('contacts.update', applyContacts);
    } finally {
      starting = false;
    }
  }

  /**
   * Files a contact's display name under every address form it carries.
   *
   * WhatsApp addresses the same person two ways -- a phone-number JID
   * (@s.whatsapp.net) and an anonymised LID (@lid) -- and a conversation may
   * be keyed by either. A name recorded under only one of them leaves the
   * chat showing a raw address, which is most of what an unnamed chat list
   * actually is.
   *
   * Names are never used to create chats. The address book is far larger than
   * the set of people you have talked to, and folding it into the chat list
   * would bury the real conversations.
   */
  function rememberContact(contact) {
    let changed = false;

    // The contact record is the only place that states outright that a LID and
    // a phone-number jid are the same person. Message keys carry just one form,
    // so without this the two never get connected and the same conversation
    // shows up twice.
    const ids = [contact.id, contact.jid, contact.lid].filter(Boolean);
    for (let i = 1; i < ids.length; i++) {
      if (store.linkIdentity(ids[0], ids[i])) changed = true;
    }

    const name = contactName(contact);
    if (name) {
      for (const id of ids) store.recordContactName(id, name);
      changed = changed || ids.length > 0;
    }
    return changed;
  }

  /**
   * Re-requests the account's app state: contacts, and the archive flags that
   * history sync does not carry.
   *
   * History only arrives when a device is linked, but app state can be asked
   * for at any time -- which is the difference between "re-pair to fix your
   * chat names" and the widget repairing itself on the next connect.
   *
   * A full resync (from version 0) is only worth its cost when something is
   * actually missing, so it is used just while chats are still showing raw
   * addresses. Once names are learned this settles into the cheap incremental
   * form, and eventually into a no-op.
   */
  async function resyncMetadata() {
    if (!sock || typeof sock.resyncAppState !== 'function') return;

    const unnamed = store.listChats().some((chat) => chat.name === chat.jid);
    try {
      await sock.resyncAppState(baileys.ALL_WA_PATCH_NAMES, unnamed);
    } catch (err) {
      // Not fatal: the connection is fine, the widget just keeps whatever
      // names and archive flags it already had.
      logger.error('could not resync app state:', err.message);
    }
  }

  /**
   * Fills in the names of followed Channels.
   *
   * Newsletter names come from neither history sync nor the contact list, so
   * each one has to be asked for by jid. Only ever asks about Channels that
   * are still showing a raw address, so a name learned once is not re-fetched
   * and the work shrinks to nothing on a settled account.
   */
  async function resolveNewsletterNames(limit = 50) {
    if (!sock || typeof sock.newsletterMetadata !== 'function') return;

    const pending = store.listChats()
      .filter((chat) => isNewsletter(chat.jid) && chat.name === chat.jid)
      .slice(0, limit);
    if (pending.length === 0) return;

    let changed = false;
    for (const chat of pending) {
      try {
        const meta = await sock.newsletterMetadata('jid', chat.jid);
        if (meta?.name) {
          store.upsertChat(chat.jid, { name: meta.name });
          changed = true;
        }
      } catch {
        // A Channel since deleted, or a request that timed out. It keeps its
        // raw id and gets another chance on the next connect.
      }
    }
    if (changed) events.emit('chats');
  }

  /**
   * Throws away the stored credentials so the next connection starts from
   * scratch and WhatsApp issues a pairing QR.
   *
   * Only ever called when WhatsApp itself has told us the session is revoked.
   * Never on an ordinary disconnect -- deleting credentials because the wifi
   * dropped would force a re-pair for a blip.
   */
  function clearSession() {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch (err) {
      logger.error('could not clear the revoked session:', err.message);
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

module.exports = { createWhatsAppClient, extractText, isConversation };
