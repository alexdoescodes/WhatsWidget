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

test('upsertChat records archive state without a message', () => {
  const store = createStore();
  store.upsertChat('a@s.whatsapp.net', { name: 'Laura', archived: true, lastMessageAt: 40 });
  const [chat] = store.listChats();
  assert.strictEqual(chat.name, 'Laura');
  assert.strictEqual(chat.archived, true);
  assert.strictEqual(chat.lastMessageAt, 40);
});

test('a partial update cannot blank a name an earlier event established', () => {
  const store = createStore();
  store.upsertChat('a@s.whatsapp.net', { name: 'Laura' });
  store.upsertChat('a@s.whatsapp.net', { archived: true });
  const [chat] = store.listChats();
  assert.strictEqual(chat.name, 'Laura');
  assert.strictEqual(chat.archived, true);
});

test('archived chats are excluded from the unread badge', () => {
  const store = createStore();
  store.addMessage('a@s.whatsapp.net', { id: '1', fromMe: false, text: 'hi', timestamp: 1 },
    { incrementUnread: true });
  store.addMessage('b@s.whatsapp.net', { id: '2', fromMe: false, text: 'yo', timestamp: 2 },
    { incrementUnread: true });
  assert.strictEqual(store.totalUnread(), 2);
  store.upsertChat('b@s.whatsapp.net', { archived: true });
  assert.strictEqual(store.totalUnread(), 1);
});

test('archiving survives a later message in that chat', () => {
  const store = createStore();
  store.upsertChat('a@s.whatsapp.net', { archived: true });
  store.addMessage('a@s.whatsapp.net', { id: '1', fromMe: false, text: 'hi', timestamp: 5 },
    { incrementUnread: true });
  const [chat] = store.listChats();
  assert.strictEqual(chat.archived, true);
});

test('eviction drops the least recently active chat, not the first inserted', () => {
  // History sync delivers newest first. Under the old insertion-order
  // eviction that made the newest chats the first ones thrown away.
  const store = createStore({ maxChats: 2 });
  store.upsertChat('newest@s.whatsapp.net', { lastMessageAt: 300 });
  store.upsertChat('middle@s.whatsapp.net', { lastMessageAt: 200 });
  store.upsertChat('oldest@s.whatsapp.net', { lastMessageAt: 100 });
  const jids = store.listChats().map((c) => c.jid);
  assert.deepStrictEqual(jids, ['newest@s.whatsapp.net', 'middle@s.whatsapp.net']);
});

test('a brand new chat is not evicted by its own zero timestamp', () => {
  const store = createStore({ maxChats: 1 });
  store.upsertChat('old@s.whatsapp.net', { lastMessageAt: 100 });
  store.addMessage('new@s.whatsapp.net', { id: '1', fromMe: false, text: 'hi', timestamp: 500 },
    { incrementUnread: true });
  const jids = store.listChats().map((c) => c.jid);
  assert.deepStrictEqual(jids, ['new@s.whatsapp.net']);
});

test('history sync order does not decide the preview', () => {
  // messaging-history.set delivers newest first.
  const store = createStore();
  store.addMessage('a@s.whatsapp.net', { id: '3', fromMe: false, text: 'july', timestamp: 300 });
  store.addMessage('a@s.whatsapp.net', { id: '2', fromMe: false, text: 'june', timestamp: 200 });
  store.addMessage('a@s.whatsapp.net', { id: '1', fromMe: false, text: 'may', timestamp: 100 });

  assert.deepStrictEqual(store.getMessages('a@s.whatsapp.net').map((m) => m.timestamp),
    [100, 200, 300], 'messages must be held oldest-last regardless of arrival order');
  assert.strictEqual(store.listChats()[0].lastMessageText, 'july');
});

test('the message cap discards the oldest, not the newest, out of order', () => {
  const store = createStore({ maxMessagesPerChat: 2 });
  store.addMessage('a@s.whatsapp.net', { id: '3', fromMe: false, text: 'newest', timestamp: 300 });
  store.addMessage('a@s.whatsapp.net', { id: '1', fromMe: false, text: 'oldest', timestamp: 100 });
  store.addMessage('a@s.whatsapp.net', { id: '2', fromMe: false, text: 'middle', timestamp: 200 });

  assert.deepStrictEqual(store.getMessages('a@s.whatsapp.net').map((m) => m.text),
    ['middle', 'newest']);
});

