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

Nicknames are whatever the seat sets, the same as main. Reserved names and `set-heir` are not in this branch.

Nothing sets step 2 today. `server.ts` and `codex-server.ts` will register `claude:t3:<id>` or `codex:t3:<id>` if `CLAUDE_PEERS_THREAD_ID` or `T3_THREAD_ID` is in the environment. T3 does not put either there. The tool that sets it by hand is `set_route` with `thread_id`. No AGENTS.md line calls it, and a seat cannot see its own thread id from the environment, so a startup line would have nothing to pass. Until something records the id, a root-cwd seat is a `routes.json` entry.

Otherwise the sender gets `no-route`. How that was chosen: `docs/bell-route-discovery-2026-10-22.md`.

## Files that are not loaded yet

- `launchd/com.hines.peers-bell.plist` on the Mac
- `systemd/claude-peers-bell.service` on a Linux host
- Broker env `CLAUDE_PEERS_BELLS` is a **file path**. The file is JSON, machine name to bell origin, for example `{"mac":"http://100.103.170.84:8812"}`. It is not the JSON itself. `CLAUDE_PEERS_LOCAL_MACHINES` lists machine names whose pids this broker may check. The Mac bell also reaps dead pids on its own machine through `/reap-dead`.
- The bearer is not in the plist. `scripts/bell-launch.sh` reads it from 1Password (`opa env claude-docs-integrations-keys.env`) and then execs `bell.ts`. The systemd unit should point `ExecStart` at that script, with `BELL_HOST` and `CLAUDE_PEERS_MACHINE` in the environment file.

The T3 credential is `BELL_T3` (default `~/.local/state/peers-bell/t3.json`): `baseUrl`, `token`, `environmentId`. Mode 600, owned by the user running the bell. The bell refuses anything looser. Not in git.

A route is kept for 7 days (`CLAUDE_PEERS_ROUTE_TTL_MS`). A thread id in a route or a runtime is used only while that thread is still in the shell snapshot and not archived. A cwd match is refused when an archived thread already used that path, so a leftover fork is not woken by mistake.

## Known limitation

Senders on pc, clarsmini, and the imac are older checkouts. Their send deadline is 5 seconds and they do not print the wake line, so `wake: no-route` looks like a success until each machine's client is updated. This broker answers inside that 5 seconds: commit ≤1 s, bell ≤3 s, bookkeeping ≤1 s.

`~/bin/peers` is a Python script at `/Users/wesleyhines/bin/peers`. It is not a copy of `cli.ts`. A search of `~/hines` and `~/hines/setup` found no other copy; that file is the source. It is not changed in this PR. Follow-up, separate from this branch: print the wake line, and raise its deadline from 8 seconds to 10. Keep `peers send --from` and the nickname lookup.

## Deploy order

Run this only after this PR is on main. On 2026-10-22 theoldone's checkout was `b112981`, seven commits behind main, with a dirty `grok-edge.ts`. PR #3 and PR #4 were merged and not deployed. The broker process had started 2026-10-19 at 10:25 PM. The lease and claim checks do nothing until that host is running main.

theoldone, in this order. Do not restart the broker until the line that says so.

```sh
cp -a /home/hinescreative/mcp-servers/claude-peers-mcp /home/hinescreative/mcp-servers/claude-peers-mcp.bak-2026-10-22
rm /home/hinescreative/mcp-servers/claude-peers-mcp/butler-inbox-edge.ts
git -C /home/hinescreative/mcp-servers/claude-peers-mcp stash push -m "grok-edge local lead-wake patch 2026-10-22" -- grok-edge.ts
git -C /home/hinescreative/mcp-servers/claude-peers-mcp pull --ff-only origin main
git -C /home/hinescreative/mcp-servers/claude-peers-mcp grep -n shouldWakeLead -- grok-edge.ts
```

Stop if that grep is empty. Do not run `git stash pop`. The untracked `lead-wake-edge.ts`, `dispatch.mjs`, `protocol.mjs`, and `apply-grok-fallback.py` stay; lead-wake is still the thing that wakes Shaw until the last step.

```sh
mkdir -p /home/hinescreative/.config/claude-peers /home/hinescreative/.config/systemd/user/claude-peers-broker.service.d
printf '%s\n' '{"mac":"http://100.103.170.84:8812"}' > /home/hinescreative/.config/claude-peers/bells.json
cat > /home/hinescreative/.config/systemd/user/claude-peers-broker.service.d/bell.conf <<'EOF'
[Service]
Environment=CLAUDE_PEERS_BELLS=/home/hinescreative/.config/claude-peers/bells.json
Environment=CLAUDE_PEERS_TOKENS_FILE=/home/hinescreative/.config/claude-peers/broker-tokens.txt
EOF
```

The bell credential is the first line of that existing tokens file. Do not copy the token into a second file.

```sh
# needs Wes's go
systemctl --user daemon-reload
systemctl --user restart claude-peers-broker.service
```

The seed is after the restart. The broker at `b112981` has no `/seed-route`.

```sh
python3 - <<'PY'
import json, pathlib, urllib.request
routes = json.load(open("/home/hinescreative/.local/state/lead-wake/routes.json"))
token = pathlib.Path("/home/hinescreative/.config/claude-peers/broker-tokens.txt").read_text().splitlines()[0].strip()
for peer_id, route in routes["routes"].items():
    body = json.dumps({"id": peer_id, "machine": "mac", "runtime": f"t3:{route['threadId']}"}).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:7899/seed-route",
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        print(peer_id, resp.status)
PY
```

On the Mac, after `~/hines/setup/mcp-servers/claude-peers-mcp` is on the same main. The plist path `/Users/wesleyhines/mcp-servers/claude-peers-mcp` is a symlink to that checkout.

```sh
git -C ~/hines/setup/mcp-servers/claude-peers-mcp pull --ff-only origin main
mkdir -p ~/.local/state/peers-bell ~/Library/LaunchAgents
fssh theoldone 'cat ~/.local/state/lead-wake/routes.json' > ~/.local/state/peers-bell/routes.json
cp ~/hines/setup/mcp-servers/claude-peers-mcp/launchd/com.hines.peers-bell.plist ~/Library/LaunchAgents/com.hines.peers-bell.plist
launchctl bootstrap gui/"$(id -u)" ~/Library/LaunchAgents/com.hines.peers-bell.plist
TOKEN=$(~/.local/bin/opa read --no-newline "op://Agents/claude-docs-integrations-keys.env/CLAUDE_PEERS_TOKEN")
curl -sf -H "Authorization: Bearer $TOKEN" http://100.103.170.84:8812/health
```

A wake is a send to `mac-shaw-plumbing-no-tty` from a registered seat. The reply must include `wake: sent`, and the bell log must contain `woke mac-shaw-plumbing-no-tty`. The mail text must not be in that log line.

After that wake has happened:

```sh
systemctl --user disable --now claude-peers-lead-wake.service
```

## Rollback

On the Mac: `launchctl bootout gui/$UID/com.hines.peers-bell`. On Linux: `systemctl --user disable --now claude-peers-bell.service`. Then remove `CLAUDE_PEERS_BELLS` from the broker's environment and restart the broker once (`systemctl --user restart claude-peers-broker.service` on theoldone). Previous files stay beside the new ones. Unsetting the variable without a broker restart leaves the running broker with the old path.
