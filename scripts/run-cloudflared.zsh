#!/bin/zsh
set -euo pipefail

exec /opt/homebrew/bin/cloudflared tunnel \
  --loglevel info \
  --no-autoupdate \
  run \
  --token-file /Users/wesleyhines/mcp-servers/claude-peers-mcp/.secrets/claude-peers-tunnel.token