test('a message already held is not stored twice', () => {
  // After a re-pair the same message can arrive as history and again live.
  const store = createStore();
  const msg = { id: 'dup', fromMe: false, text: 'hi', timestamp: 10 };
  store.addMessage('a@s.whatsapp.net', msg, { incrementUnread: true });
  store.addMessage('a@s.whatsapp.net', { ...msg }, { incrementUnread: true });

  assert.strictEqual(store.getMessages('a@s.whatsapp.net').length, 1);
  assert.strictEqual(store.totalUnread(), 1, 'a duplicate must not inflate the badge');
});

test('a contact name reaches a chat that arrived before it', () => {
  const store = createStore();
  store.addMessage('a@s.whatsapp.net', { id: '1', fromMe: false, text: 'hi', timestamp: 1 });
  assert.strictEqual(store.listChats()[0].name, 'a@s.whatsapp.net');

  store.recordContactName('a@s.whatsapp.net', 'Laura');
  assert.strictEqual(store.listChats()[0].name, 'Laura');
});

test('a contact name is used by a chat that arrives after it', () => {
  const store = createStore();
  store.recordContactName('a@s.whatsapp.net', 'Laura');
  store.addMessage('a@s.whatsapp.net', { id: '1', fromMe: false, text: 'hi', timestamp: 1 });
  assert.strictEqual(store.listChats()[0].name, 'Laura');
});

test('recording a contact name does not create a chat', () => {
  const store = createStore();
  store.recordContactName('nobody@s.whatsapp.net', 'Someone');
  assert.strictEqual(store.listChats().length, 0,
    'the address book must not become the chat list');
});

test('a contact name never overwrites a real chat title', () => {
  const store = createStore();
  store.upsertChat('g@g.us', { name: 'Study Group' });
  store.recordContactName('g@g.us', 'Someone Else');
  assert.strictEqual(store.listChats()[0].name, 'Study Group');
});

test('a LID and a phone-number jid become one chat', () => {
  const store = createStore();
  store.addMessage('99@lid', { id: 'a', fromMe: false, text: 'from lid', timestamp: 10 },
    { incrementUnread: true });
  store.addMessage('99@s.whatsapp.net', { id: 'b', fromMe: true, text: 'from pn', timestamp: 20 });
  assert.strictEqual(store.listChats().length, 2, 'precondition: two chats for one person');

  store.linkIdentity('99@lid', '99@s.whatsapp.net');

  const chats = store.listChats();
  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].jid, '99@s.whatsapp.net', 'the phone-number form is canonical');
  assert.strictEqual(chats[0].unread, 1, 'unread is carried over, not dropped');
  assert.deepStrictEqual(store.getMessages('99@s.whatsapp.net').map((m) => m.text),
    ['from lid', 'from pn']);
});

test('a chat stays reachable by its old id after merging', () => {
  // The widget may still be holding the alias when the user clicks it.
  const store = createStore();
  store.addMessage('99@lid', { id: 'a', fromMe: false, text: 'hi', timestamp: 10 });
  store.linkIdentity('99@lid', '99@s.whatsapp.net');

  assert.strictEqual(store.getMessages('99@lid').length, 1);
  store.markRead('99@lid');
  assert.strictEqual(store.totalUnread(), 0);
});

test('a later message on either id lands in the same chat', () => {
  // This is the "answering from my phone opens a new chat" symptom.
  const store = createStore();
  store.linkIdentity('99@lid', '99@s.whatsapp.net');
  store.addMessage('99@lid', { id: 'a', fromMe: false, text: 'them', timestamp: 10 });
  store.addMessage('99@s.whatsapp.net', { id: 'b', fromMe: true, text: 'me', timestamp: 20 });

  assert.strictEqual(store.listChats().length, 1);
  assert.strictEqual(store.getMessages('99@lid').length, 2);
});

test('merging keeps the better of the two names', () => {
  const store = createStore();
  store.upsertChat('99@lid', { name: 'Laura' });
  store.addMessage('99@s.whatsapp.net', { id: 'b', fromMe: false, text: 'hi', timestamp: 1 });
  store.linkIdentity('99@lid', '99@s.whatsapp.net');

  assert.strictEqual(store.listChats()[0].name, 'Laura');
});

test('aliases survive a restart', () => {
  const store = createStore();
  store.linkIdentity('99@lid', '99@s.whatsapp.net');
  const revived = createStore();
  revived.restore(JSON.parse(JSON.stringify(store.snapshot())));

  assert.strictEqual(revived.canonical('99@lid'), '99@s.whatsapp.net');
});

test('a message you sent does not rename the chat after you', () => {
  // pushName on an outgoing message is the user's own name.
  const store = createStore();
  store.upsertChat('x@s.whatsapp.net', { name: 'Laura' });
  store.addMessage('x@s.whatsapp.net',
    { id: '1', fromMe: true, text: 'hi', timestamp: 1 }, { name: 'Alex' });

  assert.strictEqual(store.listChats()[0].name, 'Laura');
});

