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

  // Alias -> canonical jid. WhatsApp addresses one person two ways: a
  // phone-number jid (@s.whatsapp.net) and an anonymised LID (@lid). Left
  // alone they become two chats for the same conversation, and answering from
  // the phone appears to open a brand new one.
  const aliases = new Map();

  /** The id a conversation is actually filed under. */
  function canonical(jid) {
    return aliases.get(jid) || jid;
  }

  /**
   * Declare that two ids are the same person, and fold together anything
   * already filed under both.
   *
   * The phone-number form wins as canonical: it is what contact names, group
   * participant lists and the user's own intuition are keyed by, whereas a LID
   * is opaque.
   */
  function linkIdentity(a, b) {
    if (!a || !b || a === b) return false;
    const primary = b.endsWith('@lid') ? a : b;
    const alias = primary === a ? b : a;
    if (aliases.get(alias) === primary) return false;

    aliases.set(alias, primary);
    revision += 1;

    const from = chats.get(alias);
    if (!from) return true;
    chats.delete(alias);

    const into = chats.get(primary);
    if (!into) {
      // Nothing to merge with: refile it under the canonical id.
      from.jid = primary;
      chats.set(primary, from);
      return true;
    }

    for (const message of from.messages) addMessage(primary, message);
    into.unread += from.unread;
    into.archived = into.archived || from.archived;
    if (from.lastMessageAt > into.lastMessageAt) into.lastMessageAt = from.lastMessageAt;
    if (into.name === primary && from.name !== alias) into.name = from.name;
    return true;
  }

  function recordContactName(jid, name) {
    if (!jid || !name) return;
    if (contactNames.get(jid) === name) return;
    revision += 1;
    contactNames.set(jid, name);
    // Apply it to a conversation that arrived before the name did and is
    // still falling back to showing a raw address.
    const chat = chats.get(canonical(jid));
    if (chat && (chat.name === chat.jid || chat.nameWeak)) {
      chat.name = name;
      chat.nameWeak = false;
    }
  }

  // Only ever called when the store is over capacity, which for the live
  // message path means once per message while full, and for a bulk history
  // load means once for the whole batch.
  function prune() {
    if (chats.size <= maxChats) return;
    const ordered = [...chats.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    for (const chat of ordered.slice(maxChats)) chats.delete(chat.jid);
  }

  /**
   * Find or create a chat, applying a display name by strength.
   *
   * A "weak" name is a pushName off a message: the name of whoever *sent*
   * it. That is the right fallback for an unknown number and wrong for
   * everything else -- on a message you sent it is your own name, and in a
   * group it is the last person who spoke, either of which would otherwise
   * rename the conversation out from under a real contact name or group
   * subject. Weak names may fill a blank or replace another weak name; only a
   * strong name (contact, group subject, sync) can overwrite a strong one.
   */
  function touch(rawJid, name, { weak = false } = {}) {
    const jid = canonical(rawJid);
    let chat = chats.get(jid);

    if (!chat) {
      const known = contactNames.get(jid);
      chat = {
        jid,
        name: known || name || jid,
        // A name from the contact registry is strong; one passed in here is
        // only as strong as its caller claims.
        nameWeak: known ? false : Boolean(name) && weak,
        unread: 0,
        lastMessageAt: 0,
        archived: false,
        messages: [],
      };
      chats.set(jid, chat);
      return chat;
    }

    if (name) {
      const unnamed = chat.name === chat.jid;
      if (!weak) {
        chat.name = name;
        chat.nameWeak = false;
      } else if (unnamed || chat.nameWeak) {
        chat.name = name;
        chat.nameWeak = true;
      }
    }
    return chat;
  }

  function addMessage(jid, message, { incrementUnread = false, name } = {}) {
    const chat = touch(jid, name, { weak: true });

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

  function markRead(rawJid) {
    const chat = chats.get(canonical(rawJid));
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

  function getMessages(rawJid) {
    const chat = chats.get(canonical(rawJid));
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
   * Drop a display name that was only ever a guess, wherever it was guessed.
   *
   * Used to undo chats titled with the account holder's own name: a pushName
   * from an outgoing message, which older builds accepted. Strong names are
   * left alone -- someone really can be saved in the address book under the
   * same name as the user.
   */
  function forgetWeakName(name) {
    if (!name) return 0;
    let cleared = 0;
    for (const chat of chats.values()) {
      if (!chat.nameWeak || chat.name !== name) continue;
      chat.name = contactNames.get(chat.jid) || chat.jid;
      chat.nameWeak = false;
      cleared += 1;
    }
    if (cleared > 0) revision += 1;
    return cleared;
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
      version: 2,
      chats: [...chats.values()],
      contactNames: [...contactNames.entries()],
      aliases: [...aliases.entries()],
    };
  }

  /**
   * Replace the contents from a snapshot, re-applying both caps.
   *
   * Version 1 predates name provenance. Its names were written by a store
   * that let any pushName overwrite the chat title, so some of them are the
   * last sender rather than the conversation -- including the user's own name
   * on chats they wrote to. They cannot be told apart after the fact, so they
   * all come back weak and the first real contact name or group subject
   * corrects them.
   */
  function restore(data) {
    if (!data || !Array.isArray(data.chats)) return false;
    if (data.version !== 1 && data.version !== 2) return false;
    const namesUntrusted = data.version === 1;

    chats.clear();
    contactNames.clear();
    aliases.clear();

    for (const entry of data.aliases || []) {
      if (Array.isArray(entry) && entry[0] && entry[1]) aliases.set(entry[0], entry[1]);
    }

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
        nameWeak: namesUntrusted ? true : chat.nameWeak === true,
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
    forgetWeakName,
    linkIdentity,
    canonical,
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
