#!/bin/zsh
set -euo pipefail

export CLAUDE_PEERS_BROKER_URL=http://100.108.57.10:7899
export CLAUDE_PEERS_TOKEN="$(jq -r '.mcpServers["claude-peers"].env.CLAUDE_PEERS_TOKEN' /Users/wesleyhines/.claude.json)"

cd /Users/wesleyhines/mcp-servers/claude-peers-mcp
exec /Users/wesleyhines/.bun/bin/bun dashboard-server.ts
