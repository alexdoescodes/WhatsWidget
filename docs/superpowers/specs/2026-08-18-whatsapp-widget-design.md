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
- **Transport:** HTTP + WebSocket server bound to a **Unix domain socket**
  (e.g. `$XDG_RUNTIME_DIR/whatsapp-widget.sock`), not a TCP port — scoped by
  filesystem permissions to the local user, tighter than "localhost TCP" now
  that a password check flows over this channel.
- **Session persistence:** Baileys `useMultiFileAuthState`, stored under
  `~/.local/share/whatsapp-widget/session/` (gitignored, never committed).
- **API surface (over the socket):**
  - `GET /status` — connection state: `disconnected | needs-pairing | connected`
  - `GET /qr` — current pairing QR as PNG, while `needs-pairing`
  - `GET /chats` — chat list with unread counts
  - `GET /chats/:id/messages` — recent messages for a chat
  - `POST /chats/:id/messages` — send a message
  - `WS /events` — push stream: new message, unread count changes, connection
    state changes (this is what lets the Plasmoid avoid polling)
  - `POST /unlock` — body: `{ password }`. Verifies against the local Unix
    account via PAM (`authenticate-pam` or equivalent native binding, backed
    by the system's `unix_chkpwd` helper — the same primitive KDE's own lock
    screen uses). Returns success/failure only; password is never logged or
    persisted.
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
- Unix domain socket avoids any network-stack overhead a TCP loopback socket
  would add.

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
      index.js          entrypoint: starts Baileys client + socket server
      whatsapp.js        Baileys client wrapper (connect, events, send)
      server.js          HTTP+WS server over the Unix domain socket
      auth-pam.js        PAM password verification for /unlock
    systemd/
      whatsapp-widget-backend.service
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

- Backend endpoints exercised directly (`curl --unix-socket`, `websocat`)
  before any QML is wired up, so the fragile WhatsApp-protocol layer is
  validated in isolation.
- Plasmoid iterated via `plasmoidviewer` for fast reload without installing
  into the full Plasma shell each time.
- Manual verification of the hide/reveal + PAM prompt flow, since PAM
  interaction isn't practical to fully automate.

## Known risks

- Baileys is a reverse-engineered protocol; WhatsApp changes can break it
  without notice, and using it is against WhatsApp's Terms of Service
  (ban risk on the linked account), same as any unofficial client.
- Plasma 6 QML API surface differs from Plasma 5 in places — implementation
  should target Plasma 6 APIs directly (confirmed installed: kscreenlocker
  6.7.2 / Plasma 6 on this system) rather than Plasma 5 compatibility shims.
