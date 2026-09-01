# Claude Peers duplicate-loading and delivery audit

Captured: 2026-09-01
Baseline: `219e9f6` on `main`
Scope: six-machine names-only census, controlled local reproduction, source trace, and isolated broker tests

## Outcome

The broker is reachable and healthy, but the legacy protocol cannot safely tolerate two `server.ts` runtimes for one stable peer identity. The repository does not launch the duplicate child. Claude's MCP registration composition does that outside this codebase. Once two children exist, both know the same peer ID, both can poll the same mailbox, the later registration hides the earlier PID, and either process can unregister the shared row.

The direct loss mechanism is in the broker protocol: `/poll-messages` marks rows delivered before the client attempts its channel notification. A wrong duplicate consumer, crash, response loss, or failed channel injection therefore makes the message unrecoverable at the broker.

The durable repository boundary is a stable logical peer ID plus a separate per-process instance ID and broker-minted owner lease. Duplicates stay MCP-connected as fenced standbys. New delivery uses visibility-timeout claims and explicit acknowledgment, while legacy endpoints remain available for rolling upgrades.

## What was reproduced

On Claude 2.1.252, the existing same-name user/project registrations produced a multiple-scope warning but only one child. This is different from the May incident and indicates that current scope resolution now deduplicates this particular shape.

A controlled registration with two distinct MCP names targeting the same `server.ts` still produced two children under one Claude parent. With different environment values, the broker showed two logical peers. With identical stable-peer environment values, both processes stayed alive while the broker showed only the later PID. Isolated broker polling then demonstrated the competing-consumer behavior.

Claude's current channel documentation says the development flag approves an already configured server; it does not create the server registration. It also says stdio MCP configuration starts a subprocess and project-relative paths resolve from the launch directory. Those constraints explain why configuration composition can create children but do not make the repository itself the launcher:

- https://code.claude.com/docs/en/channels-reference
- https://code.claude.com/docs/en/channels
- https://code.claude.com/docs/en/mcp

## Fleet census

| Host | Claude | Repo | Active child result | Delivery result |
| --- | --- | --- | --- | --- |
| M3 | 2.1.252 | `219e9f6`, dirty 2 | Each inspected development Claude had one child | Broker consumed; no application ack |
| PC | 2.1.198 | `3f6ffa5`, dirty 2 | Bilby, Grok, Nagatha, and HAL each had one child | HAL returned exact ack |
| M2 | 2.1.225 | `c83f6fb`, dirty 6 | Fable and Opus each had one child; one Sonnet had none | Tony returned exact ack |
| cheesegrater | 2.1.252 | `fc26491`, dirty 22 | Active Claude had no inspected child | No central peer; unavailable |
| clarsmini | 2.1.226 | `ba3f149`, dirty 2 | Dood and another session each had one child | Broker consumed; no application ack |
| theoldone | 2.1.225 | `c7adea0`, dirty 10 | Standard and development sessions each had one child; one headless child registered | Broker consumed; no application ack |

All six hosts were reachable. No remote files, processes, services, or configuration were changed. Full structured evidence is in `2026-09-01-claude-peers-fleet-census.json`.

## Delivery interpretation

An exact peer reply proves the full path through channel injection and agent action. That was proven for PC/HAL and M2/Tony.

For M3, clarsmini, and theoldone, the broker row changed to delivered but no exact reply arrived in the bounded observation window. Under the legacy protocol this proves only that a poller consumed the row. It does not distinguish successful injection, silent channel rejection, a busy agent, or the wrong duplicate consumer.

## Targeted audit scorecard

| Category | Score | Reason |
| --- | ---: | --- |
| Security | 0/3 | Pre-fix: broker auth can fail open if deployed without its token; runtime identity was not instance-bound; dashboard has stored-XSS sinks; dependency audit reports high advisories |
| Performance | 0/3 | Pre-fix: inbox polling scanned unbounded history, local fallback was unbounded, intervals could overlap, and sender lookup was N+1 |
| Architecture | 1/3 | Pre-fix: stable peer identity conflated identity, ownership, and delivery authority across oversized modules |
| Test health | 1/3 | Pre-fix: nine tests passed, but none covered duplicate owners, stale unregister, claim timeout, or acknowledgment |
| Resilience | 1/3 | Pre-fix: registration retry existed, but delivery was finalized before receipt and duplicate runtimes were unfenced |

Baseline targeted posture: **3/15, fragile**.

### Post-fix verification status

The delivery patch closes the targeted runtime and delivery gaps: a v2 owner lease fences duplicate consumers and stale mutations; claims are indexed and redelivered after their visibility timeout until acknowledged; the client buffer is bounded and deduplicated; sender metadata is fetched once per batch; and poll/heartbeat loops are serialized. The expanded suite covers owner/standby arbitration, same-instance renewal, expiry-driven takeover, stale heartbeat/unregister, visibility redelivery, final acknowledgment, legacy compatibility, real MCP stdio notification ordering, and standby-to-owner transition.

The remaining security findings and persistent broker message-retention policy are not closed by this patch, so the baseline audit score is retained rather than rescored optimistically.

## Repair boundary

The implementation is additive:

1. Payload-v2 clients register an `instance_id` and receive `owner` or `standby` plus an opaque owner lease.
2. Only the current owner lease may heartbeat, poll/claim, mutate, send as that identity, or unregister it.
3. A duplicate stays available as an MCP server but cannot consume or remove the logical peer. It retries registration and can take over only after lease expiry.
4. `/claim-messages` leases queued rows for a visibility window. A one-way stdio notification does not finalize delivery: the channel metadata and manual-check output include the message ID, and Claude must call `ack_message` after reading it. Only that application-level receipt invokes `/ack-messages`; otherwise the row becomes visible again.
5. Legacy registrations and destructive `/poll-messages` remain for mixed-version rollout, but legacy polling is rejected once that peer has a v2 lease.
6. The delivery lookup receives a supporting index. Channel logs record IDs and byte counts, not message text.

## Operational follow-up not performed

The central broker must be upgraded before client runtimes to activate the additive protocol. Client repositories then need a controlled fleet rollout and fresh exact-ack probes. Canonicalizing duplicate MCP configuration remains a separate operational cleanup: this audit intentionally did not edit user/project config, shell files, launchers, services, or any remote host.

Separate high-priority findings remain outside the duplicate-delivery patch: make non-loopback broker startup fail closed without auth, replace dashboard `innerHTML` rendering of peer fields, bound public-edge intake and retention, and refresh the vulnerable transitive dependency graph.
