'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');

const msg = (id, timestamp, fromMe = false) => ({ id, fromMe, text: `m${id}`, timestamp });

test('keeps only the most recent N messages per chat', () => {
  const s = createStore({ maxMessagesPerChat: 3, maxChats: 10 });
  for (let i = 1; i <= 5; i += 1) s.addMessage('a@s.whatsapp.net', msg(i, i));
  const kept = s.getMessages('a@s.whatsapp.net').map((m) => m.id);
  assert.deepStrictEqual(kept, [3, 4, 5]);
});

test('evicts the least recently active chat past the chat cap', () => {
  const s = createStore({ maxMessagesPerChat: 10, maxChats: 2 });
  s.addMessage('a', msg(1, 1));
  s.addMessage('b', msg(2, 2));
  s.addMessage('c', msg(3, 3));
  const jids = s.listChats().map((c) => c.jid).sort();
  assert.deepStrictEqual(jids, ['b', 'c']);
});

test('counts unread only when told to, and clears on markRead', () => {
  const s = createStore({ maxMessagesPerChat: 10, maxChats: 10 });
  s.addMessage('a', msg(1, 1), { incrementUnread: true });
  s.addMessage('a', msg(2, 2), { incrementUnread: true });
  s.addMessage('a', msg(3, 3, true), { incrementUnread: false });
  assert.strictEqual(s.totalUnread(), 2);
  s.markRead('a');
  assert.strictEqual(s.totalUnread(), 0);
});

test('lists chats newest first and omits message bodies', () => {
  const s = createStore({ maxMessagesPerChat: 10, maxChats: 10 });
  s.addMessage('old', msg(1, 100));
  s.addMessage('new', msg(2, 200));
  const chats = s.listChats();
  assert.deepStrictEqual(chats.map((c) => c.jid), ['new', 'old']);
  assert.strictEqual(chats[0].messages, undefined);
});

test('markRead on an unknown chat does not throw', () => {
  const s = createStore({ maxMessagesPerChat: 10, maxChats: 10 });
  assert.doesNotThrow(() => s.markRead('nope'));
});
