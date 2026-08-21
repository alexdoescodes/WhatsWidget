# WhatsApp Widget

An unofficial WhatsApp mini chat panel for KDE Plasma 6 — a real plasmoid that shows your
recent chats, lets you read and send messages, and can be censored behind an opaque scrim
that requires your login password to lift.

> **Unofficial.** This talks to WhatsApp through [Baileys](https://github.com/WhiskeySockets/Baileys),
> a reverse-engineered WhatsApp Web client. It is not affiliated with or endorsed by WhatsApp,
> and using it carries some risk to your account. The paired session in
> `~/.local/share/whatsapp-widget/session/` is a **full account credential** — anyone who
> copies that directory can read and send your messages. Never commit it or share it.

---

## What it looks like

- **Collapsed:** an icon in the panel with an unread-count badge.
- **Expanded:** a list of recent chats on the left, the selected conversation on the right,
  and a composer at the bottom.
- **Hidden:** one click paints an opaque scrim over the whole panel. Reveal it again within
  the configured window and it just opens; leave it hidden longer and it asks for your
  login password.

---

## Architecture

Two pieces that talk over loopback HTTP:

```
┌──────────────────────────┐         ┌───────────────────────────────┐
│  plasmoid (QML)          │         │  backend (Node, systemd user  │
│  org.kde.plasma.         │  HTTP   │  service)                     │
│  whatsappwidget          │ ──────► │                               │
│                          │  + WS   │  • Baileys → WhatsApp         │
│  runs inside plasmashell │ ◄────── │  • bounded in-memory store    │
└──────────────────────────┘         │  • PAM password check         │
                                     └───────────────────────────────┘
```

The backend binds to `127.0.0.1` on a **random port** and writes both the port and a
freshly generated bearer token to:

```
$XDG_RUNTIME_DIR/whatsapp-widget-endpoint.json   (mode 0600)
```

The plasmoid reads that file to find the backend. Every HTTP request and the WebSocket
upgrade require *both* a loopback peer address *and* `Authorization: Bearer <token>`.
(The one exception: the WebSocket upgrade also accepts `?token=`, because QML's `WebSocket`
cannot set request headers. That query form is accepted on the upgrade path **only**.)

Two things are persisted: the WhatsApp session directory and a chat cache at
`~/.local/share/whatsapp-widget/chats.json` (mode `0600`).

The cache exists because **WhatsApp only hands over history when a device is linked.**
Without it, every restart — a reboot, a logout, a crash — leaves an empty chat list that
can only be refilled by unlinking the device and scanning a QR again. It holds message
text, which is worth knowing; it sits beside the session directory, which is a strictly
more powerful secret, since anyone holding that can read every message live and send as
you. Delete `chats.json` at any time to clear it; the widget refills what it can.

Beyond those, only one plasmoid config key.
Chats and messages live in a bounded in-memory store (200 chats, 50 messages each) that is
discarded when the backend stops.

### Layout

| Path | What it is |
|---|---|
| `backend/src/index.js` | entrypoint — wires everything, handles SIGINT/SIGTERM |
| `backend/src/server.js` | HTTP + WebSocket API, token and loopback enforcement |
| `backend/src/whatsapp.js` | Baileys client wrapper, status and QR handling |
| `backend/src/store.js` | bounded chat/message store, unread counts |
| `backend/src/auth-pam.js` | PAM password check with in-memory exponential backoff |
| `backend/src/config.js` | resolves all paths and tunables from the environment |
| `backend/tools/check-pam.js` | interactive one-off: is the PAM service wired up? |
| `packaging/pam/whatsapp-widget` | the PAM service definition |
| `packaging/install-pam.sh` | installs it to `/etc/pam.d/` (needs sudo) |
| `packaging/install-service.sh` | installs the systemd **user** service (no sudo) |
| `plasmoid/` | the KDE plasmoid package |

---

## Requirements

- **KDE Plasma 6** (developed against 6.7.2, Qt 6.11.1)
- **Node.js ≥ 18.2 and < 23** — see [Node version coupling](#node-version-coupling-read-this)
- A Linux system using `pam_unix` for local passwords
- `git` with **SSH access to GitHub** for `npm ci` — see below
- Root access once, to install the PAM service file

---

## Install

### 1. Backend dependencies

```bash
cd backend
npm ci
```

> **`npm ci` needs GitHub SSH access.** Baileys depends on `libsignal`, which the lockfile
> resolves as `git+ssh://git@github.com/whiskeysockets/libsignal-node.git#<sha>` — not from
> the npm registry. If you see `Permission denied (publickey)` or `Host key verification
> failed`, your SSH key is the problem, not the package. Check with `ssh -T git@github.com`.
> To use HTTPS instead:
>
> ```bash
> git config --global url."https://github.com/".insteadOf ssh://git@github.com/
> ```

### 2. PAM service (once, needs sudo)

```bash
./packaging/install-pam.sh
```

This installs `packaging/pam/whatsapp-widget` to `/etc/pam.d/whatsapp-widget`. It shows a
diff first if the file already exists.

**Why a dedicated PAM service.** The stock services on most systems
(`login` → `system-local-login` → `system-auth`) pull in `pam_faillock`, which with default
settings locks your **real user account** for 10 minutes after 3 failures. A mistyped
password in a chat widget must never be able to lock you out of your own machine, so this
service uses `pam_unix` alone. Brute-force protection is handled in the backend instead
(see [Security model](#security-model)).

Verify it works — this prompts for your password interactively:

```bash
cd backend && node tools/check-pam.js
```

### 3. Backend service

```bash
./packaging/install-service.sh
```

This resolves the `node` currently on your `PATH`, **verifies the native PAM addon actually
loads under it**, and only then writes and enables the user unit. If the addon can't load it
refuses to install and tells you how to fix it — it will not leave you with a crash-looping
service.

```bash
systemctl --user status whatsapp-widget-backend
journalctl --user -u whatsapp-widget-backend -f
```

> `backend/systemd/whatsapp-widget-backend.service` is kept in the repo as a **reference
> template only**. Do not copy it into `~/.config/systemd/user/` yourself: its
> `ExecStart=/usr/bin/env node` line is exactly the failure mode `install-service.sh` exists
> to prevent (see below). Always install via the script.

### 4. The plasmoid

```bash
kpackagetool6 --type Plasma/Applet --install ./plasmoid
systemctl --user restart plasma-plasmashell
```

Then right-click your desktop or panel → *Add Widgets…* → **WhatsApp Widget**.

### 5. Pair with your phone

Open the widget. It shows a QR code. On your phone: **WhatsApp → Settings → Linked devices →
Link a device**, and scan it. The QR refreshes automatically while the pairing view is open.

Once paired, the session persists in `~/.local/share/whatsapp-widget/session/` and you won't
be asked again.

---

## Node version coupling (read this)

`authenticate-pam` is a **native addon**. It is compiled against one specific Node ABI, and
it will refuse to load under a different one:

```
Error: The module '.../authenticate_pam.node' was compiled against a different Node.js
version using NODE_MODULE_VERSION 115. This version of Node.js requires
NODE_MODULE_VERSION 147.
```

Measured on this project:

| Node | Result |
|---|---|
| 20.20.2 (ABI 115) | builds and loads |
| 22.23.1 | builds and loads |
| 26.4.0 (ABI 147) | **does not compile at all** — its `NODE_MODULE` macro usage is rejected by Node 26's headers |

Hence `"engines": { "node": ">=18.2 <23" }` in `backend/package.json`.

**After upgrading Node, switching nvm versions, or anything else that changes your
interpreter, you must rebuild and reinstall:**

```bash
cd backend && npm rebuild authenticate-pam
../packaging/install-service.sh
```

### Why the unit needs an absolute path to `node`

**A systemd user unit does not inherit your shell's `PATH`.** If the unit says
`ExecStart=/usr/bin/env node`, systemd resolves whatever `node` it happens to find —
typically the distro's `/usr/bin/node` — which is usually *not* the nvm-managed node you ran
`npm install` with. The ABI mismatch above then kills the service on every start, and
`Restart=on-failure` turns that into a crash loop.

`install-service.sh` avoids this by resolving `command -v node` **at install time** and
writing that absolute path into the unit literally. This is also why installing the service
is a script rather than a checked-in unit file.

---

## Plasmashell caches QML

Editing a `.qml` file — or even reinstalling the package — does **not** affect an
already-running widget. plasmashell holds the compiled QML in memory. After any change:

```bash
kpackagetool6 --type Plasma/Applet --upgrade ./plasmoid
systemctl --user restart plasma-plasmashell
```

If you skip the restart you will be looking at the old code and debugging a ghost. (This
cost real time during development: a healthy backend appeared "broken" because plasmashell
was still running a months-old skeleton that hardcoded a red status dot.)

---

## The hide / password gate

Click the hide button and an **opaque** scrim covers the panel. While hidden, the chat
content is not rendered at all, so a message arriving behind the scrim repaints nothing and
nothing can leak through — including on themes that use translucent background colours.

**Widget settings → General → "Require password after hidden for"** controls the threshold:

- **`5 minutes`** (default) — reveal is free within 5 minutes of hiding; after that it asks
  for your login password.
- **`Always` (0)** — every reveal asks.
- Up to 1440 minutes (24 h).

The password is checked by the backend against PAM. It is never logged, never persisted,
never put in a URL, and never held in any property that outlives the request.

The gate **fails closed**: a missing or corrupt hide timestamp, a clock that moved backwards,
a missing or non-numeric config value, a timed-out request, or an unreachable backend all
result in the password being required — never in a free reveal.

Changing the setting while the panel is already hidden can only ever make the gate
*stricter*. The threshold is snapshotted when you hide, and the gate uses the stricter of
that snapshot and the current setting. This matters because the config dialog is reachable
from Plasma's applet context menu, which the widget does not own and cannot gate — without
the snapshot, anyone at an unlocked desktop could raise the limit to 24 hours and turn a
live password prompt back into a free Reveal button.

**Known limitation:** the hidden state lives in QML properties, so restarting plasmashell
drops it and the panel comes back visible. In practice this is not much of a boundary —
anyone who can restart plasmashell already has your shell, and with it the session directory,
which is a full account credential regardless.

---

## Security model

| Concern | Mitigation |
|---|---|
| Other local users reaching the API | Bound to `127.0.0.1`; peer address checked on every request |
| Other processes of *your* user reaching the API | Bearer token in a `0600` file under `$XDG_RUNTIME_DIR` (this is a speed bump, not a wall — same-uid processes can read it) |
| Token leaking via process lists | The token is never passed on a command line; only the file path is |
| Brute-forcing the unlock | In-memory exponential backoff in the backend: `2^n` seconds, capped at 30 s, reserved *synchronously* so parallel requests can't race past it |
| Locking you out of your account | Dedicated PAM service with no `pam_faillock`. Verify with `faillock --user "$USER"` — it should stay empty no matter how many times you mistype |
| Password disclosure | Never logged, persisted, echoed, or placed in a URL; the field uses `echoMode: Password` and sensitive-data input hints |
| Session theft | `~/.local/share/whatsapp-widget/session/` is git-ignored by several overlapping patterns; treat it as a credential |

`NoNewPrivileges` is deliberately **`false`** in the systemd unit. PAM's password check runs
the setuid helper `/usr/bin/unix_chkpwd`, which cannot work otherwise. Do not "harden" this
without replacing the auth mechanism.

---

## HTTP API

All routes require a loopback peer and `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/status` | connection status and total unread |
| `GET` | `/qr` | pairing QR as a PNG (404 when not pairing) |
| `GET` | `/chats` | recent chats |
| `GET` | `/chats/<jid>/messages` | messages in one chat |
| `POST` | `/chats/<jid>/messages` | send — body `{"text": "..."}` |
| `POST` | `/chats/<jid>/read` | mark a chat read |
| `POST` | `/unlock` | verify a password — body `{"password": "..."}` |
| `WS` | `/events` | push: `status`, `message`, `unread` |

`/unlock` returns `200 {ok:true}`, `401 {ok:false, reason:"invalid", retryAfterMs}`, or
`429 {ok:false, reason:"throttled", retryAfterMs}`.

Poking at it by hand:

```bash
EP="$XDG_RUNTIME_DIR/whatsapp-widget-endpoint.json"
eval "$(node -e 'const e=require(process.argv[1]);console.log(`PORT=${e.port};TOKEN=${e.token}`)' "$EP")"
curl -s --max-time 5 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/status"
```

> Use `--max-time` on the WebSocket upgrade — a successful `101` holds the connection open
> and `curl` will appear to hang.

---

## Development

```bash
cd backend && npm test          # node:test, 38 tests
qmllint plasmoid/contents/ui/*.qml
```

Testing QML in isolation, without touching the live desktop:

```bash
QT_QPA_PLATFORM=offscreen qml6 harness.qml
```

This is how the widget's behaviour was actually verified — driving the real committed QML
files under stubbed Plasma modules, and using `grabToImage` plus pixel counting to prove the
scrim occludes rather than assuming it does.

### Qt/QML gotchas found the hard way

These are measured on Plasma 6.7.2 / Qt 6.11.1, and several contradict the documentation:

- `xhr.ontimeout` **does not exist**. `xhr.timeout` is settable and reads back, but never
  fires. Use a guard `Timer` and `abort()`.
- `XMLHttpRequest` refuses `file://` URLs unless the host sets `QML_XHR_ALLOW_FILE_READ=1`.
  plasmashell does not, which is why the endpoint file is read via a `DataSource` running
  `cat`.
- `WebSocket` cannot set request headers — hence the `?token=` concession on the upgrade.
- Setting `socket.active = false` emits **no** status change; only the reopen does.
- `plasmoid.rootItem` does not exist. Plasma injects `root` as the `PlasmoidItem`.
- `PlasmaExtras.ScrollArea` does not exist in Plasma 6; `PlasmaComponents.ScrollView` does.
- `Qt.btoa` mangles binary data — it is not usable for base64-encoding a PNG.
- A plasmoid config page root must be `KCM.SimpleKCM`, not a bare `Kirigami.FormLayout` —
  Plasma pushes it into a `Kirigami.PageRow` and sets `title` on it.

---

## Troubleshooting

**Red status dot with a backend that is clearly running.**
plasmashell is running cached QML. `kpackagetool6 --upgrade` then restart plasmashell.
Confirm the socket is actually up: `ss -tnp | grep <port>`.

**Service won't start / `ERR_DLOPEN_FAILED`.**
Node ABI mismatch. `cd backend && npm rebuild authenticate-pam && ../packaging/install-service.sh`.

**`Unit whatsapp-widget-backend.service not found`.**
It was never installed. Run `./packaging/install-service.sh`.

**Unlock always fails, even with the right password.**
The widget is probably fine — test PAM in isolation with
`cd backend && node tools/check-pam.js`. If that fails too, check
`/etc/pam.d/whatsapp-widget` exists and is mode `0644`, and look for
`pam_unix(whatsapp-widget:auth)` lines in `journalctl --user -u whatsapp-widget-backend`.

**"Too many attempts. Try again in Ns."**
Working as intended — that is the backend's exponential backoff. Wait it out. Note that a
*rejected* PAM attempt itself takes ~2.3 s, because `pam_unix` delays failures.

**Stuck on the QR code.**
The QR expires quickly. Make sure the widget is open and expanded while you scan — the
refresh timer only runs when the pairing view is actually visible.

---

## Uninstall

```bash
systemctl --user disable --now whatsapp-widget-backend
rm ~/.config/systemd/user/whatsapp-widget-backend.service
systemctl --user daemon-reload

kpackagetool6 --type Plasma/Applet --remove org.kde.plasma.whatsappwidget
systemctl --user restart plasma-plasmashell

sudo rm /etc/pam.d/whatsapp-widget
rm -rf ~/.local/share/whatsapp-widget      # unlinks the device; deletes the session
```

To unlink from the phone's side as well: **WhatsApp → Settings → Linked devices** → tap the
device → **Log out**.

---

## License

MIT.
