# WhatsApp Desktop Widget — Design

Date: 2026-08-18
Status: Approved by user, pending implementation plan

## Overview

A KDE Plasma widget (Plasmoid) that gives a persistent, panel/desktop-docked
mini chat panel for WhatsApp, using the unofficial WhatsApp Web multi-device
protocol (no official WhatsApp API exists for personal accounts).

## Goals

- Native-feeling KDE Plasmoid (compact panel icon + expandable full chat panel)
- View chat list, read messages, send messages without opening a browser
- Unread badge visible from the compact/panel representation
- A "hide/censor" privacy mode that blurs the widget and, after being hidden
  longer than a configurable threshold, requires the user's OS login password
  to reveal again
- Low idle CPU/RAM footprint — this runs continuously on a laptop

## Non-goals

- Not a full WhatsApp Web replacement (no media gallery, calls, groups admin
  tooling, etc. in v1)
- Not multi-account
- No official WhatsApp Business API integration

## Architecture

Two isolated components:

```
┌─────────────────────┐        Unix domain socket        ┌──────────────────────────┐
│  Plasmoid (QML)      │  <-- HTTP+WS over unix socket --> │  Backend service (Node)  │
│  - Compact repr.     │                                    │  - Baileys WA client     │
│  - Full repr. (chat) │                                    │  - Session persistence   │
│  - Hide/censor state │                                    │  - PAM password check    │
│  - Config page       │                                    │                          │
└─────────────────────┘                                    └──────────────┬───────────┘
                                                                            │ WebSocket
                                                                            ▼
                                                                 WhatsApp Web servers
```

The backend owns everything fragile/system-level (WhatsApp session, PAM auth).
The Plasmoid only renders state and calls the backend's local API. This keeps
the reverse-engineered protocol code isolated, independently testable via
`curl`/`websocat` against the socket, and replaceable without touching QML.

## Backend service (Node.js)

