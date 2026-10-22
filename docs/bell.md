# Peers bell

One process per T3 host. Peer id `bell-<machine>` (the Mac is `bell-mac`). It listens on tailnet port 8812.

The broker calls `POST /wake` when a send needs a seat that is missing, stale, dead, or registered as codex, cursor, opencode, or grok. The body is the peer id, machine, cwd, runtime, and pid. It does not include the mail. The mail stays in the broker mailbox. The wake text is `peers mail waiting; run check_messages`.

A running turn is `queue_after_active`. Anything else is `start_immediately`. A route with a `tmux` target gets `tmux send-keys` instead.

## Route order

1. `routes.json` (`BELL_ROUTES`, else `~/.local/state/peers-bell/routes.json`)
2. `runtime` of `t3:<threadId>` or `<harness>:t3:<threadId>`
3. one thread whose worktree path equals the peer's cwd

A cwd match is only for a path under `~/.t3/worktrees/` with exactly one live thread that is not a fork. T3 makes one worktree per thread, so that is unique. A project root, including the Assistant, resolves only by an explicit route.

An id is first-come: whoever registers while the base is free holds it. A second process in the same directory gets a suffixed id. A suffixed id belongs to one process. Mail addressed to a suffix after that process exits is not recoverable. Senders target a stable id or a nickname. A suffix never reads or writes the base route, and a route is not moved to another machine.

A reserved id is granted only to a v2 Claude-harness process whose session is a uuid equal to the recorded heir. That session takes the base at once, even if an older process still holds a live lease. No heir recorded means nobody gets the base. A v1 caller or a sessionless caller never gets it. A suffix cannot take the reserved nickname.

When the Assistant moves to a new thread, one call rotates the heir, the route, the old binding and the old lease. A later reap cannot put the old thread back:

`curl -s -H "Authorization: Bearer $CLAUDE_PEERS_TOKEN" -H "content-type: application/json" -d '{"base_id":"mac-assistant-claude-no-tty","session":"<session-uuid>","thread_id":"mcp:<uuid>:fork","machine":"mac"}' "$CLAUDE_PEERS_BROKER_URL/set-heir"`

The bearer is the fleet token. Spoofing a session uuid is the same trust as holding that bearer.

Nothing sets step 2 today. `server.ts` and `codex-server.ts` will register `claude:t3:<id>` or `codex:t3:<id>` if `CLAUDE_PEERS_THREAD_ID` or `T3_THREAD_ID` is in the environment. T3 does not put either there. The tool that sets it by hand is `set_route` with `thread_id`. No AGENTS.md line calls it, and a seat cannot see its own thread id from the environment, so a startup line would have nothing to pass. Until something records the id, a root-cwd seat is a `routes.json` entry.

Otherwise the sender gets `no-route`. How that was chosen: `docs/bell-route-discovery-2026-10-22.md`.

## Files that are not loaded yet

- `launchd/com.hines.peers-bell.plist` on the Mac
- `systemd/claude-peers-bell.service` on a Linux host
- Broker env `CLAUDE_PEERS_BELLS` is a **file path**. The file is JSON, machine name to bell origin, for example `{"mac":"http://100.103.170.84:8812"}`. It is not the JSON itself. `CLAUDE_PEERS_LOCAL_MACHINES` lists machine names whose pids this broker may check. The Mac bell also reaps dead pids on its own machine through `/reap-dead`.
- The bearer is not in the plist. `scripts/bell-launch.sh` reads it from 1Password (`opa env claude-docs-integrations-keys.env`) and then execs `bell.ts`. The systemd unit should point `ExecStart` at that script, with `BELL_HOST` and `CLAUDE_PEERS_MACHINE` in the environment file.

The T3 credential is `BELL_T3` (default `~/.local/state/peers-bell/t3.json`): `baseUrl`, `token`, `environmentId`. Mode 600, owned by the user running the bell. The bell refuses anything looser. Not in git.

A route is kept for 7 days (`CLAUDE_PEERS_ROUTE_TTL_MS`). A thread id in a route or a runtime is used only while that thread is still in the shell snapshot and not archived. A cwd match is refused when an archived thread already used that path, so a leftover fork is not woken by mistake.

## Deploy order

theoldone's broker is not this branch. On 2026-10-22 it was still the tree at b112981 (PR #2, multi-token), seven commits behind main. PR #3 (redelivery, claims, leases) and PR #4 are merged on main and were not deployed. The broker process there started 2026-10-19 at 10:25 PM. theoldone also has a local grok-edge.ts patch and untracked files: lead-wake-edge.ts, dispatch.mjs, protocol.mjs, and butler-inbox-edge.ts. butler-inbox-edge.ts matches main.

The lease and claim checks in the wake decision do nothing until theoldone is running main.

Do these in order, at a quiet moment. Do not load the Mac bell before that broker is on main.

1. On theoldone, remove the untracked butler-inbox-edge.ts. It is the same file as main's, and a pull will not replace an untracked copy.
2. Bring theoldone's broker checkout to main, so PR #3 and PR #4 are what is running. Restart the broker once.
3. Replace theoldone's local grok-edge.ts patch with the matcher in this PR.
4. Copy theoldone's lead-wake routes.json, which has Shaw, into the Mac bell's routes.json. A seat that wakes today keeps waking.
5. Load the Mac bell.
6. Leave lead-wake-edge.ts running on theoldone until the bell has woken Shaw's lead once. Then disable that unit.

`~/bin/peers` is an installed copy of `cli.ts`. Reinstall it from `cli.ts` after the Mac client update. Do not edit that copy from a worktree.

## Rollback

On the Mac: `launchctl bootout gui/$UID/com.hines.peers-bell`. On Linux: `systemctl --user disable --now claude-peers-bell.service`. Then remove `CLAUDE_PEERS_BELLS` from the broker's environment and restart the broker once (`systemctl --user restart claude-peers-broker.service` on theoldone). Previous files stay beside the new ones. Unsetting the variable without a broker restart leaves the running broker with the old path.
