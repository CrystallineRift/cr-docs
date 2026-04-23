#!/usr/bin/env bash
# Serve the cr-docs static site locally.
# Usage: ./scripts/serve-docs.sh [port]

PORT="${1:-3000}"
DOCS_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Serving cr-docs at http://localhost:${PORT}"
echo "Press Ctrl+C to stop."

if command -v python3 &>/dev/null; then
  python3 -m http.server "$PORT" --directory "$DOCS_DIR"
elif command -v npx &>/dev/null; then
  npx serve "$DOCS_DIR" -p "$PORT" -s
else
  echo "Error: python3 or npx required." >&2
  exit 1
fi
