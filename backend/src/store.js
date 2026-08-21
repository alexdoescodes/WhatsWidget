'use strict';

/**
 * In-memory chat/message store fed by WhatsApp events.
 *
 * Bounded on both axes so a long-running background service does not grow
 * with chat history.
 *
 * Eviction drops the least recently active chat, decided by lastMessageAt.
 * This used to lean on the Map's insertion order as a recency proxy, which
 * held while chats could only arrive one live message at a time. History sync
 * breaks that: it delivers whole conversations at once, newest first, so
 * insertion order would have made the NEWEST chats the first ones evicted.
 */
function createStore({ maxMessagesPerChat = 50, maxChats = 200 } = {}) {
  const chats = new Map();
  // Display names learned from the contact list, keyed by every id form a
  // contact can carry (WhatsApp addresses the same person as @s.whatsapp.net
  // in one place and @lid in another). Kept apart from `chats` on purpose:
  // knowing someone's name is not the same as having a conversation with
  // them, and folding the address book into the chat list would bury the
  // real chats under hundreds of empty entries.
  const contactNames = new Map();

  // Bumped by every mutation so a persistence layer can tell whether anything
  // is worth writing, without diffing the whole store or saving on a timer
  // regardless.
  let revision = 0;

  function recordContactName(jid, name) {
    if (!jid || !name) return;
    if (contactNames.get(jid) === name) return;
    revision += 1;
    contactNames.set(jid, name);
    // Apply it to a conversation that arrived before the name did and is
    // still falling back to showing a raw address.
    const chat = chats.get(jid);
    if (chat && chat.name === jid) chat.name = name;
  }

  // Only ever called when the store is over capacity, which for the live
  // message path means once per message while full, and for a bulk history
  // load means once for the whole batch.
  function prune() {
    if (chats.size <= maxChats) return;
    const ordered = [...chats.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    for (const chat of ordered.slice(maxChats)) chats.delete(chat.jid);
  }

  function touch(jid, name) {
    let chat = chats.get(jid);
    if (chat) {
      if (name) chat.name = name;
    } else {
      chat = {
        jid,
        name: name || contactNames.get(jid) || jid,
        unread: 0,
        lastMessageAt: 0,
        archived: false,
        messages: [],
      };
      chats.set(jid, chat);
    }
    return chat;
  }

  function addMessage(jid, message, { incrementUnread = false, name } = {}) {
    const chat = touch(jid, name);

    // A history sync can re-deliver messages that are already here, and after
    // a re-pair the same message can arrive both as history and live.
    if (message.id && chat.messages.some((m) => m.id === message.id)) return chat;

    // `messages` is kept sorted oldest-last. Live messages arrive in order and
    // take the push; history sync arrives NEWEST FIRST, so those have to be
    // placed. Without this the array ends up in whatever order events landed,
    // which made "the last message" the oldest one in the batch and made the
    // cap below trim the newest messages instead of the oldest.
    const last = chat.messages[chat.messages.length - 1];
    if (!last || message.timestamp >= last.timestamp) {
      chat.messages.push(message);
    } else {
      let i = chat.messages.length;
      while (i > 0 && chat.messages[i - 1].timestamp > message.timestamp) i--;
      chat.messages.splice(i, 0, message);
    }

    if (chat.messages.length > maxMessagesPerChat) {
      chat.messages.splice(0, chat.messages.length - maxMessagesPerChat);
    }
    if (message.timestamp > chat.lastMessageAt) chat.lastMessageAt = message.timestamp;
    if (incrementUnread) chat.unread += 1;
    revision += 1;
    // After the timestamp is current, never before: a brand new chat still
    // carries lastMessageAt 0 at the top of this function and would be the
    // first thing thrown away by its own insertion.
    prune();
    return chat;
  }

  /**
   * Record chat metadata that did not arrive as a message: history sync,
   * chats.upsert/update, group and contact names.
   *
   * Every field is optional and only applied when actually supplied, so a
   * later partial update (an archive toggle, say) cannot blank a name that a
   * fuller event already established.
   */
  function upsertChat(jid, { name, archived, unread, lastMessageAt } = {}) {
    const chat = touch(jid, name);
    if (!name && chat.name === jid && contactNames.has(jid)) {
      chat.name = contactNames.get(jid);
    }
    if (typeof archived === 'boolean') chat.archived = archived;
    if (Number.isFinite(unread) && unread >= 0) chat.unread = unread;
    if (Number.isFinite(lastMessageAt) && lastMessageAt > chat.lastMessageAt) {
      chat.lastMessageAt = lastMessageAt;
    }
    revision += 1;
    prune();
    return chat;
  }

  function markRead(jid) {
    const chat = chats.get(jid);
    if (chat && chat.unread !== 0) {
      chat.unread = 0;
      revision += 1;
    }
  }

  /**
   * Chat metadata, newest first, plus a one-line preview of the newest
   * message.
   *
   * The message bodies still do not come along — only the last message's text
   * and its direction, which is exactly what the panel's preview line renders.
   * `messages` is already capped by addMessage, so the "last" here is the last
   * one the store still holds, never an evicted older one.
   */
  function listChats() {
    return [...chats.values()]
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
      .map(({ messages, ...meta }) => {
        const last = messages.length > 0 ? messages[messages.length - 1] : null;
        return {
          ...meta,
          lastMessageText: last && last.text ? last.text : '',
          lastMessageFromMe: last ? Boolean(last.fromMe) : false,
        };
      });
  }

  function getMessages(jid) {
    const chat = chats.get(jid);
    return chat ? chat.messages : [];
  }

  /**
   * Unread across non-archived chats only. Archiving a conversation in
   * WhatsApp is how you tell it to stop demanding attention, so counting
   * archived chats here would put a badge on the panel for exactly the
   * conversations the user has already dismissed.
   */
  function totalUnread() {
    let total = 0;
    for (const chat of chats.values()) {
      if (!chat.archived) total += chat.unread;
    }
    return total;
  }

  /**
   * Everything worth keeping across a restart, as plain JSON-able data.
   *
   * History only ever arrives when a device is linked, so without this a
   * restart means the chat list is empty until someone happens to message
   * you -- and getting it back means unlinking and scanning a QR again.
   */
  function snapshot() {
    return {
      version: 1,
      chats: [...chats.values()],
      contactNames: [...contactNames.entries()],
    };
  }

  /** Replace the contents from a snapshot, re-applying both caps. */
  function restore(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.chats)) return false;

    chats.clear();
    contactNames.clear();

    for (const entry of data.contactNames || []) {
      if (Array.isArray(entry) && entry[0] && entry[1]) contactNames.set(entry[0], entry[1]);
    }

    for (const chat of data.chats) {
      if (!chat || typeof chat.jid !== 'string') continue;
      const messages = Array.isArray(chat.messages) ? chat.messages.slice() : [];
      messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      chats.set(chat.jid, {
        jid: chat.jid,
        name: typeof chat.name === 'string' && chat.name ? chat.name : chat.jid,
        unread: Number.isFinite(chat.unread) && chat.unread > 0 ? chat.unread : 0,
        lastMessageAt: Number.isFinite(chat.lastMessageAt) ? chat.lastMessageAt : 0,
        archived: chat.archived === true,
        messages: messages.slice(-maxMessagesPerChat),
      });
    }

    prune();
    revision += 1;
    return true;
  }

  return {
    addMessage,
    upsertChat,
    recordContactName,
    markRead,
    listChats,
    getMessages,
    totalUnread,
    snapshot,
    restore,
    getRevision: () => revision,
  };
}

module.exports = { createStore };
