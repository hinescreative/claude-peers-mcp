#!/usr/bin/env bun
/**
 * claude-peers broker daemon (federated)
 *
 * A singleton HTTP server backed by SQLite.
 * Tracks all registered Claude Code peers across the fleet and routes messages between them.
 *
 * Binds to 0.0.0.0 for fleet-wide access over Tailscale.
 * Requires CLAUDE_PEERS_TOKEN for authentication.
 *
 * Auto-launched by the MCP server if running locally.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  SetNicknameRequest,
  SetContextRequest,
  SetStateRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const AUTH_TOKEN = process.env.CLAUDE_PEERS_TOKEN ?? "";
const REQUIRE_AUTH =
  process.env.CLAUDE_PEERS_REQUIRE_AUTH === "1" ||
  process.env.CLAUDE_PEERS_REQUIRE_AUTH === "true";
const TTL_MINUTES = parseInt(process.env.CLAUDE_PEERS_TTL_MINUTES ?? "20", 10);
const STALE_PEER_MS = Math.max(1, Number.isFinite(TTL_MINUTES) ? TTL_MINUTES : 20) * 60 * 1000;

if (REQUIRE_AUTH && !AUTH_TOKEN) {
  console.error("[claude-peers broker] FATAL: CLAUDE_PEERS_REQUIRE_AUTH is set but CLAUDE_PEERS_TOKEN is empty.");
  process.exit(1);
} else if (!AUTH_TOKEN) {
  console.error("[claude-peers broker] WARNING: No CLAUDE_PEERS_TOKEN set. Broker is unauthenticated.");
}

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    machine TEXT NOT NULL DEFAULT 'unknown',
    nickname TEXT NOT NULL DEFAULT '',
    context_window INTEGER,
    context_used INTEGER,
    context_note TEXT NOT NULL DEFAULT '',
    tier TEXT NOT NULL DEFAULT 'production',
    payload_version INTEGER NOT NULL DEFAULT 1,
    parent_id TEXT,
    runtime TEXT,
    rings TEXT,
    blocked_on TEXT,
    blocked_since TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Migrate: add machine column if it doesn't exist (for upgrades from pre-federation)
try {
  db.run("ALTER TABLE peers ADD COLUMN machine TEXT NOT NULL DEFAULT 'unknown'");
} catch {
  // Column already exists
}

// Migrate: add nickname column if it doesn't exist
try {
  db.run("ALTER TABLE peers ADD COLUMN nickname TEXT NOT NULL DEFAULT ''");
} catch {
  // Column already exists
}

// Migrate: add context metadata columns if they don't exist
try {
  db.run("ALTER TABLE peers ADD COLUMN context_window INTEGER");
} catch {
  // Column already exists
}
try {
  db.run("ALTER TABLE peers ADD COLUMN context_used INTEGER");
} catch {
  // Column already exists
}
try {
  db.run("ALTER TABLE peers ADD COLUMN context_note TEXT NOT NULL DEFAULT ''");
} catch {
  // Column already exists
}
try {
  db.run("ALTER TABLE peers ADD COLUMN tier TEXT NOT NULL DEFAULT 'production'");
} catch {
  // Column already exists
}
try {
  db.run("ALTER TABLE peers ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1");
} catch {
  // Column already exists
}
try {
  db.run("ALTER TABLE peers ADD COLUMN parent_id TEXT");
} catch {
  // Column already exists
}
try {
  db.run("ALTER TABLE peers ADD COLUMN runtime TEXT");
} catch {
  // Column already exists
}
try {
  db.run("ALTER TABLE peers ADD COLUMN rings TEXT");
} catch {
  // Column already exists
}
try {
  db.run("ALTER TABLE peers ADD COLUMN blocked_on TEXT");
} catch {
  // Column already exists
}
try {
  db.run("ALTER TABLE peers ADD COLUMN blocked_since TEXT");
} catch {
  // Column already exists
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

function deletePeerAndUndeliveredMessages(id: string): void {
  db.run("DELETE FROM peers WHERE id = ?", [id]);
  db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [id]);
}

function peerIsStale(peer: Pick<Peer, "last_seen">): boolean {
  const lastSeen = new Date(peer.last_seen).getTime();
  return !Number.isFinite(lastSeen) || Date.now() - lastSeen > STALE_PEER_MS;
}

function touchPeer(id: string): void {
  updateLastSeen.run(new Date().toISOString(), id);
}

// Clean up stale peers on startup and before broker operations. Local host peers
// get a PID check; all peers are also bounded by last_seen TTL.
function cleanStalePeers() {
  const hostname = require("os").hostname();
  const peers = db.query("SELECT id, pid, machine, last_seen FROM peers").all() as {
    id: string;
    pid: number;
    machine: string;
    last_seen: string;
  }[];

  for (const peer of peers) {
    if (peerIsStale(peer)) {
      deletePeerAndUndeliveredMessages(peer.id);
      continue;
    }

    if (peer.machine === hostname) {
      // Local peer — check if PID is alive
      try {
        process.kill(peer.pid, 0);
      } catch {
        deletePeerAndUndeliveredMessages(peer.id);
      }
    }
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Auth middleware ---

function checkAuth(req: Request): Response | null {
  if (!AUTH_TOKEN) return null; // No token configured = open (with warning)

  const auth = req.headers.get("Authorization");
  if (!auth || auth !== `Bearer ${AUTH_TOKEN}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, nickname, context_window, context_used, context_note, tier, payload_version, pid, cwd, git_root, tty, machine, summary, registered_at, last_seen, parent_id, runtime, rings, blocked_on, blocked_since)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const updateNickname = db.prepare(`
  UPDATE peers SET nickname = ? WHERE id = ?
`);

const updateContext = db.prepare(`
  UPDATE peers SET context_window = ?, context_used = ?, context_note = ? WHERE id = ?
`);

const updateHeartbeatContext = db.prepare(`
  UPDATE peers SET last_seen = ?, context_window = COALESCE(?, context_window), context_used = COALESCE(?, context_used) WHERE id = ?
`);

const updateState = db.prepare(`
  UPDATE peers SET blocked_on = ?, blocked_since = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const selectPeersByMachine = db.prepare(`
  SELECT * FROM peers WHERE machine = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function normalizeRequestedId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  return /^[a-zA-Z0-9_-]{3,64}$/.test(trimmed) ? trimmed : null;
}

function normalizeNickname(nickname: unknown): string {
  if (typeof nickname !== "string") return "";
  return nickname.trim().slice(0, 64);
}

function normalizeOptionalInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isInteger(num) && num >= 0 ? num : null;
}

function normalizeContextNote(note: unknown): string {
  if (typeof note !== "string") return "";
  return note.trim().slice(0, 120);
}

function normalizeTier(tier: unknown): "production" | "staging" | "infrastructure" {
  return tier === "staging" || tier === "infrastructure" ? tier : "production";
}

// Mirror of the client's auto-nickname (server.ts defaultNickname) so the broker
// can tell an operator-chosen nickname apart from a regenerated default.
// Keep in sync with server.ts cwdBasename/shortTty/defaultNickname.
function cwdBasename(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() || "home";
}

function shortTty(tty: string | null): string {
  if (!tty) return "no-tty";
  const digits = tty.match(/(\d+)$/)?.[1];
  return digits ? digits.padStart(3, "0") : tty.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function defaultNickname(machine: string, cwd: string, tty: string | null): string {
  return `${machine}:${cwdBasename(cwd)}:${shortTty(tty)}`.slice(0, 64);
}

function normalizePayloadVersion(version: unknown): number {
  const num = typeof version === "number" ? version : Number(version);
  return Number.isInteger(num) && num > 0 ? num : 1;
}

function normalizeParentId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim().slice(0, 64);
  return trimmed || null;
}

function normalizeRuntime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 32);
  return /^[a-zA-Z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function normalizeRings(value: unknown): string | null {
  let arr: unknown[] | null = null;
  if (Array.isArray(value)) {
    arr = value;
  } else if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      return null;
    }
  }
  if (!arr) return null;
  const nums = arr.filter((v): v is number => Number.isInteger(v) && v >= 0 && v <= 3);
  return nums.length ? JSON.stringify(nums) : null;
}

function normalizeBlockedOn(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 128);
  return trimmed === "" ? null : trimmed;
}

function decodeRings(raw: unknown): number[] | null {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is number => Number.isInteger(v) && v >= 0 && v <= 3);
  }
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v: unknown): v is number => Number.isInteger(v) && v >= 0 && v <= 3)
      : null;
  } catch {
    return null;
  }
}

function decodePeer(row: Peer & { rings?: unknown }): Peer {
  return { ...row, rings: decodeRings(row.rings) };
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  cleanStalePeers();

  const id = normalizeRequestedId(body.requested_id);
  if (!id) {
    throw new Error("register requires requested_id");
  }
  const nickname = normalizeNickname(body.nickname);
  const contextWindow = normalizeOptionalInt(body.context_window);
  const contextUsed = normalizeOptionalInt(body.context_used);
  const contextNote = normalizeContextNote(body.context_note);
  const tier = normalizeTier(body.tier);
  const payloadVersion = normalizePayloadVersion(body.payload_version);
  const now = new Date().toISOString();
  const machine = body.machine || "unknown";

  // Clients own peer identity. The broker validates and records requested_id;
  // it does not mint IDs for production registrations.

  // Preserve operator-set identity metadata across re-registrations: the
  // delete-then-insert below would otherwise wipe nickname/summary/context on
  // every MCP restart and heartbeat-miss recovery. Capture the prior row first
  // (same id, else same pid+machine lineage), then carry over any field the
  // client sent empty or as its regenerated auto-default.
  type PeerIdentity = Pick<
    Peer,
    | "nickname"
    | "summary"
    | "context_window"
    | "context_used"
    | "context_note"
    | "parent_id"
    | "runtime"
    | "blocked_on"
    | "blocked_since"
  > & { rings?: unknown };
  const priorById = db
    .query(
      "SELECT nickname, summary, context_window, context_used, context_note, parent_id, runtime, rings, blocked_on, blocked_since FROM peers WHERE id = ?"
    )
    .get(id) as PeerIdentity | null;
  deletePeer.run(id);

  // Remove any existing registration for this PID + machine combo (re-registration)
  const existing = db
    .query(
      "SELECT id, nickname, summary, context_window, context_used, context_note, parent_id, runtime, rings, blocked_on, blocked_since FROM peers WHERE pid = ? AND machine = ?"
    )
    .get(body.pid, machine) as (PeerIdentity & { id: string }) | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  const prior = priorById ?? existing;
  const carriedNickname =
    nickname === "" || nickname === defaultNickname(machine, body.cwd, body.tty ?? null)
      ? (prior?.nickname ?? nickname)
      : nickname;
  const carriedSummary = body.summary ? body.summary : (prior?.summary ?? "");
  const carriedContextWindow = contextWindow ?? prior?.context_window ?? null;
  const carriedContextUsed = contextUsed ?? prior?.context_used ?? null;
  const carriedContextNote = contextNote === "" ? (prior?.context_note ?? "") : contextNote;
  const parentId = normalizeParentId(body.parent_id) ?? prior?.parent_id ?? null;
  const runtime = normalizeRuntime(body.runtime) ?? prior?.runtime ?? null;
  const rings = normalizeRings(body.rings) ?? (typeof prior?.rings === "string" ? prior.rings : normalizeRings(prior?.rings));
  const blockedOn = prior?.blocked_on ?? null;
  const blockedSince = prior?.blocked_since ?? null;

  insertPeer.run(
    id,
    carriedNickname,
    carriedContextWindow,
    carriedContextUsed,
    carriedContextNote,
    tier,
    payloadVersion,
    body.pid,
    body.cwd,
    body.git_root,
    body.tty,
    machine,
    carriedSummary,
    now,
    now,
    parentId,
    runtime,
    rings,
    blockedOn,
    blockedSince
  );
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): { ok: boolean; found: boolean } {
  const now = new Date().toISOString();
  const window = body.context_window !== undefined ? normalizeOptionalInt(body.context_window) : undefined;
  const used = body.context_used !== undefined ? normalizeOptionalInt(body.context_used) : undefined;
  if (window !== undefined || used !== undefined) {
    const result = updateHeartbeatContext.run(now, window ?? null, used ?? null, body.id);
    return { ok: true, found: result.changes > 0 };
  }
  const result = updateLastSeen.run(now, body.id);
  return { ok: true, found: result.changes > 0 };
}

function handleSetState(body: SetStateRequest): { ok: boolean; found: boolean } {
  const blockedOn =
    body.blocked_on === undefined ? undefined : normalizeBlockedOn(body.blocked_on);
  const blockedSince =
    body.blocked_since === undefined
      ? undefined
      : typeof body.blocked_since === "string" && body.blocked_since.trim()
        ? body.blocked_since.trim()
        : null;
  const row = db
    .query("SELECT blocked_on, blocked_since FROM peers WHERE id = ?")
    .get(body.id) as { blocked_on: string | null; blocked_since: string | null } | null;
  if (!row) {
    return { ok: false, found: false };
  }
  const nextOn = blockedOn === undefined ? row.blocked_on : blockedOn;
  const nextSince =
    blockedSince !== undefined
      ? blockedSince
      : blockedOn === undefined
        ? row.blocked_since
        : blockedOn
          ? new Date().toISOString()
          : null;
  const result = updateState.run(nextOn, nextSince, body.id);
  return { ok: true, found: result.changes > 0 };
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleSetNickname(body: SetNicknameRequest): { ok: boolean; error?: string } {
  const result = updateNickname.run(normalizeNickname(body.nickname), body.id);
  if (result.changes === 0) {
    return { ok: false, error: "peer not found or stale" };
  }
  return { ok: true };
}

function handleSetContext(body: SetContextRequest): void {
  updateContext.run(
    normalizeOptionalInt(body.context_window),
    normalizeOptionalInt(body.context_used),
    normalizeContextNote(body.context_note),
    body.id
  );
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  cleanStalePeers();

  let peers: Peer[];

  switch (body.scope) {
    case "fleet":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "machine":
      if (body.machine) {
        peers = selectPeersByMachine.all(body.machine) as Peer[];
      } else {
        peers = selectAllPeers.all() as Peer[];
      }
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // For local peers, verify process is still alive
  const hostname = require("os").hostname();
  peers = peers.filter((p) => {
    if (peerIsStale(p)) {
      deletePeerAndUndeliveredMessages(p.id);
      return false;
    }

    if (p.machine === hostname) {
      try {
        process.kill(p.pid, 0);
        return true;
      } catch {
        deletePeerAndUndeliveredMessages(p.id);
        return false;
      }
    }
    // Remote peers — trust heartbeat-based cleanup
    return true;
  });

  // Optional: hide headless "idle, awaiting directive" zombies from tasking lists
  if (body.active_only) {
    const idleRe = /idle,?\s*awaiting directive/i;
    peers = peers.filter((p) => {
      const noTty = !p.tty || p.tty === "" || p.tty === "null";
      const idleSummary = idleRe.test(p.summary || "");
      // Keep if has a real tty OR summary is not the default idle boilerplate
      if (noTty && idleSummary) return false;
      return true;
    });
  }

  return peers.map(decodePeer);
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  cleanStalePeers();
  touchPeer(body.from_id);

  // Verify target exists
  const target = db.query("SELECT id, last_seen FROM peers WHERE id = ?").get(body.to_id) as
    | Pick<Peer, "id" | "last_seen">
    | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }
  if (peerIsStale(target)) {
    deletePeerAndUndeliveredMessages(target.id);
    return { ok: false, error: `Peer ${body.to_id} is stale` };
  }

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  touchPeer(body.id);
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        // Health check doesn't require auth
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("claude-peers broker (federated)", { status: 200 });
    }

    // Auth check for all POST endpoints
    const authError = checkAuth(req);
    if (authError) return authError;

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          return Response.json(handleHeartbeat(body as HeartbeatRequest));
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/set-nickname":
          return Response.json(handleSetNickname(body as SetNicknameRequest));
        case "/set-context":
          handleSetContext(body as SetContextRequest);
          return Response.json({ ok: true });
        case "/set-state":
          return Response.json(handleSetState(body as SetStateRequest));
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on 0.0.0.0:${PORT} (db: ${DB_PATH})`);
