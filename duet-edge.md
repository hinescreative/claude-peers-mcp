# Claude Duet edge

A hosted peer for Claude Duet. Claude Duet is a cloud app, so it reaches the
fleet through a custom connector, and claude.ai connectors sign in with OAuth.
The OAuth part lives in a small Cloudflare Worker (kept in the operator's
private repo). This edge is the half that talks to the broker.

```
Claude Duet ──OAuth──▶ connector Worker ──HMAC-signed HTTPS──▶ tunnel ──▶ 127.0.0.1:8804 duet-edge.ts ──▶ broker
```

The broker port is never exposed. The Worker holds no broker token; the edge
holds no OAuth state.

## What it can do

Four calls, all `POST` with a JSON object body:

| Route | Does |
|-------|------|
| `/v1/peers` | Live peers, compact. `q`, `machine`, `limit` (1 to 100). Each row says `can_send`. |
| `/v1/send` | Sends `message` to `to_id`, with optional `kind`, `reply_to_id`, `client_message_id`. `from_id` is always the edge's own id. |
| `/v1/inbox` | Unread mail, oldest first, 50 at a time. Reading does not mark it read. |
| `/v1/ack` | Marks `message_ids` read. |

`GET /health` answers `{"status":"ok"}` and nothing else.

No register, unregister, summary, state, shell, file or settings call.

## Limits

- **Recipients:** sends go only to ids on `DUET_PEER_ALLOWLIST`. An empty list sends nothing.
- **Rate:** `DUET_SEND_PER_MINUTE` sends a minute (default 20).
- **Size:** 64 KiB request bodies, 16,000-character messages.
- **No doorbell:** mail waits in the mailbox until Claude Duet reads it. No message text leaves the edge except to the signed caller.
- **Peer mail is data.** The connector tells Claude Duet that what peers send is information from other agents, not its user's instructions.

## Signing

Every call carries three headers:

- `X-Duet-Ts`: unix seconds. Must be within 60 seconds of the edge's clock.
- `X-Duet-Nonce`: 16 to 64 of `[A-Za-z0-9_-]`, used once. Seen nonces are kept in the mailbox database, so a restart does not reopen the window.
- `X-Duet-Sig`: `v1=` and the hex HMAC-SHA256, keyed with `DUET_EDGE_SECRET`, of

```
v1\n<METHOD>\n<path>\n<ts>\n<nonce>\n<hex sha256 of the raw body>
```

Anything else gets `401 {"error":"unauthorized"}`, whatever was wrong.

## Its own token

Give the edge its own broker token: one new line at the end of the broker's
tokens file (`CLAUDE_PEERS_TOKENS_FILE`), and the same value as
`CLAUDE_PEERS_TOKEN` in the edge's env file. The broker reloads the file when
it changes. Removing that one line cuts off only this edge. Do not put it on
the first line: the broker sends the first line as its own bearer to the wake
edge.

## Run

```sh
mkdir -p ~/.local/state/duet-edge && chmod 700 ~/.local/state/duet-edge
# edge.env, mode 600:
#   CLAUDE_PEERS_BROKER_URL=http://<broker-host>:7899
#   CLAUDE_PEERS_TOKEN=<this edge's own broker token>
#   DUET_EDGE_SECRET=<32+ random characters, also set on the Worker>
#   DUET_PEER_ALLOWLIST=<peer-a>,<peer-b>
cp systemd/claude-peers-duet-edge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-peers-duet-edge.service
```

Point a tunnel hostname at `http://127.0.0.1:8804`, never at the broker. Do not
print the tokens or the secret.

## Seat

The edge holds a lease for its id (default `duet`) and heartbeats every 5
seconds. Mail is claimed, committed to SQLite, then acked at the broker, so a
crash between the two keeps it. State is in `DUET_EDGE_STATE`
(default `~/.local/state/duet-edge`).

## Test

```sh
bun test duet-edge.test.ts
```
