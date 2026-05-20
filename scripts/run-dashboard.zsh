#!/bin/zsh
set -euo pipefail

export CLAUDE_PEERS_BROKER_URL=http://100.69.233.7:7899
export CLAUDE_PEERS_TOKEN="$(jq -r '.mcpServers["claude-peers"].env.CLAUDE_PEERS_TOKEN' /Users/wesleyhines/.mcp.json)"
export CLAUDE_PEERS_DASHBOARD_CWD=/Users/wesleyhines/Work/active-projects/fleet-rebuild-2026-05
export CLAUDE_PEERS_DASHBOARD_GIT_ROOT=/Users/wesleyhines/Work/active-projects/fleet-rebuild-2026-05

cd /Users/wesleyhines/mcp-servers/claude-peers-mcp
exec /Users/wesleyhines/.bun/bin/bun dashboard-server.ts
