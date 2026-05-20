# Claude Peers Dashboard via Cloudflare Access

Local dashboard origin:

```sh
CLAUDE_PEERS_BROKER_URL=http://100.69.233.7:7899 \
CLAUDE_PEERS_TOKEN="$CLAUDE_PEERS_TOKEN" \
CLAUDE_PEERS_DASHBOARD_CWD=/Users/wesleyhines/Work/active-projects/fleet-rebuild-2026-05 \
CLAUDE_PEERS_DASHBOARD_GIT_ROOT=/Users/wesleyhines/Work/active-projects/fleet-rebuild-2026-05 \
bun dashboard-server.ts
```

Local URL:

```text
http://127.0.0.1:8799
```

Cloudflare Access app:

```text
Name: Claude Peers Dashboard
Hostname: peers.hinescreative.xyz
Access app ID: 875914e1-467e-4f66-988e-c2d63c1bdccc
Identity provider: Google
Policy: Allow Wes, wes@hinescreative.xyz
```

Tunnel target:

```text
peers.hinescreative.xyz -> http://127.0.0.1:8799
Tunnel ID: 3c488f37-2412-44e4-b2b0-66486ee4f97e
```

Security shape:

```text
Browser
  -> Cloudflare Access with Google auth
  -> Cloudflare Tunnel
  -> dashboard-server.ts on 127.0.0.1:8799
  -> broker at http://100.69.233.7:7899
```

Do not expose the broker directly. The dashboard proxy keeps `CLAUDE_PEERS_TOKEN` server-side.

The scoped `CLOUDFLARE_API_TOKEN` can create Access apps and policies, but tunnel create/update returned:

```text
10405 Method not allowed for this authentication scheme
```

The legacy `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` pair can manage Tunnel resources. It was used to create/configure the tunnel and DNS.

LaunchAgents:

```text
/Users/wesleyhines/Library/LaunchAgents/com.hinescreative.claude-peers-dashboard.plist
/Users/wesleyhines/Library/LaunchAgents/com.hinescreative.claude-peers-cloudflared.plist
```

Runtime scripts:

```text
/Users/wesleyhines/mcp-servers/claude-peers-mcp/scripts/run-dashboard.zsh
/Users/wesleyhines/mcp-servers/claude-peers-mcp/scripts/run-cloudflared.zsh
```

Tunnel token:

```text
/Users/wesleyhines/mcp-servers/claude-peers-mcp/.secrets/claude-peers-tunnel.token
```

Do not commit the `.secrets` directory.