- **Library:** [Baileys](https://github.com/WhiskeySockets/Baileys) — WebSocket-based
  reimplementation of the WhatsApp Web multi-device protocol. Chosen over
  `whatsapp-web.js` because it doesn't require a bundled headless Chromium
  (Puppeteer), which would cost ~200-300MB RAM and meaningfully more CPU for
  a process meant to run continuously in the background. Baileys is
  event-driven (no polling), which also matches the low-idle-footprint goal.
- **Transport:** HTTP + WebSocket server bound to **127.0.0.1 on an ephemeral
  port, protected by a bearer token**.

  *(Revised 2026-08-18 during planning. The original design specified a Unix
  domain socket. Verified constraint: Plasma 6 QML can only reach the backend
  via `XMLHttpRequest` and the `QtWebSockets` `WebSocket` type — both of which
  speak TCP only, with no QML binding for `QLocalSocket`. A Unix socket would
  have required shelling out to `curl --unix-socket` per request, which defeats
  the low-overhead goal. Loopback TCP is therefore required.)*

  To compensate for loopback TCP being reachable by any local process, the
  backend generates a random 32-byte token at startup and writes
  `{port, token}` to `$XDG_RUNTIME_DIR/whatsapp-widget-endpoint.json` with
  mode `0600`. Every HTTP request and the WebSocket handshake must present
  `Authorization: Bearer <token>`. Requests from a non-loopback address are
  rejected outright.
- **Version pin: `baileys@6.7.24`.** The `latest` dist-tag currently points at
  `7.0.0-rc14`, a release candidate that pulls in a `whatsapp-rust-bridge`
  native dependency; `6.7.24` is the stable line (tagged `legacy`). Pin
  exactly — a background service should not track an RC.
- **Session persistence:** Baileys `useMultiFileAuthState`, stored under
  `~/.local/share/whatsapp-widget/session/` (gitignored, never committed).
- **Own message store required.** Verified: Baileys 6.7.24 no longer exports
  `makeInMemoryStore` (removed upstream). The backend therefore keeps its own
  small in-memory store fed by Baileys events, bounded to the most recent 50
  messages per chat and 200 chats, so idle memory stays flat instead of
  growing with history.
- **API surface (over the socket):**
  - `GET /status` — connection state: `disconnected | needs-pairing | connected`
  - `GET /qr` — current pairing QR as PNG, while `needs-pairing`
  - `GET /chats` — chat list with unread counts
  - `GET /chats/:id/messages` — recent messages for a chat
  - `POST /chats/:id/messages` — send a message
  - `WS /events` — push stream: new message, unread count changes, connection
    state changes (this is what lets the Plasmoid avoid polling)
  - `POST /unlock` — body: `{ password }`. Verifies the user's real login
    password via PAM using the `authenticate-pam` native binding (confirmed
    to compile on this system; backed by the setuid `unix_chkpwd` helper,
    which is what allows an unprivileged process to verify its own user's
    password). Returns success/failure only; the password is never logged,
    persisted, or echoed back.

  **PAM service: a dedicated `whatsapp-widget` service, not an existing one.**
  Verified on this system:
  - `/etc/pam.d/kscreenlocker` is unusable — it delegates auth solely to
    Howdy (`pam_python.so /usr/lib/security/howdy/pam.py`) and that script is
    missing, with no password fallback line.
  - Every general-purpose service (`login` → `system-local-login` →
    `system-auth`) runs `pam_faillock`, and there is no `/etc/faillock.conf`,
    so defaults apply: **3 failures locks the real user account for 10
    minutes.** Routing a chat widget's privacy prompt through those services
    would let three mistyped entries lock the user out of their own laptop.

  Therefore setup installs `/etc/pam.d/whatsapp-widget` (one-time `sudo`)
  containing only `pam_unix` for auth/account, with no `pam_faillock`. Failed
  widget unlocks then cannot affect system login. Brute-force protection is
  not lost — it moves into the backend as exponential backoff (see below).

- **Unlock throttling:** the backend tracks consecutive failures and blocks
  further attempts for `min(2^failures × 1000ms, 30s)`. This replaces the
  `pam_faillock` protection given up above, without touching system state.
- **Autostart:** launched as a systemd `--user` service (or Plasma autostart
  desktop file) so it's running before the widget loads; the Plasmoid also
  attempts to start it if the socket isn't present.

## Plasmoid (QML)

- **Compact representation:** WhatsApp icon in the panel/system tray with a
  small unread-count badge, driven by the `WS /events` push stream (no
  polling timer). While hidden (see below), the badge/preview is suppressed.
- **Full representation:** chat list + message view + send box, backed by
  `GET /chats`, `GET /chats/:id/messages`, `POST /chats/:id/messages`.
- **Pairing flow:** when backend status is `needs-pairing`, full
  representation shows the QR image from `GET /qr` with "Scan with WhatsApp →
  Linked Devices" instructions. Automatically switches to chat view once
  `WS /events` reports `connected`.

### Hide/censor feature

- A hide toggle (Breeze eye-slash icon) in the full representation header.
- On hide: chat content is replaced with a **single, one-time-computed**
  blurred snapshot (Qt5Compat GraphicalEffects `FastBlur` applied once, not
  re-rendered continuously) plus a lock icon, styled from the active Plasma
  theme's colors — not a plain black box, and not a live/continuous blur
  (keeps GPU cost negligible). Compact badge also suppresses the unread
  count/message preview while hidden.
- `hiddenSince` timestamp is recorded on hide. No interval/ticking timer runs
  in the background — elapsed time is computed lazily (`Date.now() -
  hiddenSince`) only at the moment the user clicks to reveal.
- On reveal attempt:
  - elapsed < configured threshold → unhide immediately, no prompt
  - elapsed >= threshold → inline password field appears; entered password
    is POSTed to the backend's `/unlock` endpoint over the Unix socket;
    success reveals and clears `hiddenSince`, failure keeps content hidden
    and shows an inline error (no lockout/rate-limiting in v1)
- **Config:** widget settings page ("General" tab) has a spinbox: "Require
  password after hidden for: N minutes", default 5, persisted via the
  Plasmoid's standard `config.xml`/`Config.qml` mechanism.

## Performance constraints (explicit, per user request)

- Backend: single persistent Node process, event-driven throughout (Baileys
  WebSocket + our own WS push to the widget) — no polling loops anywhere in
  the system.
- No Puppeteer/Chromium — Baileys keeps backend RAM in the tens-of-MB range
  rather than hundreds.
- Blur effect computed once per hide-toggle, not per-frame.
- No `setInterval`-driven countdown for the unlock timer — elapsed time
  checked lazily on demand.
- Message store bounded (50 messages × 200 chats) so memory does not grow
  with chat history.
- Loopback TCP was forced by the QML constraint above; its overhead is
  negligible next to the avoided Chromium process.

## Error handling & edge cases

- Backend unreachable/socket missing → compact representation shows a
  disconnected indicator; full representation shows a "start service" action.
- WhatsApp session invalidated remotely (unlinked from phone) → backend
  reports `needs-pairing` again; widget falls back to QR flow automatically.
- Wrong unlock password → stays hidden, inline error, no attempt limit in v1.
- Backend crash → systemd `--user` service restart policy (`Restart=on-failure`).

## Project layout

```
whatsapp-widget/
  backend/
    package.json
    src/
      index.js           entrypoint: wires client + store + server
      config.js          XDG paths, PAM service name, store bounds
      whatsapp.js        Baileys client wrapper (connect, events, send)
      store.js           bounded in-memory chat/message store
      server.js          HTTP+WS server, loopback TCP + bearer token
      auth-pam.js        PAM password verification + backoff for /unlock
    test/                node:test unit tests
    systemd/
      whatsapp-widget-backend.service
  packaging/
    pam/whatsapp-widget  PAM service file installed to /etc/pam.d/
    install-pam.sh       one-time sudo installer for the above
  plasmoid/
    metadata.json
    contents/
      ui/
        main.qml
        CompactRepresentation.qml
        FullRepresentation.qml
        ConfigGeneral.qml
      config/
        config.xml
  docs/
    superpowers/specs/   (this design doc and future ones)
  README.md
  .gitignore             (excludes session/, node_modules/)
```

## Testing strategy

- Unit tests run on Node's built-in `node:test` runner — no extra test
  dependency, consistent with the lightweight goal.
- Backend endpoints exercised directly with `curl -H "Authorization: Bearer
  <token>"` before any QML is wired up, so the fragile WhatsApp-protocol
  layer is validated in isolation.
- Plasmoid iterated via `plasmoidviewer` for fast reload without restarting
  the shell. Note: `plasmoidviewer` is **not currently installed** — it ships
  in the `plasma-sdk` package and setup installs it. `kpackagetool6` (needed
  to install the widget) is already present.
- Manual verification of the hide/reveal + PAM prompt flow, since PAM
  interaction isn't practical to fully automate.

## Known risks

- Baileys is a reverse-engineered protocol; WhatsApp changes can break it
  without notice, and using it is against WhatsApp's Terms of Service
  (ban risk on the linked account), same as any unofficial client.
- Plasma 6 QML API surface differs from Plasma 5 in places — implementation
  should target Plasma 6 APIs directly (confirmed installed: kscreenlocker
  6.7.2 / Plasma 6 on this system) rather than Plasma 5 compatibility shims.
