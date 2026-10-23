# Peers wake

A send is stored, then the broker may ask the lead-wake edge. The edge is `lead-wake-edge.ts`, `dispatch.mjs`, and `protocol.mjs`. It starts a Mac T3 thread, or queues behind a turn that is already running. The mail stays in the broker. The wake text is `peers mail waiting; run check_messages`.

## What forwards

The broker calls `POST $LEAD_WAKE_URL` with `to_id`, `from_id`, `kind`, `message_id`, `cwd`, and `machine`. The bearer is `CLAUDE_PEERS_TOKEN`, or the first line of `CLAUDE_PEERS_TOKENS_FILE` when that variable is unset. The wait is 3 seconds.

It calls when the recipient has no row, the row is stale, its owner lease is dead, or the row's runtime has no push channel (`poll`, `codex`, `cursor`, `opencode`, `grok`). A live seat with a push channel is not forwarded.

A machine listed in the broker's `CLAUDE_PEERS_BELLS` file is woken by its own bell instead (`docs/bell.md`). lead-wake gets everything else: a machine with no bell, or a seat with no row or saved route. An id that is not `[a-zA-Z0-9_-]{3,64}` is stored as `wake: no-route` and the edge is not called. If `LEAD_WAKE_URL` is unset and no bell covers the seat, the wake is `unconfigured` (or `no-route` when bells are configured but the seat has no route) and the edge is not called.

The sender sees `wake: sent`, `failed`, `no-route`, or `unconfigured` on the same response. `no-route` and `failed` are errors. A live seat has no wake line.

The edge checks `routes.json` first. Otherwise it uses the one live thread whose `worktreePath` is under `~/.t3/worktrees/` and equals the cwd, and that thread is not a fork. Anything else is `no-route`. A broker retry sends the same T3 command id, taken from the message id.

A seat with the channel disabled registers as runtime `poll`, so a send to it forwards while it is up. Codex exits when its parent process changes, the same check the Claude server already has. The next send then finds no live row and forwards.

## Deploy

Hosts and paths belong in the operator's private deploy notes. The steps are the same everywhere:

1. Back up the checkout (`cp -a <checkout> <checkout>.bak-<date>`), then update it to the reviewed main.
2. Point the broker at the edge with `LEAD_WAKE_URL=http://<edge-host>:<port>/wake`. On the edge, set `CLAUDE_PEERS_BROKER_URL` and the bearer the broker sends (`CLAUDE_PEERS_TOKEN`, or the first line of `CLAUDE_PEERS_TOKENS_FILE`). Do not print the token.
3. Health-check the edge with that bearer. Restart the broker only when the check returns 200.

## Rollback

Restore the backup over the checkout, remove the `LEAD_WAKE_URL` setting, reload the service manager, and restart the broker.
