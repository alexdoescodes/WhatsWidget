# WhatsApp Desktop Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a KDE Plasma 6 widget giving a persistent mini WhatsApp chat panel, with a privacy hide-mode that requires the user's login password to reveal after a configurable delay.

**Architecture:** A Node.js backend owns the WhatsApp connection (Baileys) and PAM password verification, exposing a loopback-TCP HTTP+WebSocket API guarded by a bearer token. A QML Plasmoid renders state and calls that API — it never touches the WhatsApp protocol directly. Everything is event-driven (no polling) to keep laptop idle cost near zero.

**Tech Stack:** Node.js 20 (CommonJS), `baileys@6.7.24`, `authenticate-pam@1.0.5`, `qrcode@1.5.4`, `ws@8.21.3`, `node:test` for tests. QML / Qt 6 / Plasma 6.7.2, `QtWebSockets`, `QtQuick.Effects`, `Qt.labs.platform`.

**Spec:** `docs/superpowers/specs/2026-08-18-whatsapp-widget-design.md`

## Global Constraints

- **Pin `baileys` to exactly `6.7.24`.** The `latest` tag is `7.0.0-rc14` (a release candidate pulling a `whatsapp-rust-bridge` native dep). Never use `^` or `latest` for this dependency.
- **No polling anywhere.** Backend→WhatsApp and widget→backend are both event/push driven. No `setInterval` for status, chats, unread, or the unlock countdown.
- **PAM service name is `whatsapp-widget`** (`/etc/pam.d/whatsapp-widget`). Never authenticate against `login`, `system-auth`, or `kscreenlocker` — the first two carry `pam_faillock` (deny=3, 10-min lockout of the real account) and the third delegates to a Howdy script that does not exist on this system.
- **The password is never logged, persisted, echoed, or written to disk** — in backend, QML, or systemd logs.
- **All backend HTTP/WS access requires `Authorization: Bearer <token>`** and a loopback peer address. The token lives in a `0600` endpoint file.
- **Store bounds:** 50 messages per chat, 200 chats max.
- Node built-in test runner only (`node --test`). Do not add a test framework dependency.
- Target Plasma 6 APIs (`PlasmoidItem`, `import org.kde.plasma.plasmoid`). No Plasma 5 compatibility shims.
- Verified paths/tools on this machine: `kpackagetool6` present; `plasmoidviewer` **absent** (ships in `plasma-sdk`); `unix_chkpwd` present and setuid; PAM headers present; GCC 16 present.

---

### Task 1: Backend scaffolding and config module

**Files:**
- Create: `backend/package.json`
- Create: `backend/.gitignore`
- Create: `backend/src/config.js`
- Test: `backend/test/config.test.js`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `buildConfig(env, homedir, uid) -> { dataDir, sessionDir, endpointFile, pamService, maxMessagesPerChat, maxChats }`, all string/number fields. Every later backend task imports this.

- [ ] **Step 1: Create `backend/package.json`**

```json
{
  "name": "whatsapp-widget-backend",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "authenticate-pam": "1.0.5",
    "baileys": "6.7.24",
    "qrcode": "1.5.4",
    "ws": "8.21.3"
  }
}
```

- [ ] **Step 2: Create `backend/.gitignore`**

```gitignore
node_modules/
```

- [ ] **Step 3: Install dependencies**

Run: `cd backend && npm install`
Expected: completes with no build errors. `authenticate-pam` compiles a native addon; confirm `backend/node_modules/authenticate-pam/build/Release/authenticate_pam.node` exists afterwards.

- [ ] **Step 4: Write the failing test — `backend/test/config.test.js`**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildConfig } = require('../src/config');

test('honours XDG_DATA_HOME for session storage', () => {
  const c = buildConfig({ XDG_DATA_HOME: '/xdg/data', XDG_RUNTIME_DIR: '/run/user/9' }, '/home/u', 9);
  assert.strictEqual(c.sessionDir, '/xdg/data/whatsapp-widget/session');
});

test('falls back to ~/.local/share when XDG_DATA_HOME is unset', () => {
  const c = buildConfig({ XDG_RUNTIME_DIR: '/run/user/9' }, '/home/u', 9);
  assert.strictEqual(c.sessionDir, '/home/u/.local/share/whatsapp-widget/session');
});

test('derives the runtime dir from uid when XDG_RUNTIME_DIR is unset', () => {
  const c = buildConfig({}, '/home/u', 9);
  assert.strictEqual(c.endpointFile, '/run/user/9/whatsapp-widget-endpoint.json');
});

test('pins the dedicated PAM service name and store bounds', () => {
  const c = buildConfig({}, '/home/u', 9);
  assert.strictEqual(c.pamService, 'whatsapp-widget');
  assert.strictEqual(c.maxMessagesPerChat, 50);
  assert.strictEqual(c.maxChats, 200);
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd backend && node --test test/config.test.js`
Expected: FAIL — `Cannot find module '../src/config'`

- [ ] **Step 6: Write `backend/src/config.js`**

```js
'use strict';

const os = require('node:os');
const path = require('node:path');

/**
 * Resolve all filesystem locations and tunables from the environment.
 * Written as a factory (rather than reading process.env at module load)
 * so tests can drive it without mutating the real environment.
 */
function buildConfig(env = process.env, homedir = os.homedir(), uid = process.getuid()) {
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const dataHome = env.XDG_DATA_HOME || path.join(homedir, '.local', 'share');
  const dataDir = path.join(dataHome, 'whatsapp-widget');

  return {
    dataDir,
    sessionDir: path.join(dataDir, 'session'),
    endpointFile: path.join(runtimeDir, 'whatsapp-widget-endpoint.json'),
    // Dedicated PAM service: see plan Global Constraints. Never 'login'.
    pamService: 'whatsapp-widget',
    maxMessagesPerChat: 50,
    maxChats: 200,
  };
}

module.exports = { buildConfig };
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd backend && node --test test/config.test.js`
Expected: PASS — 4 tests

- [ ] **Step 8: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/.gitignore backend/src/config.js backend/test/config.test.js
git commit -m "feat(backend): scaffold project and add config module"
```

---

### Task 2: Bounded chat/message store

Baileys 6.7.24 no longer exports `makeInMemoryStore` (verified — it was removed upstream), so the backend keeps its own. Bounding it is what keeps idle memory flat.

**Files:**
- Create: `backend/src/store.js`
- Test: `backend/test/store.test.js`

**Interfaces:**
- Consumes: `buildConfig` bounds from Task 1 (`maxMessagesPerChat`, `maxChats`)
- Produces: `createStore({ maxMessagesPerChat, maxChats }) -> store` with methods:
  - `addMessage(jid, message, { incrementUnread, name }) -> chat`
  - `markRead(jid) -> void`
  - `listChats() -> Array<{ jid, name, unread, lastMessageAt }>` (newest first, no `messages` key)
  - `getMessages(jid) -> Array<message>`
  - `totalUnread() -> number`
  - A `message` is `{ id, fromMe, text, timestamp }` with `timestamp` in seconds.

- [ ] **Step 1: Write the failing test — `backend/test/store.test.js`**

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test test/store.test.js`
Expected: FAIL — `Cannot find module '../src/store'`

- [ ] **Step 3: Write `backend/src/store.js`**

```js
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

  return { addMessage, markRead, listChats, getMessages, totalUnread, touch };
}

module.exports = { createStore };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test test/store.test.js`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/store.js backend/test/store.test.js
git commit -m "feat(backend): add bounded chat and message store"
```

---

### Task 3: PAM service file and installer

This is the one task that touches system state. It must be reviewed on its own.

**Files:**
- Create: `packaging/pam/whatsapp-widget`
- Create: `packaging/install-pam.sh`
- Create: `backend/tools/check-pam.js`

**Interfaces:**
- Consumes: `buildConfig().pamService` from Task 1
- Produces: a working `/etc/pam.d/whatsapp-widget` service that Task 4's authenticator authenticates against.

- [ ] **Step 1: Create `packaging/pam/whatsapp-widget`**

```
#%PAM-1.0
# Password verification for the WhatsApp widget's privacy unlock.
#
# Deliberately does NOT include pam_faillock. The general-purpose services on
# this system (login -> system-local-login -> system-auth) do include it, and
# with no /etc/faillock.conf the defaults apply: 3 failures locks the real user
# account for 10 minutes. A mistyped password in a chat widget must never be
# able to lock the user out of their own machine.
#
# Brute-force protection is enforced by the widget backend instead, as
# exponential backoff (see backend/src/auth-pam.js).
auth     required   pam_unix.so
account  required   pam_unix.so
```

- [ ] **Step 2: Create `packaging/install-pam.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/pam/whatsapp-widget"
DEST=/etc/pam.d/whatsapp-widget

if [[ ! -f "$SRC" ]]; then
  echo "error: missing source file $SRC" >&2
  exit 1
fi

if [[ -e "$DEST" ]]; then
  echo "note: $DEST already exists; showing what would change:"
  diff -u "$DEST" "$SRC" || true
fi

echo "Installing $DEST (requires sudo)..."
sudo install -m 0644 -o root -g root "$SRC" "$DEST"
echo "Installed. Verify with: node backend/tools/check-pam.js"
```

- [ ] **Step 3: Make it executable and run it**

```bash
chmod +x packaging/install-pam.sh
./packaging/install-pam.sh
```

Expected: prints `Installed.` after a sudo prompt. This is the only step in the whole plan requiring root.

- [ ] **Step 4: Create the manual verification tool `backend/tools/check-pam.js`**

This is interactive by nature — PAM verification cannot be meaningfully unit-tested against a real password, so it gets a hands-on check instead.

```js
'use strict';

/**
 * Manual check: confirms the dedicated PAM service can verify this user's
 * real login password. Run directly; the password is read from a hidden
 * prompt and never stored, logged, or echoed.
 */
const os = require('node:os');
const readline = require('node:readline');
const pam = require('authenticate-pam');
const { buildConfig } = require('../src/config');

const config = buildConfig();
const username = os.userInfo().username;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

// Suppress echo while the password is typed.
const onKeypress = () => { rl.output.write('[2K[200D' + `Password for ${username}: `); };

rl.question(`Password for ${username}: `, (password) => {
  rl.input.removeListener('data', onKeypress);
  rl.close();
  process.stdout.write('\n');

  pam.authenticate(username, password, (err) => {
    if (err) {
      console.error(`FAIL: ${err}`);
      process.exit(1);
    }
    console.log(`OK: PAM service '${config.pamService}' verified the password.`);
    process.exit(0);
  }, { serviceName: config.pamService });
});

rl.input.on('data', onKeypress);
```

- [ ] **Step 5: Verify with the real password**

Run: `cd backend && node tools/check-pam.js`
Enter the correct login password.
Expected: `OK: PAM service 'whatsapp-widget' verified the password.`

Then run it again with a deliberately wrong password.
Expected: `FAIL: ...` — and crucially, running `faillock --user "$USER"` afterwards should show **no** recorded failures, proving the dedicated service bypasses the lockout counter.

- [ ] **Step 6: Commit**

```bash
git add packaging/pam/whatsapp-widget packaging/install-pam.sh backend/tools/check-pam.js
git commit -m "feat(packaging): add dedicated PAM service and verification tool"
```

---

### Task 4: PAM authenticator with exponential backoff

**Files:**
- Create: `backend/src/auth-pam.js`
- Test: `backend/test/auth-pam.test.js`

**Interfaces:**
- Consumes: `config.pamService` (Task 1); `/etc/pam.d/whatsapp-widget` (Task 3)
- Produces: `createAuthenticator({ service, username, pamAuthenticate, now, maxDelayMs }) -> { verify, throttleState }`
  - `verify(password) -> Promise<{ ok: true } | { ok: false, reason: 'invalid'|'throttled', retryAfterMs: number }>`
  - `throttleState(atMs) -> { allowed: boolean, retryAfterMs: number }`
  - `pamAuthenticate` and `now` are injectable purely for tests; production uses the real ones.

- [ ] **Step 1: Write the failing test — `backend/test/auth-pam.test.js`**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createAuthenticator } = require('../src/auth-pam');

