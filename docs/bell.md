# Peers bell

One process per T3 host. Peer id `bell-<machine>` (the Mac is `bell-mac`). It listens on tailnet port 8812.

The broker calls `POST /wake` when a send needs a seat that is missing, stale, dead, or registered as codex, cursor, opencode, or grok. The body is the peer id, machine, cwd, runtime, and pid. It does not include the mail. The mail stays in the broker mailbox. The wake text is `peers mail waiting; run check_messages`.

A running turn is `queue_after_active`. Anything else is `start_immediately`. A route with a `tmux` target gets `tmux send-keys` instead.

## Route order

1. `routes.json` (`BELL_ROUTES`, else `~/.local/state/peers-bell/routes.json`)
2. `runtime` of `t3:<threadId>` or `<harness>:t3:<threadId>`
3. one thread whose worktree path equals the peer's cwd

A seat whose T3 project is the checkout root has `worktreePath: null`. Step 3 cannot see it. That seat needs step 1 or step 2. The Assistant fork is one of these.

Nothing sets step 2 today. `server.ts` and `codex-server.ts` will register `claude:t3:<id>` or `codex:t3:<id>` if `CLAUDE_PEERS_THREAD_ID` or `T3_THREAD_ID` is in the environment. T3 does not put either there. The tool that sets it by hand is `set_route` with `thread_id`. No AGENTS.md line calls it, and a seat cannot see its own thread id from the environment, so a startup line would have nothing to pass. Until something records the id, a root-cwd seat is a `routes.json` entry.

Otherwise the sender gets `no-route`. How that was chosen: `docs/bell-route-discovery-2026-10-22.md`.

## Files that are not loaded yet

- `launchd/com.hines.peers-bell.plist` on the Mac
- `systemd/claude-peers-bell.service` on a Linux host
- Broker env `CLAUDE_PEERS_BELLS` is a JSON object of machine to bell origin. `CLAUDE_PEERS_LOCAL_MACHINES` lists machine names whose pids this broker may check. The Mac bell also reaps dead pids on its own machine through `/reap-dead`.

The T3 credential is `BELL_T3` (default `~/.local/state/peers-bell/t3.json`): `baseUrl`, `token`, `environmentId`. Mode 600. Not in git.

## Rollback

`launchctl bootout gui/$UID/com.hines.peers-bell`, or `systemctl --user disable --now claude-peers-bell.service`. Unset `CLAUDE_PEERS_BELLS` on the broker and restart it. Previous files stay beside the new ones.
