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
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { messageContractVersion } from "./shared/message-contract.ts";
import {
  bellPeerId,
  loadAllowlist,
  loadBells,
  mergeRuntime,
  needsWake,
  nicknameDecision,
  normalizeRuntime,
  parseRuntime,
  pidAlive,
  routeIsFresh,
  THREAD_ID,
  validSession,
} from "./bell-protocol.ts";
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
  ClaimMessagesRequest,
  ClaimMessagesResponse,
  AckMessagesRequest,
  AckMessagesResponse,
  UnregisterRequest,
  LeaseCredentials,
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const ENV_TOKENS = [
  process.env.CLAUDE_PEERS_TOKEN ?? "",
  ...(process.env.CLAUDE_PEERS_TOKENS ?? "").split(/[,\r\n]/).map(token => token.trim()),
].filter(Boolean);
const TOKENS_FILE = process.env.CLAUDE_PEERS_TOKENS_FILE ?? "";
const TOKEN_FILE_CHECK_MS = 10_000;
let tokenFileMtime: number | null = null;
let lastTokenFileCheck = 0;
let acceptedTokenHashes: Buffer[] = [];
const AUTH_CONFIGURED = ENV_TOKENS.length > 0 || Boolean(TOKENS_FILE);
const REQUIRE_AUTH =
  process.env.CLAUDE_PEERS_REQUIRE_AUTH === "1" ||
  process.env.CLAUDE_PEERS_REQUIRE_AUTH === "true";
const TTL_MINUTES = parseInt(process.env.CLAUDE_PEERS_TTL_MINUTES ?? "20", 10);
const STALE_PEER_MS = Math.max(1, Number.isFinite(TTL_MINUTES) ? TTL_MINUTES : 20) * 60 * 1000;
const parsedLeaseTtl = Number(process.env.CLAUDE_PEERS_LEASE_TTL_MS ?? "45000");
const LEASE_TTL_MS = Number.isFinite(parsedLeaseTtl) && parsedLeaseTtl > 0 ? parsedLeaseTtl : 45_000;
const parsedVisibilityTimeout = Number(
  process.env.CLAUDE_PEERS_VISIBILITY_TIMEOUT_MS ?? "30000",
);
const VISIBILITY_TIMEOUT_MS =
  Number.isFinite(parsedVisibilityTimeout) && parsedVisibilityTimeout > 0
    ? parsedVisibilityTimeout
    : 30_000;
const CLAIM_BATCH_SIZE = 100;

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function reloadTokens(): boolean {
  lastTokenFileCheck = Date.now();
  try {
    let fileTokens: string[] = [];
    let mtime: number | null = null;
    if (TOKENS_FILE) {
      const stat = statSync(TOKENS_FILE);
      fileTokens = readFileSync(TOKENS_FILE, "utf8").split(/\r?\n/).map(token => token.trim());
      mtime = stat.mtimeMs;
      if ((stat.mode & 0o777) !== 0o600) {
        console.error("[claude-peers broker] WARNING: token file mode should be 600.");
      }
    }
    const tokens = new Set([...ENV_TOKENS, ...fileTokens].filter(Boolean));
    acceptedTokenHashes = [...tokens].map(hashToken);
    tokenFileMtime = mtime;
    console.error(`[claude-peers broker] accepted tokens: ${acceptedTokenHashes.length}`);
    if (acceptedTokenHashes.length === 0) {
      console.error(`[claude-peers broker] WARNING: No accepted tokens. ${AUTH_CONFIGURED || REQUIRE_AUTH ? "Authenticated requests will be rejected." : "Broker is unauthenticated."}`);
    }
    return true;
  } catch {
    // Keep the last complete set on read failure; never log file contents/errors.
    console.error("[claude-peers broker] token file reload failed; keeping previous accepted tokens.");
    return false;
  }
}

if (!reloadTokens()) process.exit(1);
if (REQUIRE_AUTH && acceptedTokenHashes.length === 0) {
  console.error("[claude-peers broker] FATAL: CLAUDE_PEERS_REQUIRE_AUTH is set but no accepted tokens are configured.");
  process.exit(1);
}
process.on("SIGHUP", () => { reloadTokens(); });

function maybeReloadTokens(): void {
  const now = Date.now();
  if (!TOKENS_FILE || now - lastTokenFileCheck < TOKEN_FILE_CHECK_MS) return;
  lastTokenFileCheck = now;
  try {
    if (statSync(TOKENS_FILE).mtimeMs !== tokenFileMtime) reloadTokens();
  } catch {
    console.error("[claude-peers broker] token file reload failed; keeping previous accepted tokens.");
  }
}

// --- Database setup ---

const DB_BUSY_MS = 3_000;
const SEND_BUSY_MS = 1_000;
const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run(`PRAGMA busy_timeout = ${DB_BUSY_MS}`);

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
    instance_id TEXT,
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
  db.run("ALTER TABLE peers ADD COLUMN instance_id TEXT");
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
    claim_expires_at TEXT,
    claimed_by_lease_fingerprint TEXT,
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

try {
  db.run("ALTER TABLE messages ADD COLUMN claim_expires_at TEXT");
} catch {
  // Column already exists
}
try {
  db.run("ALTER TABLE messages ADD COLUMN claimed_by_lease_fingerprint TEXT");
} catch {
  // Column already exists
}
try {
  db.run("ALTER TABLE messages ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0");
} catch {
  // Column already exists
}