function harness({ accept }) {
  let clock = 0;
  const calls = [];
  const auth = createAuthenticator({
    service: 'whatsapp-widget',
    username: 'tester',
    now: () => clock,
    pamAuthenticate: (user, password, cb, opts) => {
      calls.push({ user, password, opts });
      cb(accept(password) ? null : new Error('auth failed'));
    },
  });
  return { auth, calls, advance: (ms) => { clock += ms; } };
}

test('accepts the correct password and passes the dedicated service name', async () => {
  const { auth, calls } = harness({ accept: (p) => p === 'right' });
  const result = await auth.verify('right');
  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(calls[0].opts.serviceName, 'whatsapp-widget');
  assert.strictEqual(calls[0].user, 'tester');
});

test('rejects a wrong password and blocks the immediate retry', async () => {
  const { auth } = harness({ accept: (p) => p === 'right' });
  const first = await auth.verify('wrong');
  assert.strictEqual(first.ok, false);
  assert.strictEqual(first.reason, 'invalid');
  assert.strictEqual(first.retryAfterMs, 2000);

  const second = await auth.verify('right');
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'throttled');
});

test('backoff grows exponentially and is capped', async () => {
  const { auth, advance } = harness({ accept: () => false });
  const delays = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await auth.verify('wrong');
    delays.push(r.retryAfterMs);
    advance(r.retryAfterMs);
  }
  assert.deepStrictEqual(delays, [2000, 4000, 8000, 16000, 30000, 30000]);
});

test('a success resets the backoff', async () => {
  const { auth, advance } = harness({ accept: (p) => p === 'right' });
  const failed = await auth.verify('wrong');
  advance(failed.retryAfterMs);
  assert.deepStrictEqual(await auth.verify('right'), { ok: true });

  const again = await auth.verify('wrong');
  assert.strictEqual(again.retryAfterMs, 2000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test test/auth-pam.test.js`
Expected: FAIL — `Cannot find module '../src/auth-pam'`

- [ ] **Step 3: Write `backend/src/auth-pam.js`**

```js
'use strict';

const os = require('node:os');
const pam = require('authenticate-pam');

/**
 * Verifies the user's real login password through PAM.
 *
 * The dedicated 'whatsapp-widget' PAM service intentionally omits
 * pam_faillock so widget mistakes cannot lock the system account. The
 * brute-force protection that gives up is replaced here by exponential
 * backoff held purely in memory.
 */
function createAuthenticator({
  service,
  username = os.userInfo().username,
  pamAuthenticate = pam.authenticate,
  now = Date.now,
  maxDelayMs = 30000,
} = {}) {
  let failures = 0;
  let blockedUntil = 0;

  function throttleState(at = now()) {
    if (at < blockedUntil) return { allowed: false, retryAfterMs: blockedUntil - at };
    return { allowed: true, retryAfterMs: 0 };
  }

  async function verify(password) {
    const state = throttleState();
    if (!state.allowed) {
      return { ok: false, reason: 'throttled', retryAfterMs: state.retryAfterMs };
    }

    const ok = await new Promise((resolve) => {
      pamAuthenticate(username, password, (err) => resolve(!err), { serviceName: service });
    });

    if (ok) {
      failures = 0;
      blockedUntil = 0;
      return { ok: true };
    }

    failures += 1;
    const retryAfterMs = Math.min(2 ** failures * 1000, maxDelayMs);
    blockedUntil = now() + retryAfterMs;
    return { ok: false, reason: 'invalid', retryAfterMs };
  }

  return { verify, throttleState };
}

module.exports = { createAuthenticator };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test test/auth-pam.test.js`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth-pam.js backend/test/auth-pam.test.js
git commit -m "feat(backend): add PAM authenticator with exponential backoff"
```

---

### Task 5: WhatsApp client wrapper

**Files:**
- Create: `backend/src/whatsapp.js`
- Test: `backend/test/whatsapp.test.js`

**Interfaces:**
- Consumes: `config.sessionDir` (Task 1); store from Task 2
- Produces: `createWhatsAppClient({ sessionDir, store, makeSocket, authState, qrToBuffer, reconnectDelayMs }) -> client`
  - `client.events` — an `EventEmitter` emitting `'status'` (payload: status string) and `'message'` (payload: `{ jid, message }`)
  - `client.getStatus() -> 'connecting'|'needs-pairing'|'connected'|'disconnected'`
  - `client.getQrPng() -> Buffer|null`
  - `client.start() -> Promise<void>`
  - `client.sendMessage(jid, text) -> Promise<void>`
  - `extractText(waMessage) -> string` (exported for tests)

- [ ] **Step 1: Write the failing test — `backend/test/whatsapp.test.js`**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createWhatsAppClient, extractText } = require('../src/whatsapp');
const { createStore } = require('../src/store');

function fakeSocket() {
  const ev = new EventEmitter();
  return { ev, sendMessage: async () => {}, sent: [] };
}

function build({ store = createStore({}) } = {}) {
  const sock = fakeSocket();
  const client = createWhatsAppClient({
    sessionDir: '/tmp/unused',
    store,
    makeSocket: () => sock,
    authState: async () => ({ state: {}, saveCreds: async () => {} }),
    qrToBuffer: async (text) => Buffer.from(`png:${text}`),
    reconnectDelayMs: 0,
  });
  return { client, sock, store };
}

test('starts in connecting and reports needs-pairing with a QR image', async () => {
  const { client, sock } = build();
  assert.strictEqual(client.getStatus(), 'connecting');
  await client.start();

  sock.ev.emit('connection.update', { qr: 'QRDATA' });
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(client.getStatus(), 'needs-pairing');
  assert.strictEqual(client.getQrPng().toString(), 'png:QRDATA');
});

test('clears the QR once the connection opens', async () => {
  const { client, sock } = build();
  await client.start();
  sock.ev.emit('connection.update', { qr: 'QRDATA' });
  await new Promise((r) => setImmediate(r));
  sock.ev.emit('connection.update', { connection: 'open' });

  assert.strictEqual(client.getStatus(), 'connected');
  assert.strictEqual(client.getQrPng(), null);
});

test('emits status changes exactly once per transition', async () => {
  const { client, sock } = build();
  const seen = [];
  client.events.on('status', (s) => seen.push(s));
  await client.start();

  sock.ev.emit('connection.update', { connection: 'open' });
  sock.ev.emit('connection.update', { connection: 'open' });

  assert.deepStrictEqual(seen, ['connected']);
});

test('stores an incoming message and counts it unread', async () => {
  const { client, sock, store } = build();
  await client.start();

  sock.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{
      key: { id: 'M1', remoteJid: 'friend@s.whatsapp.net', fromMe: false },
      pushName: 'Friend',
      messageTimestamp: 1700000000,
      message: { conversation: 'hello there' },
    }],
  });

  const chats = store.listChats();
  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].name, 'Friend');
  assert.strictEqual(chats[0].unread, 1);
  assert.strictEqual(store.getMessages('friend@s.whatsapp.net')[0].text, 'hello there');
});

