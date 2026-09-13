#!/usr/bin/env bash
# install.sh -- thin macOS/Linux entry point. Locates Node and hands off to
# scripts/install.js, which does all real work (slash commands, hooks,
# Codex MCP registration/skills -- see scripts/install.js --help).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found on PATH." >&2
  case "$(uname -s)" in
    Darwin)
      echo "Install it with Homebrew: brew install node" >&2
      ;;
    Linux)
      echo "Install it with your package manager, e.g.:" >&2
      echo "  sudo apt install nodejs npm   (Debian/Ubuntu)" >&2
      echo "  sudo dnf install nodejs       (Fedora)" >&2
      echo "or see https://nodejs.org/en/download" >&2
      ;;
    *)
      echo "See https://nodejs.org/en/download" >&2
      ;;
  esac
  echo "Node.js v22 or newer is required. Then re-run install.sh." >&2
  exit 1
fi

exec node "$SCRIPT_DIR/scripts/install.js" "$@"
