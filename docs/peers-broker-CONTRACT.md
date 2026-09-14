# cf-peers-broker CONTRACT

**As-of:** 2026-09-02 (CT)  
**Worker:** `cf-peers-broker` @ https://cf-peers-broker.wes-432.workers.dev  
**DO class:** `BrokerDO` (binding `BROKER_DO`)  
**Auth secret name:** `CLAUDE_PEERS_TOKEN` (Bearer on all POSTs)  
**Status:** Reconstructed online copy (June live CONTRACT.md was offline; rebuilt from Worker comments + preflight June section + live bun `/set-state` parity).

---

## §1 Purpose

Federated peers broker: register Claude/Codex/Grok peers, heartbeat, metadata updates, list peers, send/poll messages. CF Durable Object storage mirrors the bun SQLite broker success/error shapes for the June route set, plus live `/set-state`.

## §2 Auth

- `GET /health` — open (no auth).
- All `POST /*` — `Authorization: Bearer <CLAUDE_PEERS_TOKEN>`.
- Missing/wrong Bearer → `401 {"error":"unauthorized"}`.
- Secret unset on Worker → `500 {"error":"server misconfigured: CLAUDE_PEERS_TOKEN unset"}`.

## §3 Request handlers

Each route reproduces the bun broker's exact success/error shape and side effects (Worker comment + June CONTRACT).

| Method | Path | Body (key fields) | Success shape | Notes |
|--------|------|-------------------|---------------|-------|
| GET | `/health` | — | `{"status":"ok","peers":N}` | Open |
| POST | `/register` | `requested_id`, `pid`, `cwd`, `summary`, `machine`, … | `{"id":…}` | Rejects bare `id`; requires `requested_id` |
| POST | `/heartbeat` | `id` | `{"ok":true,"found":bool}` | Touches `last_seen` |
| POST | `/set-summary` | `id`, `summary` | `{"ok":true}` | |
| POST | `/set-nickname` | `id`, `nickname` | `{"ok":true}` | CF returns ok even if missing (June shape) |
| POST | `/set-context` | `id`, context fields | `{"ok":true}` | |
| POST | `/set-state` | `id`, `blocked_on?`, `blocked_since?` | `{"ok":bool,"found":bool}` | Live bun parity (2026-09); see §3a |
| POST | `/list-peers` | `scope`, `cwd`, `git_root`, … | `[Peer,…]` | |
| POST | `/send-message` | `from_id`, `to_id`, `text` | `{"ok":true}` or `{"ok":false,"error":…}` | |
| POST | `/poll-messages` | `id` | `{"messages":[…]}` | Marks delivered |
| POST | `/unregister` | `id` | `{"ok":true}` | Deletes peer row only (messages kept) |
| other GET | `/*` | — | text `claude-peers broker (federated)` | Not a JSON version endpoint |
| unknown POST | — | — | `404 {"error":"not found"}` | |

### §3a `/set-state` (live bun parity)

Source of truth: theoldone `/home/hinescreative/mcp-servers/claude-peers-mcp/broker.ts` `handleSetState` (dirty local on `c7adea0`; matches GitHub `main`).

- Request: `{ "id": string, "blocked_on"?: string|null, "blocked_since"?: string|null }`
- `blocked_on` normalized: null/undefined→null; non-string→null; trim + max 128; empty→null.
- If peer missing → `{ ok: false, found: false }` (HTTP 200).
- If peer found → persist and `{ ok: true, found: true }`.
- `blocked_since` rules:
  - Explicit `blocked_since` string (trimmed non-empty) → use it; empty/non-string → null.
  - If `blocked_since` omitted and `blocked_on` omitted → keep prior since.
  - If `blocked_since` omitted and `blocked_on` set truthy → stamp `new Date().toISOString()`.
  - If `blocked_since` omitted and `blocked_on` cleared (null) → `blocked_since = null`.
- Does **not** alter `summary` (verified by bun process-table tests).

## §4 Storage (DO)

Keys: `peers`, `messages`, `nextMessageId`.  
In-memory Map/array write-through on every mutation.

Peer fields include June core + process-table: `blocked_on`, `blocked_since` (null until `/set-state`).

## §5 Default TTL

`CLAUDE_PEERS_TTL_MINUTES` default **20** minutes → `staleMs`.

## §6 Staleness + delete helpers

- `peerIsStale` — last_seen older than TTL.
- `deletePeerAndUndeliveredMessages` — peer + undelivered msgs to that peer (stale cleanup / stale send target).
- `deletePeer` — peer row only (unregister / re-register cleanup); leaves messages.

## §7 TTL-only prune (accepted fork vs bun)

**TTL-only prune — no PID-liveness reaping.**  
DO alarm ~30s TTL sweep, re-arming each fire.  
Bun may still PID-reap; CF intentionally does not. Do not “fix” CF to match PID behavior.

## §8 Edge / client env names

- Broker base URL knob: **`CLAUDE_PEERS_BROKER_URL`** (not bare `BROKER_URL`).
- Shared broker token: `CLAUDE_PEERS_TOKEN`.
- GB public MCP face stays `https://mcp.hinescreative.xyz/mcp` on cutover; only the edge→broker URL flips when Architect greenlights.

## §9 Non-goals / out of scope (this CONTRACT)

- `/claim-messages` / `/ack-messages` (Air tip ahead of live bun — not on CF).
- Custom domains for this Worker (workers.dev only unless separately decided).
- Client cutover / flipping `CLAUDE_PEERS_BROKER_URL` (hard gate: Architect + Wes).

## §10 Deploy notes

- Compatibility date: `2025-06-01`
- Migration tag: `v1` (`BrokerDO`)
- Secret: `CLAUDE_PEERS_TOKEN` (do not rotate casually)