test('does not count our own outgoing messages as unread', async () => {
  const { client, sock, store } = build();
  await client.start();

  sock.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{
      key: { id: 'M2', remoteJid: 'friend@s.whatsapp.net', fromMe: true },
      messageTimestamp: 1700000001,
      message: { conversation: 'my reply' },
    }],
  });

  assert.strictEqual(store.totalUnread(), 0);
});

test('extractText handles plain and extended text, and unsupported kinds', () => {
  assert.strictEqual(extractText({ conversation: 'a' }), 'a');
  assert.strictEqual(extractText({ extendedTextMessage: { text: 'b' } }), 'b');
  assert.strictEqual(extractText({ imageMessage: { caption: 'c' } }), 'c');
  assert.strictEqual(extractText({ stickerMessage: {} }), '[unsupported message]');
  assert.strictEqual(extractText(null), '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test test/whatsapp.test.js`
Expected: FAIL — `Cannot find module '../src/whatsapp'`

- [ ] **Step 3: Write `backend/src/whatsapp.js`**

```js
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
    store.addMessage(jid, {
      id: `local-${Date.now()}`,
      fromMe: true,
      text,
      timestamp: Math.floor(Date.now() / 1000),
    }, { incrementUnread: false });
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test test/whatsapp.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/whatsapp.js backend/test/whatsapp.test.js
git commit -m "feat(backend): add Baileys client wrapper"
```

---

### Task 6: Token-guarded HTTP and WebSocket server

**Files:**
- Create: `backend/src/server.js`
- Test: `backend/test/server.test.js`

**Interfaces:**
- Consumes: store (Task 2), authenticator (Task 4), client (Task 5), `config.endpointFile` (Task 1)
- Produces: `createServer({ client, store, authenticator, endpointFile }) -> { listen, close, token, port, url }`
  - `listen() -> Promise<{ port, token }>` — binds 127.0.0.1:0 and writes the endpoint file `0600`
  - `close() -> Promise<void>` — removes the endpoint file
  - Routes (all require `Authorization: Bearer <token>`):
    - `GET /status` → `{ status, unread }`
    - `GET /qr` → `image/png`, or 404 when not pairing
    - `GET /chats` → `{ chats: [...] }`
    - `GET /chats/:jid/messages` → `{ messages: [...] }`
    - `POST /chats/:jid/messages` body `{ text }` → 204
    - `POST /chats/:jid/read` → 204
    - `POST /unlock` body `{ password }` → `{ ok }` or 429 with `{ retryAfterMs }`
    - `GET /events` (WebSocket) → pushes `{ type: 'status'|'message'|'unread', ... }`

- [ ] **Step 1: Write the failing test — `backend/test/server.test.js`**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createServer } = require('../src/server');
const { createStore } = require('../src/store');

function build({ verify = async () => ({ ok: true }) } = {}) {
  const store = createStore({});
  const events = new EventEmitter();
  const client = {
    events,
    getStatus: () => 'connected',
    getQrPng: () => null,
    sendMessage: async (jid, text) => { client.sent = { jid, text }; },
  };
  const endpointFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ww-')), 'endpoint.json');
  const server = createServer({ client, store, authenticator: { verify }, endpointFile });
  return { server, store, client, events, endpointFile };
}

const get = (server, route, token) => fetch(`http://127.0.0.1:${server.port}${route}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
});

test('rejects requests with no token', async () => {
  const { server, endpointFile } = build();
  await server.listen();
  const res = await get(server, '/status');
  assert.strictEqual(res.status, 401);
  await server.close();
  assert.strictEqual(fs.existsSync(endpointFile), false);
});

test('rejects requests with a wrong token', async () => {
  const { server } = build();
  await server.listen();
  const res = await get(server, '/status', 'not-the-token');
  assert.strictEqual(res.status, 401);
  await server.close();
});

test('serves status with a valid token', async () => {
  const { server } = build();
  const { token } = await server.listen();
  const res = await get(server, '/status', token);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { status: 'connected', unread: 0 });
  await server.close();
});

test('writes the endpoint file 0600 with port and token', async () => {
  const { server, endpointFile } = build();
  const { token, port } = await server.listen();
  const raw = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
  assert.strictEqual(raw.token, token);
  assert.strictEqual(raw.port, port);
  assert.strictEqual(fs.statSync(endpointFile).mode & 0o777, 0o600);
  await server.close();
});

test('sends a message through the client', async () => {
  const { server, client } = build();
  const { token } = await server.listen();
  const res = await fetch(`http://127.0.0.1:${server.port}/chats/friend%40s.whatsapp.net/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.strictEqual(res.status, 204);
  assert.deepStrictEqual(client.sent, { jid: 'friend@s.whatsapp.net', text: 'hi' });
  await server.close();
});

test('unlock returns 429 with retryAfterMs when throttled', async () => {
  const { server } = build({ verify: async () => ({ ok: false, reason: 'throttled', retryAfterMs: 4000 }) });
  const { token } = await server.listen();
  const res = await fetch(`http://127.0.0.1:${server.port}/unlock`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'nope' }),
  });
  assert.strictEqual(res.status, 429);
  assert.deepStrictEqual(await res.json(), { ok: false, reason: 'throttled', retryAfterMs: 4000 });
  await server.close();
});

test('unlock returns 401 for an invalid password', async () => {
  const { server } = build({ verify: async () => ({ ok: false, reason: 'invalid', retryAfterMs: 2000 }) });
  const { token } = await server.listen();
  const res = await fetch(`http://127.0.0.1:${server.port}/unlock`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'nope' }),
  });
  assert.strictEqual(res.status, 401);
  await server.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test test/server.test.js`
Expected: FAIL — `Cannot find module '../src/server'`

- [ ] **Step 3: Write `backend/src/server.js`**

```js
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Loopback HTTP + WebSocket API for the widget.
 *
 * QML can only speak TCP (no QLocalSocket binding), so this cannot be a Unix
 * socket. To compensate, every request must present a bearer token that only
 * ever exists in a 0600 file under the user's runtime dir, and non-loopback
 * peers are refused outright.
 */
