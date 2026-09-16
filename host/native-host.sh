#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${GROK_BROWSER_NODE:-}" ] && [ -x "${GROK_BROWSER_NODE}" ]; then
  NODE_BIN="$GROK_BROWSER_NODE"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x /opt/homebrew/bin/node ]; then
  NODE_BIN=/opt/homebrew/bin/node
elif [ -x /usr/local/bin/node ]; then
  NODE_BIN=/usr/local/bin/node
else
  NODE_BIN="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1 || true)"
fi
if [ -z "${NODE_BIN:-}" ] || [ ! -x "$NODE_BIN" ]; then
  echo "grok-browser-use native host: node not found" >&2
  exit 1
fi
exec "$NODE_BIN" "$ROOT/host/native-host.mjs"
