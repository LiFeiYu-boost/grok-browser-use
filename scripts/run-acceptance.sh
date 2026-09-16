#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not found" >&2
  exit 1
fi
"$NODE_BIN" "$ROOT/tests/test-framing.mjs"
exec "$NODE_BIN" "$ROOT/tests/acceptance.mjs"