function createServer({ client, store, authenticator, endpointFile }) {
  const token = crypto.randomBytes(32).toString('hex');
  const httpServer = http.createServer(handleRequest);
  const wss = new WebSocketServer({ noServer: true });

  function authorized(req) {
    if (!LOOPBACK.has(req.socket.remoteAddress)) return false;
    const header = req.headers.authorization || '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    return supplied.length > 0 && timingSafeEqual(supplied, token);
  }

  function json(res, code, body) {
    const payload = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(payload);
  }

  async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return {};
    }
  }

  async function handleRequest(req, res) {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });

    const url = new URL(req.url, 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, { status: client.getStatus(), unread: store.totalUnread() });
    }

    if (req.method === 'GET' && url.pathname === '/qr') {
      const png = client.getQrPng();
      if (!png) return json(res, 404, { error: 'no pairing code available' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(png);
    }

    if (req.method === 'GET' && url.pathname === '/chats') {
      return json(res, 200, { chats: store.listChats() });
    }

    if (segments[0] === 'chats' && segments.length === 3) {
      const jid = decodeURIComponent(segments[1]);

      if (req.method === 'GET' && segments[2] === 'messages') {
        return json(res, 200, { messages: store.getMessages(jid) });
      }

      if (req.method === 'POST' && segments[2] === 'messages') {
        const body = await readJsonBody(req);
        if (!body.text) return json(res, 400, { error: 'text is required' });
        try {
          await client.sendMessage(jid, body.text);
        } catch (err) {
          return json(res, 503, { error: err.message });
        }
        res.writeHead(204);
        return res.end();
      }

      if (req.method === 'POST' && segments[2] === 'read') {
        store.markRead(jid);
        broadcast({ type: 'unread', unread: store.totalUnread() });
        res.writeHead(204);
        return res.end();
      }
    }

    if (req.method === 'POST' && url.pathname === '/unlock') {
      const body = await readJsonBody(req);
      const result = await authenticator.verify(String(body.password || ''));
      if (result.ok) return json(res, 200, { ok: true });
      const code = result.reason === 'throttled' ? 429 : 401;
      return json(res, code, result);
    }

    return json(res, 404, { error: 'not found' });
  }

  function broadcast(payload) {
    const message = JSON.stringify(payload);
    for (const socket of wss.clients) {
      if (socket.readyState === socket.OPEN) socket.send(message);
    }
  }

  httpServer.on('upgrade', (req, socket, head) => {
    if (!authorized(req) || new URL(req.url, 'http://127.0.0.1').pathname !== '/events') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  client.events.on('status', (status) => broadcast({ type: 'status', status }));
  client.events.on('message', ({ jid, message }) => {
    broadcast({ type: 'message', jid, message, unread: store.totalUnread() });
  });

  const api = {
    token,
    port: 0,
    listen() {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', () => {
          api.port = httpServer.address().port;
          fs.mkdirSync(path.dirname(endpointFile), { recursive: true });
          fs.writeFileSync(endpointFile, JSON.stringify({ port: api.port, token }), { mode: 0o600 });
          // writeFileSync only applies mode when creating; enforce on reuse.
          fs.chmodSync(endpointFile, 0o600);
          resolve({ port: api.port, token });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        try { fs.unlinkSync(endpointFile); } catch { /* already gone */ }
        for (const socket of wss.clients) socket.terminate();
        httpServer.close(() => resolve());
      });
    },
    broadcast,
  };

  return api;
}

module.exports = { createServer };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test test/server.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: PASS — all tests from Tasks 1, 2, 4, 5, 6

- [ ] **Step 6: Commit**

```bash
git add backend/src/server.js backend/test/server.test.js
git commit -m "feat(backend): add token-guarded HTTP and WebSocket API"
```

---

### Task 7: Entrypoint, systemd unit, and first real pairing

**Files:**
- Create: `backend/src/index.js`
- Create: `backend/systemd/whatsapp-widget-backend.service`

**Interfaces:**
- Consumes: everything from Tasks 1–6
- Produces: a running background service; the endpoint file that Task 9's QML client reads.

- [ ] **Step 1: Write `backend/src/index.js`**

```js
'use strict';

const fs = require('node:fs');
const { buildConfig } = require('./config');
const { createStore } = require('./store');
const { createAuthenticator } = require('./auth-pam');
const { createWhatsAppClient } = require('./whatsapp');
const { createServer } = require('./server');

async function main() {
  const config = buildConfig();
  fs.mkdirSync(config.sessionDir, { recursive: true });

  const store = createStore({
    maxMessagesPerChat: config.maxMessagesPerChat,
    maxChats: config.maxChats,
  });
  const authenticator = createAuthenticator({ service: config.pamService });
  const client = createWhatsAppClient({ sessionDir: config.sessionDir, store });
  const server = createServer({ client, store, authenticator, endpointFile: config.endpointFile });

  const { port } = await server.listen();
  console.log(`whatsapp-widget backend listening on 127.0.0.1:${port}`);

  await client.start();

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Write `backend/systemd/whatsapp-widget-backend.service`**

```ini
[Unit]
Description=WhatsApp widget backend
After=graphical-session.target

[Service]
Type=simple
ExecStart=/usr/bin/env node %h/Documents/whatsapp-widget/backend/src/index.js
Restart=on-failure
RestartSec=5
# The backend holds a WhatsApp session and verifies passwords; keep its
# footprint and privileges small.
NoNewPrivileges=false
MemoryMax=400M

[Install]
WantedBy=default.target
```

Note: `NoNewPrivileges` must stay `false` — PAM's `pam_unix` needs to execute the setuid `unix_chkpwd` helper, and hardening this would silently break unlock.

- [ ] **Step 3: Start the backend in the foreground and pair**

```bash
cd backend && npm start
```

Expected: logs the listening port. In another terminal, read the endpoint file and fetch the pairing QR:

```bash
PORT=$(python3 -c "import json;print(json.load(open('$XDG_RUNTIME_DIR/whatsapp-widget-endpoint.json'))['port'])")
TOKEN=$(python3 -c "import json;print(json.load(open('$XDG_RUNTIME_DIR/whatsapp-widget-endpoint.json'))['token'])")
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/status"
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/qr" -o /tmp/wa-qr.png && xdg-open /tmp/wa-qr.png
```

Scan the PNG with WhatsApp → Linked Devices. Then re-check status.
Expected: `{"status":"connected","unread":0}`

- [ ] **Step 4: Verify chats populate and a message sends**

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/chats" | head -c 400
```

Expected: a JSON array of chats. Send a test message to your own number to confirm `POST /chats/:jid/messages` returns 204 and the message arrives on the phone.

- [ ] **Step 5: Install and enable the user service**

```bash
mkdir -p ~/.config/systemd/user
cp backend/systemd/whatsapp-widget-backend.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now whatsapp-widget-backend.service
systemctl --user status whatsapp-widget-backend.service --no-pager
```

Expected: `active (running)`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.js backend/systemd/whatsapp-widget-backend.service
git commit -m "feat(backend): add entrypoint and systemd user service"
```

---

### Task 8: Plasmoid skeleton with live status indicator

**Files:**
- Create: `plasmoid/metadata.json`
- Create: `plasmoid/contents/ui/main.qml`
- Create: `plasmoid/contents/ui/CompactRepresentation.qml`
- Create: `plasmoid/contents/ui/FullRepresentation.qml`

**Interfaces:**
- Consumes: nothing from the backend yet (static placeholder UI)
- Produces: an installable widget with id `org.kde.plasma.whatsappwidget`, whose `main.qml` exposes `root.backend` in Task 9.

- [ ] **Step 1: Install the Plasma SDK for fast iteration**

Run: `sudo pacman -S --needed plasma-sdk`
Expected: provides `plasmoidviewer`, which is not currently installed. `kpackagetool6` is already present.

- [ ] **Step 2: Write `plasmoid/metadata.json`**

```json
{
  "KPlugin": {
    "Id": "org.kde.plasma.whatsappwidget",
    "Name": "WhatsApp Widget",
    "Description": "Mini WhatsApp chat panel with a privacy hide mode",
    "Icon": "internet-mail",
    "License": "MIT",
    "Version": "1.0.0",
    "Authors": [{ "Name": "Alex" }],
    "ServiceTypes": ["Plasma/Applet"]
  },
  "KPackageStructure": "Plasma/Applet",
  "X-Plasma-API-Minimum-Version": "6.0"
}
```

- [ ] **Step 3: Write `plasmoid/contents/ui/main.qml`**

```qml
import QtQuick
import org.kde.plasma.plasmoid

PlasmoidItem {
    id: root

    // Replaced by a live backend client in Task 9.
    readonly property var backend: ({ status: "connecting", unread: 0 })

    preferredRepresentation: compactRepresentation
    compactRepresentation: CompactRepresentation {}
    fullRepresentation: FullRepresentation {}
}
```

- [ ] **Step 4: Write `plasmoid/contents/ui/CompactRepresentation.qml`**

```qml
import QtQuick
import org.kde.kirigami as Kirigami
import org.kde.plasma.plasmoid

MouseArea {
    id: compact

    Kirigami.Icon {
        anchors.fill: parent
        source: "internet-mail"
    }

    // Connection state dot: visible at a glance without opening the panel.
    Rectangle {
        width: Math.round(parent.width * 0.3)
        height: width
        radius: width / 2
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        color: {
            switch (plasmoid.rootItem.backend.status) {
            case "connected": return Kirigami.Theme.positiveTextColor;
            case "needs-pairing": return Kirigami.Theme.neutralTextColor;
            default: return Kirigami.Theme.negativeTextColor;
            }
        }
    }

    onClicked: plasmoid.expanded = !plasmoid.expanded
}
```

- [ ] **Step 5: Write `plasmoid/contents/ui/FullRepresentation.qml`**

```qml
import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents

