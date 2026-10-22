#!/bin/bash
# Loads the fleet bearer from 1Password and starts the bell. The plist and the
# systemd unit call this. They do not contain the token.
set -euo pipefail
if [ -z "${CLAUDE_PEERS_TOKEN:-}" ]; then
  set -a
  eval "$(${HOME}/.local/bin/opa env claude-docs-integrations-keys.env)"
  set +a
fi
cd "$(dirname "$0")/.."
exec "${HOME}/.bun/bin/bun" bell.ts
