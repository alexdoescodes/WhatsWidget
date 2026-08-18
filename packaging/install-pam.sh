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