test('a group keeps its subject when someone speaks in it', () => {
  const store = createStore();
  store.upsertChat('g@g.us', { name: 'Study Group' });
  store.addMessage('g@g.us',
    { id: '1', fromMe: false, text: 'hi', timestamp: 1 }, { name: 'Marc' });

  assert.strictEqual(store.listChats()[0].name, 'Study Group');
});

test('a pushName still names an otherwise unknown number', () => {
  const store = createStore();
  store.addMessage('x@s.whatsapp.net',
    { id: '1', fromMe: false, text: 'hi', timestamp: 1 }, { name: 'Laura' });

  assert.strictEqual(store.listChats()[0].name, 'Laura');
});

test('a contact name replaces a name guessed from a pushName', () => {
  const store = createStore();
  store.addMessage('x@s.whatsapp.net',
    { id: '1', fromMe: false, text: 'hi', timestamp: 1 }, { name: 'Laura' });
  store.recordContactName('x@s.whatsapp.net', 'Laura Schmidt');
  assert.strictEqual(store.listChats()[0].name, 'Laura Schmidt');

  // ...and a later pushName cannot undo it.
  store.addMessage('x@s.whatsapp.net',
    { id: '2', fromMe: false, text: 'yo', timestamp: 2 }, { name: 'Laura' });
  assert.strictEqual(store.listChats()[0].name, 'Laura Schmidt');
});

test('name provenance survives a restart', () => {
  const store = createStore();
  store.addMessage('x@s.whatsapp.net',
    { id: '1', fromMe: false, text: 'hi', timestamp: 1 }, { name: 'Laura' });

  const revived = createStore();
  revived.restore(JSON.parse(JSON.stringify(store.snapshot())));
  revived.recordContactName('x@s.whatsapp.net', 'Laura Schmidt');

  assert.strictEqual(revived.listChats()[0].name, 'Laura Schmidt',
    'a weak name must still be replaceable after a reload');
});

test('names from a v1 cache are correctable, since some are the wrong person', () => {
  const store = createStore();
  const legacy = {
    version: 1,
    chats: [{ jid: 'x@s.whatsapp.net', name: 'Alex', unread: 0, lastMessageAt: 5, messages: [] }],
    contactNames: [],
  };
  assert.ok(store.restore(legacy));
  assert.strictEqual(store.listChats()[0].name, 'Alex');

  store.recordContactName('x@s.whatsapp.net', 'Laura');
  assert.strictEqual(store.listChats()[0].name, 'Laura');
});

test('names from a v2 cache are trusted and not overwritten', () => {
  const store = createStore();
  store.upsertChat('g@g.us', { name: 'Study Group' });
  const revived = createStore();
  revived.restore(JSON.parse(JSON.stringify(store.snapshot())));

  revived.recordContactName('g@g.us', 'Someone Else');
  assert.strictEqual(revived.listChats()[0].name, 'Study Group');
});

test('a chat titled with the account holder own name is undone', () => {
  const store = createStore();
  store.addMessage('x@s.whatsapp.net',
    { id: '1', fromMe: false, text: 'hi', timestamp: 1 }, { name: 'Alex' });
  assert.strictEqual(store.listChats()[0].name, 'Alex');

  assert.strictEqual(store.forgetWeakName('Alex'), 1);
  assert.strictEqual(store.listChats()[0].name, 'x@s.whatsapp.net');
});

test('forgetting a weak name falls back to a known contact name', () => {
  const store = createStore();
  store.addMessage('x@s.whatsapp.net',
    { id: '1', fromMe: false, text: 'hi', timestamp: 1 }, { name: 'Alex' });
  store.recordContactName('y@s.whatsapp.net', 'unrelated');
  store.restore({
    version: 1,
    chats: [{ jid: 'x@s.whatsapp.net', name: 'Alex', messages: [] }],
    contactNames: [['x@s.whatsapp.net', 'Laura']],
  });

  store.forgetWeakName('Alex');
  assert.strictEqual(store.listChats()[0].name, 'Laura');
});

test('a strong name matching the user own name is left alone', () => {
  // Someone can genuinely be saved under the same name as the user.
  const store = createStore();
  store.upsertChat('x@s.whatsapp.net', { name: 'Alex' });
  assert.strictEqual(store.forgetWeakName('Alex'), 0);
  assert.strictEqual(store.listChats()[0].name, 'Alex');
});
