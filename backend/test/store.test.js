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

test('lists the last message as a preview, with its direction', () => {
  const s = createStore({ maxMessagesPerChat: 10, maxChats: 10 });
  s.addMessage('a', { id: 1, fromMe: false, text: 'first', timestamp: 1 });
  s.addMessage('a', { id: 2, fromMe: true, text: 'last one', timestamp: 2 });
  s.addMessage('b', { id: 3, fromMe: false, text: 'theirs', timestamp: 3 });
  const [b, a] = s.listChats();
  assert.strictEqual(a.lastMessageText, 'last one');
  assert.strictEqual(a.lastMessageFromMe, true);
  assert.strictEqual(b.lastMessageText, 'theirs');
  assert.strictEqual(b.lastMessageFromMe, false);
  // Still a preview, not the history: the bodies do not come along.
  assert.strictEqual(a.messages, undefined);
});

test('the preview follows the message cap rather than the evicted head', () => {
  const s = createStore({ maxMessagesPerChat: 2, maxChats: 10 });
  for (let i = 1; i <= 4; i += 1) {
    s.addMessage('a', { id: i, fromMe: false, text: `m${i}`, timestamp: i });
  }
  assert.strictEqual(s.listChats()[0].lastMessageText, 'm4');
  assert.strictEqual(s.getMessages('a').length, 2);
});