// Additive migration keeps existing mail readable. Do not hide migration failures.
const messageColumns = new Set((db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map(row => row.name));
for (const [name, definition] of Object.entries({ kind: "TEXT NOT NULL DEFAULT 'request'", reply_to_id: "INTEGER", client_message_id: "TEXT", wake_state: "TEXT" })) {
  if (!messageColumns.has(name)) db.run(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);
}
const migratedMessageColumns = new Set((db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map(row => row.name));
if (migratedMessageColumns.has("wake_command_id")) db.run("ALTER TABLE messages DROP COLUMN wake_command_id");
db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id ON messages(from_id, client_message_id) WHERE client_message_id IS NOT NULL");

db.run(`
  CREATE TABLE IF NOT EXISTS peer_leases (
    peer_id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    lease_id TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (peer_id) REFERENCES peers(id) ON DELETE CASCADE
  )
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_messages_delivery_claim
  ON messages (to_id, delivered, claim_expires_at, sent_at, id)
`);

// Survives unregister and reap. A released seat's row is gone; the next send
// still knows which machine and cwd to wake.
db.run(`
  CREATE TABLE IF NOT EXISTS peer_routes (
    id TEXT NOT NULL,
    machine TEXT NOT NULL,
    cwd TEXT NOT NULL,
    runtime TEXT,
    pid INTEGER,
    requested_id TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (id, machine)
  )
`);
try { db.run("ALTER TABLE peer_routes ADD COLUMN requested_id TEXT"); } catch { /* already there */ }
try { db.run("ALTER TABLE peer_routes ADD COLUMN effective_id TEXT"); } catch { /* already there */ }
try { db.run("ALTER TABLE peer_routes ADD COLUMN session TEXT"); } catch { /* already there */ }
try { db.run("ALTER TABLE peer_routes ADD COLUMN generation INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }
try { db.run("ALTER TABLE peers ADD COLUMN requested_id TEXT"); } catch { /* already there */ }

const parsedRouteTtl = Number(process.env.CLAUDE_PEERS_ROUTE_TTL_MS ?? String(7 * 24 * 60 * 60 * 1000));
const ROUTE_TTL_MS = Number.isFinite(parsedRouteTtl) && parsedRouteTtl >= 0 ? parsedRouteTtl : 7 * 24 * 60 * 60 * 1000;

const LOCAL_MACHINES = new Set(
  [require("os").hostname(), ...(process.env.CLAUDE_PEERS_LOCAL_MACHINES ?? "").split(",")]
    .map((name) => name.trim())
    .filter(Boolean),
);

function deletePeerAndUndeliveredMessages(id: string): void {
  // The row goes. Undelivered mail stays so a wake can still hand it over.
  const row = db.query("SELECT id, machine, cwd, runtime, pid FROM peers WHERE id = ?").get(id) as
    | { id: string; machine: string; cwd: string; runtime: string | null; pid: number }
    | null;
  if (row?.cwd) rememberRoute({ id: row.id, machine: row.machine, cwd: row.cwd, runtime: row.runtime, pid: row.pid });
  db.run("DELETE FROM peer_leases WHERE peer_id = ?", [id]);
  db.run("DELETE FROM peers WHERE id = ?", [id]);
}

function rememberRoute(row: {
  id: string;
  machine: string;
  cwd: string;
  runtime: string | null;
  pid: number | null;
  requestedId?: string | null;
  session?: string | null;
}): void {
  if (!row.cwd) return;
  const stable = row.requestedId || row.id;
  if (row.id !== stable) return;
  const other = db.query("SELECT machine FROM peer_routes WHERE id = ? AND machine <> ?").get(stable, row.machine) as { machine: string } | null;
  if (other) {
    console.error(`[claude-peers broker] route ${stable} belongs to ${other.machine}; refused a write from ${row.machine}`);
    return;
  }
  db.run(
    `INSERT INTO peer_routes (id, machine, cwd, runtime, pid, requested_id, effective_id, session, generation, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(id, machine) DO UPDATE SET
       cwd = excluded.cwd,
       pid = excluded.pid,
       effective_id = excluded.effective_id,
       runtime = CASE WHEN peer_routes.generation > excluded.generation THEN peer_routes.runtime ELSE excluded.runtime END,
       session = CASE WHEN peer_routes.generation > excluded.generation THEN peer_routes.session ELSE COALESCE(peer_routes.session, excluded.session) END,
       requested_id = COALESCE(peer_routes.requested_id, excluded.requested_id),
       updated_at = excluded.updated_at`,
    [stable, row.machine, row.cwd, row.runtime, row.pid, stable, row.id, row.session ?? null, new Date().toISOString()],
  );
}

function touchRoute(peerId: string): void {
  const peer = db.query("SELECT requested_id, machine FROM peers WHERE id = ?").get(peerId) as { requested_id: string | null; machine: string } | null;
  const stable = peer?.requested_id || peerId;
  // A suffix is a sibling. Only the base seat refreshes the route.
  if (!peer || stable !== peerId) return;
  db.run("UPDATE peer_routes SET updated_at = ? WHERE id = ? AND machine = ?", [new Date().toISOString(), stable, peer.machine]);
}

function machineIsLocal(machine: string): boolean {
  return LOCAL_MACHINES.has(machine);
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

    if (machineIsLocal(peer.machine) && !pidAlive(peer.pid)) {
      deletePeerAndUndeliveredMessages(peer.id);
    }
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Auth middleware ---

function checkAuth(req: Request): Response | null {
  maybeReloadTokens();
  if (!AUTH_CONFIGURED && !REQUIRE_AUTH) return null; // Preserve legacy open mode.

  const auth = req.headers.get("Authorization");
  const candidate = hashToken(auth?.startsWith("Bearer ") ? auth.slice(7) : "");
  // Fixed-size digests avoid length-dependent comparison and check every token.
  let matched = 0;
  for (const tokenHash of acceptedTokenHashes) {
    matched |= Number(timingSafeEqual(candidate, tokenHash));
  }
  if (!matched) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, nickname, context_window, context_used, context_note, tier, payload_version, instance_id, pid, cwd, git_root, tty, machine, summary, registered_at, last_seen, parent_id, runtime, rings, blocked_on, blocked_since)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

const deletePeerLease = db.prepare(`
  DELETE FROM peer_leases WHERE peer_id = ?
`);

const selectPeerLease = db.prepare(`
  SELECT peer_id, instance_id, lease_id, expires_at, created_at, updated_at
  FROM peer_leases WHERE peer_id = ?
`);

const insertPeerLease = db.prepare(`
  INSERT INTO peer_leases (peer_id, instance_id, lease_id, expires_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const renewPeerLease = db.prepare(`
  UPDATE peer_leases SET expires_at = ?, updated_at = ?
  WHERE peer_id = ? AND instance_id = ? AND lease_id = ?
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
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered, kind, reply_to_id, client_message_id, wake_state)
  VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
`);
const selectMessageByClientId = db.prepare("SELECT id, to_id, text, kind, reply_to_id, wake_state FROM messages WHERE from_id = ? AND client_message_id = ?");
const selectMessageById = db.prepare("SELECT id, from_id, to_id, kind FROM messages WHERE id = ?");

const selectUndelivered = db.prepare(`
  SELECT id, from_id, to_id, text, sent_at, delivered, kind, reply_to_id
  FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC, id ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages
  SET delivered = 1, claim_expires_at = NULL, claimed_by_lease_fingerprint = NULL
  WHERE id = ?
`);

const selectClaimableMessages = db.prepare(`
  SELECT id, from_id, to_id, text, sent_at, delivered, kind, reply_to_id
  FROM messages
  WHERE to_id = ?
    AND delivered = 0
    AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
  ORDER BY sent_at ASC, id ASC
  LIMIT ${CLAIM_BATCH_SIZE}
`);

const claimMessage = db.prepare(`
  UPDATE messages
  SET claim_expires_at = ?,
      claimed_by_lease_fingerprint = ?,
      delivery_attempts = delivery_attempts + 1
  WHERE id = ?
    AND delivered = 0
    AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
`);

const ackClaimedMessage = db.prepare(`
  UPDATE messages
  SET delivered = 1, claim_expires_at = NULL, claimed_by_lease_fingerprint = NULL
  WHERE id = ?
    AND to_id = ?
    AND delivered = 0
    AND claimed_by_lease_fingerprint = ?
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface PeerLease {
  peer_id: string;
  instance_id: string;
  lease_id: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

function getPeerLease(id: string): PeerLease | null {
  return selectPeerLease.get(id) as PeerLease | null;
}

function leaseFingerprint(leaseId: string): string {
  return new Bun.CryptoHasher("sha256").update(leaseId).digest("hex");
}

function leaseIsExpired(lease: PeerLease, now = Date.now()): boolean {
  const expiresAt = Date.parse(lease.expires_at);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function normalizeInstanceId(instanceId: unknown): string | null {
  if (typeof instanceId !== "string") return null;
  const trimmed = instanceId.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : null;
}

function requireLeaseOwner(id: string, credentials: LeaseCredentials): PeerLease | null {
  const lease = getPeerLease(id);
  if (!lease) return null;

  if (
    leaseIsExpired(lease) ||
    credentials.instance_id !== lease.instance_id ||
    credentials.lease_id !== lease.lease_id
  ) {
    throw new HttpError(409, "peer lease conflict");
  }
  return lease;
}

function extendLease(lease: PeerLease, now = new Date()): string {
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS).toISOString();
  const result = renewPeerLease.run(
    expiresAt,
    now.toISOString(),
    lease.peer_id,
    lease.instance_id,
    lease.lease_id,
  );
  if (result.changes !== 1) {
    throw new HttpError(409, "peer lease conflict");
  }
  return expiresAt;
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
  const nums = arr.filter((v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3);
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
    return raw.filter((v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3);
  }
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3)
      : null;
  } catch {
    return null;
  }
}

function decodePeer(
  row: Peer & { instance_id?: unknown; rings?: unknown },
): Peer {
  const { instance_id: _instanceId, ...publicPeer } = row;
  return { ...publicPeer, rings: decodeRings(row.rings) };
}

// --- Request handlers ---

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

function replacePeerRegistration(
  body: RegisterRequest,
  id: string,
  payloadVersion: number,
  instanceId: string | null,
): void {
  const nickname = normalizeNickname(body.nickname);
  const contextWindow = normalizeOptionalInt(body.context_window);
  const contextUsed = normalizeOptionalInt(body.context_used);
  const contextNote = normalizeContextNote(body.context_note);
  const tier = normalizeTier(body.tier);
  const now = new Date().toISOString();
  const machine = body.machine || "unknown";

  // Preserve operator-set identity metadata across re-registrations: the
  // delete-then-insert below would otherwise wipe nickname/summary/context on
  // every MCP restart and heartbeat-miss recovery. Capture the prior row first
  // (same id, else same pid+machine lineage), then carry over any field the
  // client sent empty or as its regenerated auto-default.
  const priorById = db
    .query(
      "SELECT nickname, summary, context_window, context_used, context_note, parent_id, runtime, rings, blocked_on, blocked_since FROM peers WHERE id = ?"
    )
    .get(id) as PeerIdentity | null;
  // Remove any existing registration for this PID + machine combo (re-registration)
  const existing = db
    .query(
      "SELECT id, nickname, summary, context_window, context_used, context_note, parent_id, runtime, rings, blocked_on, blocked_since FROM peers WHERE pid = ? AND machine = ? AND id <> ?"
    )
    .get(body.pid, machine, id) as (PeerIdentity & { id: string }) | null;

  deletePeer.run(id);
  if (existing) {
    deletePeerLease.run(existing.id);
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
  const requested = normalizeRequestedId(body.requested_id);
  const isBase = !requested || requested === id;
  const saved = isBase && requested ? freshRoute(requested, machine) : null;
  const runtime = mergeRuntime(
    normalizeRuntime(body.runtime),
    isBase ? (saved?.runtime ?? prior?.runtime ?? null) : (prior?.runtime ?? null),
  );
  const rings = normalizeRings(body.rings) ?? (typeof prior?.rings === "string" ? prior.rings : normalizeRings(prior?.rings));
  const blockedOn = prior?.blocked_on ?? null;
  const blockedSince = prior?.blocked_since ?? null;

  const nickLive = (db.query("SELECT id, nickname, last_seen FROM peers").all() as {
    id: string;
    nickname: string;
    last_seen: string;
  }[]).filter((row) => !peerIsStale(row));
  const nick = nicknameDecision({
    callerId: id,
    nickname: carriedNickname,
    live: nickLive,
    allowlist: nicknameAllowlist(),
  });
  const finalNickname = nick.ok ? carriedNickname : "";
  if (nick.ok) for (const clearId of nick.clearIds) updateNickname.run("", clearId);

  insertPeer.run(
    id,
    finalNickname,
    carriedContextWindow,
    carriedContextUsed,
    carriedContextNote,
    tier,
    payloadVersion,
    instanceId,
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
  const stable = requested ?? id;
  db.run("UPDATE peers SET requested_id = ? WHERE id = ?", [stable, id]);
  if (isBase && body.cwd) {
    const session = typeof body.session === "string" && body.session.trim() ? body.session.trim().slice(0, 80) : null;
    rememberRoute({ id, machine, cwd: body.cwd, runtime, pid: body.pid, requestedId: stable, session });
  }
}

// --- Per-instance peer ids ---
//
// stablePeerId() on the client is `<machine>-<cwd basename>-<tty|no-tty>`, so
// every tty-less session in one directory computes the SAME id. The lease
// protocol used to hand the second such session `role: "standby"`, which left
// it deaf and mute: server.ts gates message delivery and channel push on
// `myRole === "standby"`. Instead, give that session an id of its own derived
// from the instance_id it already mints, and a real owner lease on it.
//
// The suffix is derived from instance_id and NOT randomly, and NOT from the
// pid: the same instance must always compute the same id so that a
// re-registration lands on the owner path instead of leaking a fresh row on
// every retry. Pids recycle, which would alias two different sessions.
//
// The base holder keeps the bare base id, so every peer id already written
// down in notes, tickets and configs keeps resolving and `send_message` to a
// bare id still reaches the session it always did.

const MAX_PEER_ID_LENGTH = 64;
const INSTANCE_SUFFIX_MIN = 4;
const INSTANCE_SUFFIX_MAX = 8;

// FNV-1a, written out rather than using Bun.hash so the id a session gets is
// reproducible across Bun versions — these ids end up in logs and tickets.
function instanceSuffix(instanceId: string, length: number): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < instanceId.length; i++) {
    hash ^= instanceId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, length);
}

// Truncate the BASE before the suffix is attached, never the finished id: slicing after the
// suffix is attached would cut the suffix off and recreate the collision.
function suffixedPeerId(base: string, instanceId: string, length: number): string {
  const room = MAX_PEER_ID_LENGTH - length - 1;
  return `${base.slice(0, room)}-${instanceSuffix(instanceId, length)}`;
}

function liveLeaseFor(id: string): PeerLease | null {
  const lease = getPeerLease(id);
  return lease && !leaseIsExpired(lease) ? lease : null;
}

// Decide which id this registration should actually own. Resolution order
// matters and each step exists for a reason:
//   1. If this instance already holds a live lease on one of its own suffixed
//      ids, keep it. The client re-registers on a heartbeat miss (server.ts
//      ~1195), and without this a live peer would silently change id mid-life
//      whenever the base happened to free up.
//   2. Otherwise take the bare base if it is free or already ours.
//   3. Otherwise the base belongs to a different live instance: take our own
//      suffixed id, lengthening the hash if that exact id is somehow held by
//      another instance, and give up rather than spin forever.
function heirSession(base: string, machine: string): string | null {
  const row = db.query("SELECT session FROM peer_routes WHERE id = ? AND machine = ?").get(base, machine) as { session: string | null } | null;
  return row?.session || null;
}

function resolveRegistrationId(base: string, instanceId: string, session: string | null, harness: string | null, machine: string): string {
  const held = liveLeaseFor(base);
  const reserved = Object.values(nicknameAllowlist()).includes(base);
  if (reserved) {
    const heir = validSession(heirSession(base, machine));
    // The recorded session is the seat. A new process with that session is the
    // old one coming back, so it takes the base even while the old lease lives.
    if (heir !== null && session === heir && harness === "claude") return base;
  } else if (!held || held.instance_id === instanceId) {
    return base;
  }
  for (let length = INSTANCE_SUFFIX_MIN; length <= INSTANCE_SUFFIX_MAX; length++) {
    const candidate = suffixedPeerId(base, instanceId, length);
    const lease = liveLeaseFor(candidate);
    if (lease && lease.instance_id === instanceId) return candidate;
  }

  if (!reserved && (!held || held.instance_id === instanceId)) return base;

  for (let length = INSTANCE_SUFFIX_MIN; length <= INSTANCE_SUFFIX_MAX; length++) {
    const candidate = suffixedPeerId(base, instanceId, length);
    const lease = liveLeaseFor(candidate);
    if (!lease || lease.instance_id === instanceId) return candidate;
  }

  throw new HttpError(409, `no free peer id available for base ${base}`);
}

function handleRegister(body: RegisterRequest): RegisterResponse {
  cleanStalePeers();

  const id = normalizeRequestedId(body.requested_id);
  if (!id) {
    throw new HttpError(400, "register requires a valid requested_id");
  }
  const payloadVersion = normalizePayloadVersion(body.payload_version);
  const usesLeaseProtocol = payloadVersion >= 2;
  const instanceId = usesLeaseProtocol ? normalizeInstanceId(body.instance_id) : null;
  if (usesLeaseProtocol && !instanceId) {
    throw new HttpError(400, "payload version 2 requires a valid instance_id");
  }

  const machine = body.machine || "unknown";
  const lineage = db
    .query("SELECT id FROM peers WHERE pid = ? AND machine = ? AND id <> ?")
    .get(body.pid, machine, id) as { id: string } | null;
  if (lineage) {
    const lineageLease = getPeerLease(lineage.id);
    if (
      lineageLease &&
      !leaseIsExpired(lineageLease) &&
      (!instanceId || lineageLease.instance_id !== instanceId)
    ) {
      throw new HttpError(409, "process lineage is owned by another peer lease");
    }
  }

  // payload_version 1 clients send no instance_id and cannot be disambiguated,
  // so they keep the pre-existing behaviour exactly.
  const session = validSession(body.session);
  if (!usesLeaseProtocol && Object.values(nicknameAllowlist()).includes(id)) {
    throw new HttpError(409, "reserved id requires a v2 claude session");
  }
  const harness = parseRuntime(normalizeRuntime(body.runtime)).harness;
  const effectiveId = usesLeaseProtocol && instanceId ? resolveRegistrationId(id, instanceId, session, harness, machine) : id;

  const currentLease = getPeerLease(effectiveId);
  if (!usesLeaseProtocol) {
    if (currentLease && !leaseIsExpired(currentLease)) {
      throw new HttpError(409, "peer id is owned by a leased runtime");
    }
    if (currentLease) deletePeerLease.run(id);
    replacePeerRegistration(body, id, payloadVersion, null);
    return { id };
  }

  const heirEvicts = Boolean(
    currentLease
    && !leaseIsExpired(currentLease)
    && currentLease.instance_id !== instanceId
    && effectiveId === id
    && harness === "claude"
    && session
    && session === validSession(heirSession(id, machine))
    && Object.values(nicknameAllowlist()).includes(id)
  );
  if (currentLease && !leaseIsExpired(currentLease) && !heirEvicts) {
    if (currentLease.instance_id !== instanceId) {
      throw new HttpError(409, "peer lease conflict");
    }
    if (body.lease_id !== currentLease.lease_id) {
      throw new HttpError(409, "peer lease conflict");
    }

    replacePeerRegistration(body, effectiveId, payloadVersion, instanceId);
    const leaseExpiresAt = extendLease(currentLease);
    return {
      id: effectiveId,
      role: "owner",
      lease_id: currentLease.lease_id,
      lease_expires_at: leaseExpiresAt,
    };
  }

  if (currentLease) {
    deletePeerLease.run(effectiveId);
  }
  replacePeerRegistration(body, effectiveId, payloadVersion, instanceId);

  const now = new Date();
  const leaseId = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_TTL_MS).toISOString();
  insertPeerLease.run(
    effectiveId,
    instanceId,
    leaseId,
    leaseExpiresAt,
    now.toISOString(),
    now.toISOString(),
  );
  return {
    id: effectiveId,
    role: "owner",
    lease_id: leaseId,
    lease_expires_at: leaseExpiresAt,
  };
}

function handleHeartbeat(body: HeartbeatRequest): { ok: boolean; found: boolean } {
  const lease = requireLeaseOwner(body.id, body);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const window = body.context_window !== undefined ? normalizeOptionalInt(body.context_window) : undefined;
  const used = body.context_used !== undefined ? normalizeOptionalInt(body.context_used) : undefined;
  if (window !== undefined || used !== undefined) {
    const result = updateHeartbeatContext.run(now, window ?? null, used ?? null, body.id);
    if (result.changes > 0) {
      if (lease) extendLease(lease, nowDate);
      touchRoute(body.id);
    }
    return { ok: true, found: result.changes > 0 };
  }
  const result = updateLastSeen.run(now, body.id);
  if (result.changes > 0) {
    if (lease) extendLease(lease, nowDate);
    touchRoute(body.id);
  }
  return { ok: true, found: result.changes > 0 };
}

function handleSetState(body: SetStateRequest): { ok: boolean; found: boolean } {
  requireLeaseOwner(body.id, body);
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
  requireLeaseOwner(body.id, body);
  updateSummary.run(body.summary, body.id);
}

function nicknameAllowlist(): Record<string, string> {
  const path = process.env.CLAUDE_PEERS_NICKNAMES
    ?? fileURLToPath(new URL("./nicknames.json", import.meta.url));
  try {
    return loadAllowlist(readFileSync(path, "utf8"));
  } catch {
    console.error("[claude-peers broker] nickname allowlist unavailable");
    return {};
  }
}

function handleSetNickname(body: SetNicknameRequest): { ok: boolean; error?: string } {
  requireLeaseOwner(body.id, body);
  const nickname = normalizeNickname(body.nickname);
  const rows = db.query("SELECT id, nickname, last_seen FROM peers").all() as {
    id: string;
    nickname: string;
    last_seen: string;
  }[];
  const decision = nicknameDecision({
    callerId: body.id,
    nickname,
    live: rows.filter((row) => !peerIsStale(row)),
    allowlist: nicknameAllowlist(),
  });
  if (!decision.ok) {
    throw new HttpError(409, decision.error);
  }
  for (const id of decision.clearIds) updateNickname.run("", id);
  const result = updateNickname.run(nickname, body.id);
  if (result.changes === 0) {
    return { ok: false, error: "peer not found or stale" };
  }
  return { ok: true };
}

function handleSetRuntime(body: { id?: string; runtime?: unknown } & LeaseCredentials): { ok: boolean; found: boolean; runtime?: string } {
  if (!body?.id) throw new HttpError(400, "set-runtime requires a peer id");
  requireLeaseOwner(body.id, body);
  const runtime = normalizeRuntime(body.runtime);
  if (!runtime) throw new HttpError(400, "invalid runtime");
  const result = db.run("UPDATE peers SET runtime = ? WHERE id = ?", [runtime, body.id]);
  if (result.changes === 0) return { ok: false, found: false };
  const row = db.query("SELECT id, machine, cwd, pid FROM peers WHERE id = ?").get(body.id) as
    | { id: string; machine: string; cwd: string; pid: number }
    | null;
  if (row?.cwd) rememberRoute({ id: row.id, machine: row.machine, cwd: row.cwd, runtime, pid: row.pid });
  return { ok: true, found: true, runtime };
}

function handleSetHeir(body: { base_id?: string; session?: string; thread_id?: string; machine?: string }): { ok: boolean } {
  const base = typeof body?.base_id === "string" ? body.base_id.trim() : "";
  const session = validSession(body?.session);
  const threadId = typeof body?.thread_id === "string" ? body.thread_id.trim() : "";
  const machine = typeof body?.machine === "string" ? body.machine.trim() : "";
  if (!base || !session || !THREAD_ID.test(threadId) || !machine) {
    throw new HttpError(400, "set-heir requires base_id, a uuid session, a thread_id and a machine");
  }
  if (!Object.values(nicknameAllowlist()).includes(base)) throw new HttpError(403, "set-heir is only for a reserved id");
  const other = db.query("SELECT machine FROM peer_routes WHERE id = ? AND machine <> ?").get(base, machine) as { machine: string } | null;
  if (other) {
    console.error(`[claude-peers broker] route ${base} belongs to ${other.machine}; refused set-heir from ${machine}`);
    throw new HttpError(409, "route belongs to another machine");
  }
  const runtime = `claude:t3:${threadId}`;
  const now = new Date().toISOString();
  const rotate = db.transaction(() => {
    db.run(
      `INSERT INTO peer_routes (id, machine, cwd, runtime, pid, requested_id, effective_id, session, generation, updated_at)
       VALUES (?, ?, '', ?, null, ?, ?, ?, 1, ?)
       ON CONFLICT(id, machine) DO UPDATE SET
         runtime = excluded.runtime,
         session = excluded.session,
         generation = peer_routes.generation + 1,
         updated_at = excluded.updated_at`,
      [base, machine, runtime, base, base, session, now],
    );
    db.run("UPDATE peers SET runtime = NULL WHERE id = ? AND machine = ?", [base, machine]);
    db.run("DELETE FROM peer_leases WHERE peer_id = ?", [base]);
  });
  rotate();
  return { ok: true };
}

function handleSetContext(body: SetContextRequest): void {
  requireLeaseOwner(body.id, body);
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

  peers = peers.filter((p) => {
    if (peerIsStale(p)) {
      deletePeerAndUndeliveredMessages(p.id);
      return false;
    }

    if (machineIsLocal(p.machine) && !pidAlive(p.pid)) {
      deletePeerAndUndeliveredMessages(p.id);
      return false;
    }
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

const sendMessage = db.transaction((body: SendMessageRequest) => {
  if (!body || typeof body.from_id !== "string" || typeof body.to_id !== "string" || typeof body.text !== "string" || !body.text.trim() || Buffer.byteLength(body.text) > 65536) {
    throw new HttpError(400, "send requires sender, recipient and nonempty text up to 64 KiB");
  }
  const kind = body.kind ?? (body.reply_to_id !== undefined ? "reply" : "request");
  if (!["request", "reply", "notification"].includes(kind)) throw new HttpError(400, "invalid message kind");
  const replyTo = body.reply_to_id ?? null;
  if ((kind === "reply" && (!Number.isSafeInteger(replyTo) || Number(replyTo) < 1)) || (kind !== "reply" && replyTo !== null)) throw new HttpError(400, "reply requires a positive reply_to_id; other kinds cannot set it");
  const clientId = body.client_message_id ?? null;
  if (clientId !== null && (typeof clientId !== "string" || !clientId.trim() || clientId.length > 128)) throw new HttpError(400, "invalid client_message_id");
  requireLeaseOwner(body.from_id, body);
  if (clientId !== null) {
    const existing = selectMessageByClientId.get(body.from_id, clientId) as { id: number; to_id: string; text: string; kind: string; reply_to_id: number | null; wake_state: string | null } | null;
    if (existing) {
      if (existing.to_id !== body.to_id || existing.text !== body.text || existing.kind !== kind || existing.reply_to_id !== replyTo) throw new HttpError(409, "client_message_id already used for a different message");
      const retryWake = existing.wake_state === null || existing.wake_state === "failed" || existing.wake_state === "unconfigured" || existing.wake_state === "no-route";
      if (!retryWake) return { ok: true, message_id: existing.id, duplicate: true, wake: existing.wake_state ?? "skipped" };
      const again = bellFacts(body.to_id);
      if (!again) return { ok: true, message_id: existing.id, duplicate: true, wake: "no-route" };
      return { ok: true, message_id: existing.id, duplicate: true, wake: "needed", bell: again };
    }
  }
  if (replyTo !== null) {
    const original = selectMessageById.get(replyTo) as { from_id: string; to_id: string; kind: string } | null;
    if (!original || original.kind !== "request" || original.to_id !== body.from_id || original.from_id !== body.to_id) throw new HttpError(400, "reply must reverse the participants of an existing request");
  }

  // A completed retry is returned above before stale-target pruning.
  cleanStalePeers();
  requireLeaseOwner(body.from_id, body);
  touchPeer(body.from_id);

  const target = db.query("SELECT id, last_seen, machine, cwd, runtime, pid FROM peers WHERE id = ?").get(body.to_id) as
    | { id: string; last_seen: string; machine: string; cwd: string; runtime: string | null; pid: number }
    | null;
  const remembered = target ? null : rememberedRoute(body.to_id);
  if (!target && !remembered) {
    const inserted = insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString(), kind, replyTo, clientId, "no-route");
    return { ok: true, message_id: Number(inserted.lastInsertRowid), duplicate: false, wake: "no-route" };
  }
  const facts = target ?? remembered!;
  const lease = target ? getPeerLease(target.id) : null;
  const wake = needsWake({
    present: Boolean(target),
    stale: target ? peerIsStale(target) : true,
    runtime: facts.runtime,
    ownerLive: lease ? !leaseIsExpired(lease) : true,
  });
  if (target && peerIsStale(target)) deletePeerAndUndeliveredMessages(target.id);

  const inserted = insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString(), kind, replyTo, clientId, wake ? null : "skipped");
  const message_id = Number(inserted.lastInsertRowid);
  if (!wake) return { ok: true, message_id, duplicate: false, wake: "skipped" };
  return {
    ok: true,
    message_id,
    duplicate: false,
    wake: "needed",
    bell: { to_id: body.to_id, machine: facts.machine, cwd: facts.cwd, runtime: facts.runtime, pid: facts.pid },
  };
});

const wakesInFlight = new Map<number, Promise<string>>();

function outboundBellToken(): string | null {
  const explicit = process.env.CLAUDE_PEERS_BELL_TOKEN?.trim();
  if (explicit) return explicit;
  if (TOKENS_FILE) {
    try {
      const line = readFileSync(TOKENS_FILE, "utf8").split(/\r?\n/).map((token) => token.trim()).find(Boolean);
      if (line) return line;
    } catch { /* fall through to the env token */ }
  }
  return ENV_TOKENS[0] || null;
}

async function forwardWake(target: { to_id: string; machine: string; cwd: string; runtime: string | null; pid: number | null }, messageId: number) {
  const path = process.env.CLAUDE_PEERS_BELLS ?? "";
  if (!path) return { ok: false, error: "bell-unconfigured" };
  let origin: string | undefined;
  try {
    origin = loadBells(readFileSync(path, "utf8"))[target.machine];
  } catch {
    return { ok: false, error: "bell-unconfigured" };
  }
  if (!origin) return { ok: false, error: "bell-unconfigured" };
  const token = outboundBellToken();
  if (!token) return { ok: false, error: "bell-unconfigured" };
  try {
    const res = await fetch(`${origin}/wake`, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to_id: target.to_id,
        machine: target.machine,
        cwd: target.cwd,
        runtime: target.runtime,
        pid: target.pid,
        message_id: messageId,
      }),
      signal: AbortSignal.timeout(4_000),
    });
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string; threadId?: string; dispatchMode?: string; tmux?: string } | null;
    if (json?.error === "no-route") return { ok: false, error: "no-route" };
    if (!res.ok || !json?.ok) return { ok: false, error: "bell-unreachable" };
    return { ok: true, threadId: json.threadId ?? null, dispatchMode: json.dispatchMode ?? null, tmux: json.tmux ?? null };
  } catch {
    return { ok: false, error: "bell-unreachable" };
  }
}

function withSendBusy<T>(work: () => T): T {
  db.run(`PRAGMA busy_timeout = ${SEND_BUSY_MS}`);
  try {
    return work();
  } finally {
    db.run(`PRAGMA busy_timeout = ${DB_BUSY_MS}`);
  }
}

async function handleSendMessage(body: SendMessageRequest) {
  // Handler budget: commit ≤1 s, bell ≤4 s, bookkeeping ≤1 s, under the senders' 10 s.
  const stored = withSendBusy(() => sendMessage(body)) as {
    ok: boolean;
    error?: string;
    message_id?: number;
    duplicate?: boolean;
    wake?: string;
    bell?: { to_id: string; machine: string; cwd: string; runtime: string | null; pid: number | null };
  };
  if (!stored.ok || stored.wake !== "needed" || !stored.bell || !stored.message_id) return stored;
  const messageId = stored.message_id;
  const running = wakesInFlight.get(messageId);
  const job = running ?? forwardWake(stored.bell, messageId).then((woke) => (
    woke.ok ? "sent" : woke.error === "no-route" ? "no-route" : woke.error === "bell-unconfigured" ? "unconfigured" : "failed"
  ));
  if (!running) wakesInFlight.set(messageId, job);
  let wake = "failed";
  try {
    wake = await job;
  } catch {
    wake = "failed";
  } finally {
    if (!running) wakesInFlight.delete(messageId);
  }
  try {
    withSendBusy(() => {
      db.run("UPDATE messages SET wake_state = ? WHERE id = ?", [wake, messageId]);
    });
  } catch {
    // The mail is already committed. A bookkeeping error must not hide the accepted id.
  }
  return { ok: true, message_id: messageId, duplicate: Boolean(stored.duplicate), wake };
}

function freshRoute(id: string, machine: string): { id: string; machine: string; cwd: string; runtime: string | null; pid: number } | null {
  const row = db.query("SELECT id, machine, cwd, runtime, pid, updated_at FROM peer_routes WHERE id = ? AND machine = ?").get(id, machine) as
    | { id: string; machine: string; cwd: string; runtime: string | null; pid: number; updated_at: string }
    | null;
  if (!row || !routeIsFresh(row.updated_at, Date.now(), ROUTE_TTL_MS)) return null;
  return row;
}

function rememberedRoute(id: string): { id: string; machine: string; cwd: string; runtime: string | null; pid: number } | null {
  const machines = db.query("SELECT machine FROM peer_routes WHERE id = ?").all(id) as { machine: string }[];
  if (machines.length !== 1 || !machines[0]) return null;
  return freshRoute(id, machines[0].machine);
}

function bellFacts(id: string): { to_id: string; machine: string; cwd: string; runtime: string | null; pid: number | null } | null {
  const target = db.query("SELECT id, machine, cwd, runtime, pid, last_seen FROM peers WHERE id = ?").get(id) as
    | { id: string; machine: string; cwd: string; runtime: string | null; pid: number; last_seen: string }
    | null;
  const route = target && !peerIsStale(target) ? null : rememberedRoute(id);
  const facts = target && !peerIsStale(target) ? target : route;
  if (!facts) return null;
  return { to_id: id, machine: facts.machine, cwd: facts.cwd, runtime: facts.runtime, pid: facts.pid };
}

function handleReapDead(body: { id?: string; peer_id?: string; pid?: number; machine?: string } & LeaseCredentials): { ok: boolean; reaped: boolean; undelivered: number } {
  if (!body?.id || !body.peer_id || !body.machine) throw new HttpError(400, "reap requires the bell id, peer id, and machine");
  requireLeaseOwner(body.id, body);
  const peer = db.query("SELECT id, pid, machine, cwd, runtime FROM peers WHERE id = ?").get(body.peer_id) as
    | { id: string; pid: number; machine: string; cwd: string; runtime: string | null }
    | null;
  if (!peer) return { ok: true, reaped: false, undelivered: 0 };
  if (peer.machine !== body.machine || Number(peer.pid) !== Number(body.pid)) {
    throw new HttpError(409, "reap target does not match");
  }
  if (body.id !== bellPeerId(peer.machine)) throw new HttpError(403, "only that machine's bell can reap");
  const undelivered = (db.query("SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND delivered = 0").get(peer.id) as { n: number }).n;
  deletePeerAndUndeliveredMessages(peer.id);
  return { ok: true, reaped: true, undelivered };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  if (getPeerLease(body.id)) {
    throw new HttpError(409, "leased peers must use claim-messages");
  }
  touchPeer(body.id);
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

const claimMessages = db.transaction(
  (id: string, leaseId: string, now: string, claimExpiresAt: string): Message[] => {
    const candidates = selectClaimableMessages.all(id, now) as Message[];
    const claimed: Message[] = [];
    const fingerprint = leaseFingerprint(leaseId);
    for (const message of candidates) {
      const result = claimMessage.run(claimExpiresAt, fingerprint, message.id, now);
      if (result.changes === 1) claimed.push(message);
    }
    return claimed;
  },
);

function handleClaimMessages(body: ClaimMessagesRequest): ClaimMessagesResponse {
  const lease = requireLeaseOwner(body.id, body);
  if (!lease) {
    throw new HttpError(409, "claim-messages requires a leased peer");
  }

  const now = new Date();
  const messages = claimMessages(
    body.id,
    lease.lease_id,
    now.toISOString(),
    new Date(now.getTime() + VISIBILITY_TIMEOUT_MS).toISOString(),
  );
  touchPeer(body.id);
  return { messages };
}

function handleAckMessages(body: AckMessagesRequest): AckMessagesResponse {
  const lease = requireLeaseOwner(body.id, body);
  if (!lease) {
    throw new HttpError(409, "ack-messages requires a leased peer");
  }
  if (!Array.isArray(body.message_ids)) {
    throw new HttpError(400, "ack-messages requires message_ids");
  }

  const messageIds = [
    ...new Set(
      body.message_ids.filter(
        (id): id is number => Number.isSafeInteger(id) && id > 0,
      ),
    ),
  ].slice(0, CLAIM_BATCH_SIZE);
  let acked = 0;
  const ackTransaction = db.transaction(() => {
    const fingerprint = leaseFingerprint(lease.lease_id);
    for (const messageId of messageIds) {
      acked += ackClaimedMessage.run(messageId, body.id, fingerprint).changes;
    }
  });
  ackTransaction();
  touchPeer(body.id);
  return { ok: true, acked };
}

function handleUnregister(body: UnregisterRequest): void {
  requireLeaseOwner(body.id, body);
  touchRoute(body.id);
  deletePeerLease.run(body.id);
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
        case "/capabilities":
          return Response.json({ message_contract: messageContractVersion, claim_ack: true, idempotent_send: true });
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
          return Response.json(await handleSendMessage(body as SendMessageRequest));
        case "/set-runtime":
          return Response.json(handleSetRuntime(body as { id?: string; runtime?: unknown } & LeaseCredentials));
        case "/set-heir":
          return Response.json(handleSetHeir(body as { base_id?: string; session?: string }));
        case "/reap-dead": {
          const reapBody = body as { id?: string; peer_id?: string; pid?: number; machine?: string } & LeaseCredentials;
          const reaped = handleReapDead(reapBody);
          if (reaped.reaped && reaped.undelivered > 0 && typeof reapBody.peer_id === "string" && typeof reapBody.machine === "string") {
            const route = db.query("SELECT id, machine, cwd, runtime, pid FROM peer_routes WHERE id = ? AND machine = ?").get(reapBody.peer_id, reapBody.machine) as
              | { id: string; machine: string; cwd: string; runtime: string | null; pid: number }
              | null;
            const mail = db.query("SELECT id FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY id LIMIT 1").get(reapBody.peer_id) as { id: number } | null;
            if (route && mail) await forwardWake({ to_id: route.id, machine: route.machine, cwd: route.cwd, runtime: route.runtime, pid: route.pid }, mail.id);
          }
          return Response.json(reaped);
        }
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/claim-messages":
          return Response.json(handleClaimMessages(body as ClaimMessagesRequest));
        case "/ack-messages":
          return Response.json(handleAckMessages(body as AckMessagesRequest));
        case "/unregister":
          handleUnregister(body as UnregisterRequest);
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = e instanceof HttpError ? e.status : 500;
      return Response.json({ error: msg }, { status });
    }
  },
});

console.error(`[claude-peers broker] listening on 0.0.0.0:${PORT} (db: ${DB_PATH})`);