Item {
    id: full

    Layout.minimumWidth: Kirigami.Units.gridUnit * 20
    Layout.minimumHeight: Kirigami.Units.gridUnit * 24
    Layout.preferredWidth: Kirigami.Units.gridUnit * 24
    Layout.preferredHeight: Kirigami.Units.gridUnit * 28

    PlasmaComponents.Label {
        anchors.centerIn: parent
        text: i18n("Status: %1", plasmoid.rootItem.backend.status)
    }
}
```

- [ ] **Step 6: Preview it**

Run: `plasmoidviewer -a ./plasmoid`
Expected: a window showing `Status: connecting` with a red state dot.

- [ ] **Step 7: Install into Plasma and add it**

```bash
kpackagetool6 --type Plasma/Applet --install ./plasmoid
```

Expected: `Successfully installed`. Then right-click the desktop → Add Widgets → search "WhatsApp" and add it.

(For later reinstalls use `kpackagetool6 --type Plasma/Applet --upgrade ./plasmoid`.)

- [ ] **Step 8: Commit**

```bash
git add plasmoid/metadata.json plasmoid/contents/ui/
git commit -m "feat(plasmoid): add widget skeleton with status indicator"
```

---

### Task 9: QML backend client

**Files:**
- Create: `plasmoid/contents/code/backend.js`
- Create: `plasmoid/contents/ui/BackendClient.qml`
- Modify: `plasmoid/contents/ui/main.qml`

**Interfaces:**
- Consumes: the endpoint file and API from Tasks 6–7
- Produces: `BackendClient` QML item exposing:
  - properties `status` (string), `unread` (int), `chats` (array), `connected` (bool)
  - `request(method, path, body, callback)` — callback `(errorOrNull, parsedBodyOrNull)`
  - `refreshChats()`, `loadMessages(jid, callback)`, `send(jid, text, callback)`, `markRead(jid)`, `unlock(password, callback)`
  - signal `messageReceived(jid, message)`

- [ ] **Step 1: Write `plasmoid/contents/code/backend.js`**

```js
.pragma library

// Reads {port, token} written 0600 by the backend. QML has no env access,
// so the runtime dir is resolved by the caller via Qt.labs.platform
// StandardPaths and passed in.
function readEndpoint(runtimeDirUrl) {
    var request = new XMLHttpRequest();
    var url = runtimeDirUrl + "/whatsapp-widget-endpoint.json";
    try {
        request.open("GET", url, false);
        request.send(null);
        if (request.status !== 0 && request.status !== 200) return null;
        if (!request.responseText) return null;
        return JSON.parse(request.responseText);
    } catch (e) {
        return null;
    }
}

function buildUrl(endpoint, path) {
    return "http://127.0.0.1:" + endpoint.port + path;
}
```

- [ ] **Step 2: Write `plasmoid/contents/ui/BackendClient.qml`**

```qml
import QtQuick
import QtWebSockets
import Qt.labs.platform as Platform
import "../code/backend.js" as Backend

QtObject {
    id: client

    property var endpoint: null
    property string status: "disconnected"
    property int unread: 0
    property var chats: []
    readonly property bool connected: endpoint !== null && status === "connected"

    signal messageReceived(string jid, var message)

    readonly property string runtimeDir: Platform.StandardPaths.writableLocation(Platform.StandardPaths.RuntimeLocation)

    function loadEndpoint() {
        endpoint = Backend.readEndpoint(runtimeDir);
        if (endpoint) {
            socket.url = "ws://127.0.0.1:" + endpoint.port + "/events";
            socket.active = true;
            refreshStatus();
            refreshChats();
        }
    }

    function request(method, path, body, callback) {
        if (!endpoint) { if (callback) callback("no backend", null); return; }
        var xhr = new XMLHttpRequest();
        xhr.open(method, Backend.buildUrl(endpoint, path));
        xhr.setRequestHeader("Authorization", "Bearer " + endpoint.token);
        if (body) xhr.setRequestHeader("Content-Type", "application/json");
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (xhr.status >= 200 && xhr.status < 300) {
                var parsed = null;
                if (xhr.responseText) { try { parsed = JSON.parse(xhr.responseText); } catch (e) { parsed = null; } }
                if (callback) callback(null, parsed);
            } else {
                var errorBody = null;
                try { errorBody = JSON.parse(xhr.responseText); } catch (e) { errorBody = null; }
                if (callback) callback(xhr.status, errorBody);
            }
        };
        xhr.send(body ? JSON.stringify(body) : null);
    }

    function refreshStatus() {
        request("GET", "/status", null, function (err, data) {
            if (!err && data) { client.status = data.status; client.unread = data.unread; }
        });
    }

    function refreshChats() {
        request("GET", "/chats", null, function (err, data) {
            if (!err && data) client.chats = data.chats;
        });
    }

    function loadMessages(jid, callback) {
        request("GET", "/chats/" + encodeURIComponent(jid) + "/messages", null, function (err, data) {
            callback(err, data ? data.messages : []);
        });
    }

    function send(jid, text, callback) {
        request("POST", "/chats/" + encodeURIComponent(jid) + "/messages", { text: text }, callback);
    }

    function markRead(jid) {
        request("POST", "/chats/" + encodeURIComponent(jid) + "/read", {}, function () { refreshStatus(); });
    }

    function unlock(password, callback) {
        request("POST", "/unlock", { password: password }, callback);
    }

    property WebSocket socket: WebSocket {
        active: false
        onTextMessageReceived: function (message) {
            var event = JSON.parse(message);
            if (event.type === "status") {
                client.status = event.status;
                if (event.status === "connected") client.refreshChats();
            } else if (event.type === "unread") {
                client.unread = event.unread;
            } else if (event.type === "message") {
                client.unread = event.unread;
                client.refreshChats();
                client.messageReceived(event.jid, event.message);
            }
        }
        onStatusChanged: {
            // Reconnect only on failure; this is not a poll.
            if (socket.status === WebSocket.Error || socket.status === WebSocket.Closed) {
                reconnectTimer.restart();
            }
        }
    }

    property Timer reconnectTimer: Timer {
        interval: 5000
        repeat: false
        onTriggered: client.loadEndpoint()
    }

    Component.onCompleted: loadEndpoint()
}
```

Note: the `WebSocket` handshake carries no `Authorization` header (QML's `WebSocket` cannot set one), so the backend must also accept the token as a query parameter for the upgrade path only.

- [ ] **Step 3: Extend `backend/src/server.js` to accept a token query param on upgrade**

Replace the `authorized` function with a version that also checks the query string, and update the upgrade handler to use it.

```js
  function authorized(req) {
    if (!LOOPBACK.has(req.socket.remoteAddress)) return false;
    const header = req.headers.authorization || '';
    let supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!supplied) {
      // QML's WebSocket type cannot set request headers, so the upgrade
      // handshake may carry the token as a query parameter instead.
      supplied = new URL(req.url, 'http://127.0.0.1').searchParams.get('token') || '';
    }
    return supplied.length > 0 && timingSafeEqual(supplied, token);
  }
```

- [ ] **Step 4: Add a test for query-param auth in `backend/test/server.test.js`**

```js
test('accepts the token as a query parameter (for the QML WebSocket)', async () => {
  const { server } = build();
  const { token } = await server.listen();
  const res = await fetch(`http://127.0.0.1:${server.port}/status?token=${token}`);
  assert.strictEqual(res.status, 200);
  await server.close();
});
```

- [ ] **Step 5: Run the backend tests**

Run: `cd backend && npm test`
Expected: PASS — including the new query-param test

- [ ] **Step 6: Point the QML socket URL at the token-bearing URL**

In `BackendClient.qml`, change the socket URL assignment in `loadEndpoint()`:

```qml
            socket.url = "ws://127.0.0.1:" + endpoint.port + "/events?token=" + endpoint.token;
```

- [ ] **Step 7: Wire the client into `plasmoid/contents/ui/main.qml`**

```qml
import QtQuick
import org.kde.plasma.plasmoid

PlasmoidItem {
    id: root

    readonly property BackendClient backend: BackendClient {}

    preferredRepresentation: compactRepresentation
    compactRepresentation: CompactRepresentation {}
    fullRepresentation: FullRepresentation {}
}
```

- [ ] **Step 8: Verify live status**

Run: `plasmoidviewer -a ./plasmoid`
Expected: with the backend running and paired, the label reads `Status: connected` and the dot is green. Stop the backend (`systemctl --user stop whatsapp-widget-backend`) and confirm the dot goes red within a few seconds.

- [ ] **Step 9: Commit**

```bash
git add plasmoid/contents/code/backend.js plasmoid/contents/ui/BackendClient.qml plasmoid/contents/ui/main.qml backend/src/server.js backend/test/server.test.js
git commit -m "feat(plasmoid): add backend client over token-guarded API"
```

---

### Task 10: Pairing view

**Files:**
- Create: `plasmoid/contents/ui/PairingView.qml`
- Modify: `plasmoid/contents/ui/FullRepresentation.qml`

**Interfaces:**
- Consumes: `BackendClient.status`, `BackendClient.endpoint` (Task 9)
- Produces: `PairingView` shown whenever status is `needs-pairing`.

- [ ] **Step 1: Write `plasmoid/contents/ui/PairingView.qml`**

```qml
import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents

