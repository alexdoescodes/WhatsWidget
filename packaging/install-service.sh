#!/usr/bin/env bash
set -euo pipefail

# Installs the backend as a systemd *user* service.
#
# Why this script exists rather than a checked-in unit file: the unit must name
# the Node interpreter by ABSOLUTE PATH. A systemd user unit does not inherit
# your shell's PATH, so `ExecStart=/usr/bin/env node` resolves whatever node
# systemd happens to find -- typically the distro's /usr/bin/node, which is
# usually NOT the node you ran `npm install` with. The authenticate-pam native
# addon is compiled against one specific Node ABI, so a mismatch makes the
# service die at startup with:
#
#   Error: The module '.../authenticate_pam.node' was compiled against a
#   different Node.js version using NODE_MODULE_VERSION <x>. This version of
#   Node.js requires NODE_MODULE_VERSION <y>.
#
# This script therefore resolves the node on YOUR PATH at install time -- the
# same one that built the addon -- and writes it into the unit literally.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/whatsapp-widget-backend.service"
ENTRY="$REPO/backend/src/index.js"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: no 'node' on PATH. Install Node, or activate the version you built with (e.g. 'nvm use')." >&2
  exit 1
fi
NODE_BIN="$(readlink -f "$NODE_BIN")"

if [[ ! -f "$ENTRY" ]]; then
  echo "error: backend entrypoint not found at $ENTRY" >&2
  exit 1
fi

if [[ ! -f "$REPO/backend/node_modules/authenticate-pam/build/Release/authenticate_pam.node" ]]; then
  echo "error: authenticate-pam is not built. Run 'cd backend && npm install' first." >&2
  exit 1
fi

# Fail before installing, not after, if the addon can't load under this node.
if ! "$NODE_BIN" -e "require('$REPO/backend/node_modules/authenticate-pam')" 2>/dev/null; then
  echo "error: authenticate-pam cannot load under $NODE_BIN ($("$NODE_BIN" -v))." >&2
  echo "       The addon was built against a different Node ABI. Fix with:" >&2
  echo "         cd $REPO/backend && npm rebuild authenticate-pam" >&2
  echo "       run under the SAME node you want the service to use." >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"

cat > "$UNIT" <<EOF
[Unit]
Description=WhatsApp widget backend
After=graphical-session.target

[Service]
Type=simple
# Absolute path, resolved by packaging/install-service.sh at install time.
# Do NOT replace this with "/usr/bin/env node" -- see that script's comments.
ExecStart=$NODE_BIN $ENTRY
Restart=on-failure
RestartSec=5
# PAM's password check runs the setuid helper /usr/bin/unix_chkpwd, which
# cannot work under NoNewPrivileges. Leave this false.
NoNewPrivileges=false
MemoryMax=400M

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now whatsapp-widget-backend

echo "Installed $UNIT"
echo "  node:  $NODE_BIN ($("$NODE_BIN" -v))"
echo "  entry: $ENTRY"
echo
echo "Status:  systemctl --user status whatsapp-widget-backend"
echo "Logs:    journalctl --user -u whatsapp-widget-backend -f"
echo
echo "NOTE: after upgrading or switching Node, re-run:"
echo "  cd $REPO/backend && npm rebuild authenticate-pam && $0"
