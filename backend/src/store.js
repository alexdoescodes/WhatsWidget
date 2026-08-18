'use strict';

/**
 * In-memory chat/message store fed by WhatsApp events.
 *
 * Bounded on both axes so a long-running background service does not grow
 * with chat history. Insertion order of the Map doubles as the recency list:
 * touching a chat re-inserts it at the end, so the first key is always the
 * least recently active and is what we evict.
 */
function createStore({ maxMessagesPerChat = 50, maxChats = 200 } = {}) {
  const chats = new Map();

  function touch(jid, name) {
    let chat = chats.get(jid);
    if (chat) {
      chats.delete(jid);
      if (name) chat.name = name;
    } else {
      chat = { jid, name: name || jid, unread: 0, lastMessageAt: 0, messages: [] };
    }
    chats.set(jid, chat);

    while (chats.size > maxChats) {
      chats.delete(chats.keys().next().value);
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
    return chat;
  }

  function markRead(jid) {
    const chat = chats.get(jid);
    if (chat) chat.unread = 0;
  }

  function listChats() {
    return [...chats.values()]
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
      .map(({ messages, ...meta }) => meta);
  }

  function getMessages(jid) {
    const chat = chats.get(jid);
    return chat ? chat.messages : [];
  }

  function totalUnread() {
    let total = 0;
    for (const chat of chats.values()) total += chat.unread;
    return total;
  }

  return { addMessage, markRead, listChats, getMessages, totalUnread };
}

module.exports = { createStore };