ColumnLayout {
    id: pairing

    required property var backend

    spacing: Kirigami.Units.largeSpacing

    PlasmaComponents.Label {
        Layout.fillWidth: true
        horizontalAlignment: Text.AlignHCenter
        wrapMode: Text.WordWrap
        text: i18n("Scan with WhatsApp → Linked Devices")
    }

    Image {
        Layout.alignment: Qt.AlignHCenter
        Layout.preferredWidth: Kirigami.Units.gridUnit * 14
        Layout.preferredHeight: Kirigami.Units.gridUnit * 14
        fillMode: Image.PreserveAspectFit
        cache: false
        source: pairing.backend.endpoint
            ? "http://127.0.0.1:" + pairing.backend.endpoint.port + "/qr?token=" + pairing.backend.endpoint.token
            : ""
    }
}
```

- [ ] **Step 2: Switch `FullRepresentation.qml` between pairing and chat states**

```qml
import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents

Item {
    id: full

    readonly property var backend: plasmoid.rootItem.backend

    Layout.minimumWidth: Kirigami.Units.gridUnit * 20
    Layout.minimumHeight: Kirigami.Units.gridUnit * 24
    Layout.preferredWidth: Kirigami.Units.gridUnit * 24
    Layout.preferredHeight: Kirigami.Units.gridUnit * 28

    PairingView {
        anchors.centerIn: parent
        width: parent.width - Kirigami.Units.gridUnit * 2
        backend: full.backend
        visible: full.backend.status === "needs-pairing"
    }

    PlasmaComponents.Label {
        anchors.centerIn: parent
        visible: full.backend.status !== "needs-pairing" && full.backend.status !== "connected"
        text: i18n("Connecting…")
    }

    // Chat UI lands here in Task 11.
    Item {
        id: chatArea
        anchors.fill: parent
        visible: full.backend.status === "connected"
    }
}
```

- [ ] **Step 3: Verify**

Temporarily unlink the device from your phone (WhatsApp → Linked Devices → log out), then run `plasmoidviewer -a ./plasmoid`.
Expected: the QR renders in the widget. Scan it and confirm the view switches to the (empty) chat area automatically without restarting anything.

- [ ] **Step 4: Commit**

```bash
git add plasmoid/contents/ui/PairingView.qml plasmoid/contents/ui/FullRepresentation.qml
git commit -m "feat(plasmoid): add pairing view with QR"
```

---

### Task 11: Chat list, message view, and sending

**Files:**
- Create: `plasmoid/contents/ui/ChatPanel.qml`
- Modify: `plasmoid/contents/ui/FullRepresentation.qml`

**Interfaces:**
- Consumes: `BackendClient.chats`, `loadMessages`, `send`, `markRead`, `messageReceived` (Task 9)
- Produces: `ChatPanel` — the mini chat panel itself.

- [ ] **Step 1: Write `plasmoid/contents/ui/ChatPanel.qml`**

```qml
import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents
import org.kde.plasma.extras as PlasmaExtras

ColumnLayout {
    id: panel

    required property var backend
    property string activeJid: ""

    spacing: Kirigami.Units.smallSpacing

    function openChat(jid) {
        panel.activeJid = jid;
        messageModel.clear();
        panel.backend.loadMessages(jid, function (err, messages) {
            if (err) return;
            for (var i = 0; i < messages.length; i++) messageModel.append(messages[i]);
            messageList.positionViewAtEnd();
        });
        panel.backend.markRead(jid);
    }

    ListModel { id: messageModel }

    Connections {
        target: panel.backend
        function onMessageReceived(jid, message) {
            if (jid !== panel.activeJid) return;
            messageModel.append(message);
            messageList.positionViewAtEnd();
            panel.backend.markRead(jid);
        }
    }

    // --- Chat list (shown when no chat is open) ---
    PlasmaExtras.ScrollArea {
        Layout.fillWidth: true
        Layout.fillHeight: true
        visible: panel.activeJid === ""

        ListView {
            model: panel.backend.chats
            clip: true
            delegate: PlasmaComponents.ItemDelegate {
                width: ListView.view.width
                text: modelData.name
                icon.name: "user-identity"
                onClicked: panel.openChat(modelData.jid)

                PlasmaComponents.Label {
                    anchors.right: parent.right
                    anchors.rightMargin: Kirigami.Units.smallSpacing
                    anchors.verticalCenter: parent.verticalCenter
                    visible: modelData.unread > 0
                    text: modelData.unread
                    color: Kirigami.Theme.highlightColor
                }
            }
        }
    }

    // --- Conversation (shown when a chat is open) ---
    RowLayout {
        Layout.fillWidth: true
        visible: panel.activeJid !== ""

        PlasmaComponents.ToolButton {
            icon.name: "go-previous"
            onClicked: panel.activeJid = ""
        }
        PlasmaComponents.Label {
            Layout.fillWidth: true
            elide: Text.ElideRight
            text: panel.activeJid
        }
    }

    PlasmaExtras.ScrollArea {
        Layout.fillWidth: true
        Layout.fillHeight: true
        visible: panel.activeJid !== ""

        ListView {
            id: messageList
            model: messageModel
            clip: true
            spacing: Kirigami.Units.smallSpacing
            delegate: Rectangle {
                width: ListView.view.width
                height: bubble.implicitHeight + Kirigami.Units.smallSpacing * 2
                color: "transparent"

                Rectangle {
                    anchors.right: model.fromMe ? parent.right : undefined
                    anchors.left: model.fromMe ? undefined : parent.left
                    width: Math.min(bubble.implicitWidth + Kirigami.Units.largeSpacing, parent.width * 0.8)
                    height: bubble.implicitHeight + Kirigami.Units.smallSpacing
                    radius: Kirigami.Units.smallSpacing
                    color: model.fromMe ? Kirigami.Theme.highlightColor : Kirigami.Theme.alternateBackgroundColor

                    PlasmaComponents.Label {
                        id: bubble
                        anchors.centerIn: parent
                        width: parent.width - Kirigami.Units.smallSpacing
                        wrapMode: Text.WordWrap
                        text: model.text
                    }
                }
            }
        }
    }

    RowLayout {
        Layout.fillWidth: true
        visible: panel.activeJid !== ""

        PlasmaComponents.TextField {
            id: composer
            Layout.fillWidth: true
            placeholderText: i18n("Message…")
            onAccepted: sendButton.clicked()
        }

        PlasmaComponents.ToolButton {
            id: sendButton
            icon.name: "document-send"
            enabled: composer.text.length > 0
            onClicked: {
                var text = composer.text;
                composer.text = "";
                panel.backend.send(panel.activeJid, text, function (err) {
                    if (err) { composer.text = text; return; }
                    messageModel.append({ id: "local", fromMe: true, text: text, timestamp: 0 });
                    messageList.positionViewAtEnd();
                });
            }
        }
    }
}
```

- [ ] **Step 2: Mount it in `FullRepresentation.qml`**

Replace the empty `chatArea` placeholder from Task 10:

```qml
    ChatPanel {
        id: chatArea
        anchors.fill: parent
        anchors.margins: Kirigami.Units.smallSpacing
        backend: full.backend
        visible: full.backend.status === "connected"
    }
```

- [ ] **Step 3: Verify**

Run: `plasmoidviewer -a ./plasmoid`
Expected: the chat list renders with unread counts; clicking a chat loads its messages and clears its unread count; typing and sending delivers the message to the real conversation on your phone; a message arriving on the phone appears in the open chat without any refresh.

- [ ] **Step 4: Commit**

```bash
git add plasmoid/contents/ui/ChatPanel.qml plasmoid/contents/ui/FullRepresentation.qml
git commit -m "feat(plasmoid): add chat list, conversation view, and sending"
```

---

### Task 12: Unread badge on the compact representation

**Files:**
- Modify: `plasmoid/contents/ui/CompactRepresentation.qml`

**Interfaces:**
- Consumes: `BackendClient.unread` (Task 9)
- Produces: `CompactRepresentation` reads `plasmoid.rootItem.hidden` (introduced in Task 13) to suppress the badge; until then that property is undefined and the badge always shows.

- [ ] **Step 1: Add the badge to `CompactRepresentation.qml`**

Insert inside the existing `MouseArea`, after the state dot:

```qml
    // Unread badge. Suppressed while the widget is hidden (Task 13) so a
    // glance at the panel leaks nothing.
    Rectangle {
        id: badge
        visible: plasmoid.rootItem.backend.unread > 0 && !plasmoid.rootItem.hidden
        anchors.top: parent.top
        anchors.right: parent.right
        width: Math.max(badgeLabel.implicitWidth + Kirigami.Units.smallSpacing, height)
        height: Math.round(parent.height * 0.45)
        radius: height / 2
        color: Kirigami.Theme.highlightColor

        PlasmaComponents.Label {
            id: badgeLabel
            anchors.centerIn: parent
            text: plasmoid.rootItem.backend.unread > 99 ? "99+" : plasmoid.rootItem.backend.unread
            color: Kirigami.Theme.highlightedTextColor
            font.pixelSize: Math.round(badge.height * 0.7)
        }
    }
