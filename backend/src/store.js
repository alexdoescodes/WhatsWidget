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
        name: name || jid,
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
    chat.messages.push(message);
    if (chat.messages.length > maxMessagesPerChat) {
      chat.messages.splice(0, chat.messages.length - maxMessagesPerChat);
    }
    if (message.timestamp > chat.lastMessageAt) chat.lastMessageAt = message.timestamp;
    if (incrementUnread) chat.unread += 1;
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
    if (typeof archived === 'boolean') chat.archived = archived;
    if (Number.isFinite(unread) && unread >= 0) chat.unread = unread;
    if (Number.isFinite(lastMessageAt) && lastMessageAt > chat.lastMessageAt) {
      chat.lastMessageAt = lastMessageAt;
    }
    prune();
    return chat;
  }

  function markRead(jid) {
    const chat = chats.get(jid);
    if (chat) chat.unread = 0;
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

  return { addMessage, upsertChat, markRead, listChats, getMessages, totalUnread };
}

module.exports = { createStore };
