# Grok Chat MCP edge

Thin public MCP in front of the live broker. Not a second bus.

```
Grok Chat Custom connector
  → Cloudflare Tunnel → 127.0.0.1:8787/mcp
  → Tailscale → 100.108.57.10:7899
```

## Tools

- `list_peers`
- `send_message` (`to_id`, `message`) — `from_id` pinned to `grok-chat`
- `check_messages` — poll the `grok-chat` queue

No `set_summary`, `register`, `unregister`, `set_state`, jobs, infer, FS, CRM.

## Run on theoldone / iMac (same host as broker or any tailnet node that can hit it)

```sh
cd ~/mcp-servers/claude-peers-mcp

GROK_MCP_TOKEN="$(openssl rand -hex 24)" \
CLAUDE_PEERS_TOKEN="$CLAUDE_PEERS_TOKEN" \
CLAUDE_PEERS_BROKER_URL=http://100.108.57.10:7899 \
GROK_PEER_ID=grok-chat \
GROK_EDGE_HOST=127.0.0.1 \
GROK_EDGE_PORT=8787 \
bun grok-edge.ts
```

Optional allowlist:

```sh
GROK_PEER_ALLOWLIST=pc-nagatha-session-no-tty,pc-hal-no-tty,tony,clarvis,pc-grok-session-no-tty
```

## Cloudflare

Reuse the existing tunnel habit. New hostname, new origin. Do not point it at :7899.

```text
mcp.hinescreative.xyz  →  http://127.0.0.1:8787
```

Grok Chat → Connectors → Custom:

```text
URL:  https://mcp.hinescreative.xyz/mcp
Auth: Bearer GROK_MCP_TOKEN
```

Do not put `CLAUDE_PEERS_TOKEN` in the Grok connector. That token stays on the tailnet.

Cloudflare Access in front will likely break Grok's connector handshake. Use the edge bearer first.

## Seat

On boot the edge registers `grok-chat` and heartbeats every 15s so replies have a mailbox. If the edge dies, the broker TTL (20 min) drops the seat and undelivered mail.

Peers reply to `grok-chat`, not to a nickname.