```

Add the required import at the top of the file:

```qml
import org.kde.plasma.components as PlasmaComponents
```

- [ ] **Step 2: Verify**

Run: `plasmoidviewer -a ./plasmoid`
Expected: send yourself a message from another device; the badge appears with the count and disappears when you open that chat.

- [ ] **Step 3: Commit**

```bash
git add plasmoid/contents/ui/CompactRepresentation.qml
git commit -m "feat(plasmoid): add unread badge to compact representation"
```

---

### Task 13: Hide toggle and censor overlay

**Files:**
- Create: `plasmoid/contents/ui/HideOverlay.qml`
- Modify: `plasmoid/contents/ui/main.qml`
- Modify: `plasmoid/contents/ui/FullRepresentation.qml`

**Interfaces:**
- Consumes: nothing new from the backend
- Produces: on `main.qml`'s root — `hidden` (bool), `hiddenSince` (double, ms epoch, 0 when visible), and `hide()`. Task 14 adds the unlock path that clears them.

- [ ] **Step 1: Add hide state to `plasmoid/contents/ui/main.qml`**

```qml
import QtQuick
import org.kde.plasma.plasmoid

PlasmoidItem {
    id: root

    readonly property BackendClient backend: BackendClient {}

    // Privacy hide state. hiddenSince is a plain timestamp, deliberately not
    // driven by a timer: elapsed time is computed only when the user tries to
    // reveal, so nothing ticks in the background.
    property bool hidden: false
    property double hiddenSince: 0

    function hide() {
        root.hiddenSince = Date.now();
        root.hidden = true;
    }

    function reveal() {
        root.hidden = false;
        root.hiddenSince = 0;
    }

    preferredRepresentation: compactRepresentation
    compactRepresentation: CompactRepresentation {}
    fullRepresentation: FullRepresentation {}
}
```

- [ ] **Step 2: Write `plasmoid/contents/ui/HideOverlay.qml`**

```qml
import QtQuick
import QtQuick.Layouts
import QtQuick.Effects
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents

/**
 * Censors the panel contents. The blur is a MultiEffect over a live source,
 * but it is only instantiated while hidden — when visible: false, nothing is
 * rendered or computed at all, so the cost is zero in the normal case.
 */
Item {
    id: overlay

    required property Item censorSource

    signal revealRequested()

    MultiEffect {
        anchors.fill: parent
        source: overlay.censorSource
        blurEnabled: true
        blur: 1.0
        blurMax: 48
        // Static blur: no animation, computed once per toggle rather than per frame.
        autoPaddingEnabled: false
    }

    Rectangle {
        anchors.fill: parent
        color: Kirigami.Theme.backgroundColor
        opacity: 0.55
    }

    ColumnLayout {
        anchors.centerIn: parent
        spacing: Kirigami.Units.largeSpacing

        Kirigami.Icon {
            Layout.alignment: Qt.AlignHCenter
            Layout.preferredWidth: Kirigami.Units.iconSizes.large
            Layout.preferredHeight: Kirigami.Units.iconSizes.large
            source: "object-locked"
        }

        PlasmaComponents.Button {
            Layout.alignment: Qt.AlignHCenter
            icon.name: "view-visible"
            text: i18n("Reveal")
            onClicked: overlay.revealRequested()
        }
    }
}
```

- [ ] **Step 3: Add the hide button and overlay to `FullRepresentation.qml`**

Wrap the existing content in a container so it can act as the blur source, and add a header button. The full file becomes:

```qml
import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents

Item {
    id: full

    readonly property var backend: plasmoid.rootItem.backend

    Layout.minimumWidth: Kirigami.Units.gridUnit * 20
    Layout.minimumHeight: Kirigami.Units.gridUnit * 24
    Layout.preferredWidth: Kirigami.Units.gridUnit * 24
    Layout.preferredHeight: Kirigami.Units.gridUnit * 28

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        RowLayout {
            Layout.fillWidth: true
            Layout.margins: Kirigami.Units.smallSpacing

            PlasmaComponents.Label {
                Layout.fillWidth: true
                text: i18n("WhatsApp")
            }

            PlasmaComponents.ToolButton {
                icon.name: "view-hidden"
                display: PlasmaComponents.AbstractButton.IconOnly
                text: i18n("Hide")
                visible: !plasmoid.rootItem.hidden
                onClicked: plasmoid.rootItem.hide()
            }
        }

        Item {
            id: contentArea
            Layout.fillWidth: true
            Layout.fillHeight: true

            PairingView {
                anchors.centerIn: parent
                width: parent.width - Kirigami.Units.gridUnit * 2
                backend: full.backend
                visible: full.backend.status === "needs-pairing"
            }

            PlasmaComponents.Label {
                anchors.centerIn: parent
                visible: full.backend.status !== "needs-pairing" && full.backend.status !== "connected"
                text: i18n("Connecting…")
            }

            ChatPanel {
                anchors.fill: parent
                anchors.margins: Kirigami.Units.smallSpacing
                backend: full.backend
                visible: full.backend.status === "connected"
            }
        }
    }

    HideOverlay {
        anchors.fill: parent
        censorSource: contentArea
        visible: plasmoid.rootItem.hidden
        onRevealRequested: plasmoid.rootItem.reveal()
    }
}
```

- [ ] **Step 4: Verify**

Run: `plasmoidviewer -a ./plasmoid`
Expected: clicking Hide blurs the chat content behind a themed scrim with a lock icon; the unread badge on the compact icon disappears; clicking Reveal restores it immediately (the password gate arrives in Task 14).

- [ ] **Step 5: Commit**

```bash
git add plasmoid/contents/ui/HideOverlay.qml plasmoid/contents/ui/main.qml plasmoid/contents/ui/FullRepresentation.qml
git commit -m "feat(plasmoid): add hide toggle and censor overlay"
```

---

### Task 14: Password-gated reveal with configurable threshold

**Files:**
- Create: `plasmoid/contents/config/main.xml`
- Create: `plasmoid/contents/config/config.qml`
- Create: `plasmoid/contents/ui/ConfigGeneral.qml`
- Modify: `plasmoid/contents/ui/HideOverlay.qml`
- Modify: `plasmoid/contents/ui/main.qml`

**Interfaces:**
- Consumes: `BackendClient.unlock(password, callback)` (Task 9); `hidden`/`hiddenSince` (Task 13)
- Produces: config key `lockAfterMinutes` (int, default 5) readable as `plasmoid.configuration.lockAfterMinutes`.

- [ ] **Step 1: Write `plasmoid/contents/config/main.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<kcfg xmlns="http://www.kde.org/standards/kcfg/1.0">
  <kcfgfile name=""/>
  <group name="General">
    <entry name="lockAfterMinutes" type="Int">
      <label>Require the password after the widget has been hidden this many minutes.</label>
      <default>5</default>
      <min>0</min>
      <max>1440</max>
    </entry>
  </group>
</kcfg>
```

- [ ] **Step 2: Write `plasmoid/contents/config/config.qml`**

```qml
import QtQuick
import org.kde.plasma.configuration

ConfigModel {
    ConfigCategory {
        name: i18n("General")
        icon: "configure"
        source: "ConfigGeneral.qml"
    }
}
```

- [ ] **Step 3: Write `plasmoid/contents/ui/ConfigGeneral.qml`**

```qml
import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami

Kirigami.FormLayout {
    id: page

    property alias cfg_lockAfterMinutes: lockAfter.value

    QQC2.SpinBox {
        id: lockAfter
        Kirigami.FormData.label: i18n("Require password after hidden for:")
        from: 0
        to: 1440
        textFromValue: function (value) {
            return value === 0 ? i18n("Always") : i18np("%1 minute", "%1 minutes", value);
        }
        valueFromText: function (text) {
            return parseInt(text, 10) || 0;
        }
    }
}
```

- [ ] **Step 4: Add the unlock prompt to `HideOverlay.qml`**

Replace the `ColumnLayout` from Task 13 with one that shows either the Reveal button or a password field, depending on elapsed time:

```qml
    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(parent.width - Kirigami.Units.gridUnit * 2, Kirigami.Units.gridUnit * 16)
        spacing: Kirigami.Units.largeSpacing

        Kirigami.Icon {
            Layout.alignment: Qt.AlignHCenter
            Layout.preferredWidth: Kirigami.Units.iconSizes.large
            Layout.preferredHeight: Kirigami.Units.iconSizes.large
            source: "object-locked"
        }

        PlasmaComponents.Button {
            Layout.alignment: Qt.AlignHCenter
            icon.name: "view-visible"
            text: i18n("Reveal")
            visible: !overlay.passwordRequired
            onClicked: overlay.revealRequested()
        }

        PlasmaComponents.TextField {
            id: passwordField
            Layout.fillWidth: true
            visible: overlay.passwordRequired
            echoMode: TextInput.Password
            placeholderText: i18n("Password")
            enabled: !overlay.busy
            onAccepted: overlay.submit(text)
        }

        PlasmaComponents.Label {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            visible: overlay.errorText.length > 0
            color: Kirigami.Theme.negativeTextColor
            text: overlay.errorText
        }
    }
```

Add these members to the top of `HideOverlay.qml`, and clear the field whenever the overlay is dismissed so no password lingers in memory:

```qml
    required property bool passwordRequired
    property bool busy: false
    property string errorText: ""

    signal unlockRequested(string password)

    function submit(password) {
        if (password.length === 0) return;
        overlay.busy = true;
        overlay.errorText = "";
        overlay.unlockRequested(password);
    }

    function failed(message) {
        overlay.busy = false;
        overlay.errorText = message;
        passwordField.text = "";
        passwordField.forceActiveFocus();
    }

    onVisibleChanged: {
        if (!visible) {
            passwordField.text = "";
            overlay.errorText = "";
            overlay.busy = false;
        }
    }
```

- [ ] **Step 5: Wire the gate in `FullRepresentation.qml`**

Replace the `HideOverlay` block from Task 13:

```qml
    HideOverlay {
        id: hideOverlay
        anchors.fill: parent
        censorSource: contentArea
        visible: plasmoid.rootItem.hidden
        passwordRequired: plasmoid.rootItem.passwordRequired()

        onRevealRequested: plasmoid.rootItem.reveal()
        onUnlockRequested: function (password) {
            full.backend.unlock(password, function (err, data) {
                if (!err) { plasmoid.rootItem.reveal(); return; }
                if (err === 429 && data) {
                    hideOverlay.failed(i18n("Too many attempts. Try again in %1s.",
                                            Math.ceil(data.retryAfterMs / 1000)));
                } else {
                    hideOverlay.failed(i18n("Incorrect password."));
                }
            });
        }
    }
```

- [ ] **Step 6: Add the lazy elapsed-time check to `main.qml`**

```qml
    // Evaluated only when the overlay asks — no timer, nothing ticking.
    function passwordRequired() {
        if (!root.hidden || root.hiddenSince === 0) return false;
        var thresholdMs = plasmoid.configuration.lockAfterMinutes * 60000;
        return (Date.now() - root.hiddenSince) >= thresholdMs;
    }
```

Note: `passwordRequired` is a function, not a binding, so it is re-evaluated when the overlay becomes visible rather than continuously. To make the overlay re-check on show, add to `FullRepresentation.qml`'s `hideOverlay`:

```qml
        onVisibleChanged: if (visible) passwordRequired = plasmoid.rootItem.passwordRequired()
```

and change `passwordRequired` in `HideOverlay.qml` from `required property bool` to `property bool passwordRequired: false`.

- [ ] **Step 7: Verify the fast path**

Run: `plasmoidviewer -a ./plasmoid`
Hide the widget, then immediately reveal it.
Expected: reveals with no prompt.

- [ ] **Step 8: Verify the gated path**

Set "Require password after hidden for" to `0` minutes in the widget's settings, then hide and reveal.
Expected: a password field appears. A wrong password shows "Incorrect password." and clears the field; a second wrong attempt shows the "Try again in Ns." throttle message. The correct login password reveals the panel.

Then set it back to `5` and confirm hiding briefly still reveals without a prompt.

- [ ] **Step 9: Confirm the account was never locked**

Run: `faillock --user "$USER"`
Expected: no failure records — the failed widget attempts went through the dedicated PAM service and never touched the login lockout counter.

- [ ] **Step 10: Commit**

```bash
git add plasmoid/contents/config/ plasmoid/contents/ui/ConfigGeneral.qml plasmoid/contents/ui/HideOverlay.qml plasmoid/contents/ui/main.qml plasmoid/contents/ui/FullRepresentation.qml
git commit -m "feat(plasmoid): gate reveal behind PAM password after configurable delay"
```

---

### Task 15: README and end-to-end verification

**Files:**
- Create: `README.md`
- Create: `.gitignore`

**Interfaces:**
- Consumes: everything
- Produces: install/uninstall documentation.

- [ ] **Step 1: Write the repository `.gitignore`**

```gitignore
node_modules/
*.log
```

- [ ] **Step 2: Write `README.md`**

````markdown
# WhatsApp Widget

A KDE Plasma 6 widget giving a mini WhatsApp chat panel, with a privacy hide
mode that requires your login password to reveal after a configurable delay.

## How it works

A Node.js backend holds the WhatsApp connection (via Baileys) and exposes a
loopback HTTP/WebSocket API guarded by a bearer token. The Plasmoid renders
that state. Everything is push-driven — nothing polls.

## Requirements

- KDE Plasma 6, Qt 6
- Node.js 20+
- `plasma-sdk` (for `plasmoidviewer`, development only)

## Install

```bash
# 1. Backend dependencies
cd backend && npm install && cd ..

# 2. PAM service for the unlock prompt (one-time, needs sudo)
./packaging/install-pam.sh

# 3. Background service
mkdir -p ~/.config/systemd/user
cp backend/systemd/whatsapp-widget-backend.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now whatsapp-widget-backend.service

# 4. The widget itself
kpackagetool6 --type Plasma/Applet --install ./plasmoid
```

Then right-click your desktop or panel → Add Widgets → "WhatsApp Widget".
On first run it shows a QR code — scan it with WhatsApp → Linked Devices.

## Updating the widget after changes

```bash
kpackagetool6 --type Plasma/Applet --upgrade ./plasmoid
```

## Uninstall

```bash
systemctl --user disable --now whatsapp-widget-backend.service
rm ~/.config/systemd/user/whatsapp-widget-backend.service
kpackagetool6 --type Plasma/Applet --remove org.kde.plasma.whatsappwidget
sudo rm /etc/pam.d/whatsapp-widget
rm -rf ~/.local/share/whatsapp-widget
```

## Security notes

- The backend binds to `127.0.0.1` on a random port and requires a 32-byte
  bearer token, stored `0600` in `$XDG_RUNTIME_DIR/whatsapp-widget-endpoint.json`.
- Unlock uses a **dedicated** PAM service (`/etc/pam.d/whatsapp-widget`) that
  omits `pam_faillock`, so a mistyped widget password can never lock your real
  account. Brute-force protection is enforced in the backend as exponential
  backoff instead.
- Your password is never logged, stored, or written to disk.
- Your WhatsApp session lives in `~/.local/share/whatsapp-widget/session/`.
  Treat it like a credential — anyone with it can read your messages.

## Caveats

Baileys is a reverse-engineered client. Using it is against WhatsApp's Terms
of Service and carries a risk of the linked account being banned. WhatsApp
protocol changes can break it without warning.

## Tests

```bash
cd backend && npm test
```
````

- [ ] **Step 3: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS — all tests across all modules

- [ ] **Step 4: End-to-end verification against the installed widget**

```bash
kpackagetool6 --type Plasma/Applet --upgrade ./plasmoid
systemctl --user restart whatsapp-widget-backend.service
```

Walk the whole flow in the real panel (not `plasmoidviewer`):
1. Widget shows connected (green dot).
2. A message sent from another device raises the unread badge without any interaction.
3. Opening that chat clears the badge and shows the message.
4. Sending from the widget arrives on the phone.
5. Hide → badge disappears and content is blurred.
6. Reveal within the threshold → no prompt.
7. Reveal after the threshold → password required; correct password reveals.
8. `systemctl --user stop whatsapp-widget-backend` → dot goes red; `start` → recovers on its own.

- [ ] **Step 5: Check the idle footprint**

```bash
systemctl --user status whatsapp-widget-backend.service --no-pager | grep Memory
top -b -n 3 -d 2 -p "$(systemctl --user show -p MainPID --value whatsapp-widget-backend.service)" | grep node
```

Expected: idle CPU at or near 0.0%, memory well under the 400M cap (Baileys with no Chromium should sit in the tens of MB). If idle CPU is not near zero, something is polling — find it before declaring done.

- [ ] **Step 6: Commit**

```bash
git add README.md .gitignore
git commit -m "docs: add README and install instructions"
```

---

## Self-Review Notes

**Spec coverage:** Backend/Baileys → Tasks 5, 7. Loopback TCP + token → Task 6. Dedicated PAM service + backoff → Tasks 3, 4. Own bounded store → Task 2. Compact repr + unread badge → Tasks 8, 12. Pairing/QR → Task 10. Chat list/messages/send → Task 11. Hide + one-time blur + badge suppression → Task 13. Lazy elapsed check + configurable threshold + PAM prompt → Task 14. Error/edge cases (backend down, session revoked, wrong password) → Tasks 5, 9, 14. Performance constraints → verified in Task 15 Step 5. systemd restart policy → Task 7.

**Known deviation from spec:** the spec's "Qt5Compat GraphicalEffects `FastBlur`" is implemented with `QtQuick.Effects` `MultiEffect` instead — the Qt 6 replacement, confirmed present on this system. Same one-time-cost property.

**Deferred to a later plan (explicitly out of v1 scope, matching the spec's non-goals):** media/attachments, group management, calls, multi-account, message search, and persisting the store across restarts (history re-syncs from WhatsApp on reconnect).
