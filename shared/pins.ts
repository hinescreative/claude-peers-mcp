// Pinned peer ids. ~/.claude-peers/pinned-ids.json maps a key to a fixed peer
// id, so a seat keeps its address across restarts and no other session in the
// same folder can take it. The key is either:
//   - a T3 thread id ("mcp:3e3e...:fork"): stays fixed while the Claude session
//     id under it changes (a brain switch, a fresh session on the same thread);
//   - a Claude Code session id (CLAUDE_CODE_SESSION_ID), the older form.
// The value is a peer id string, or {"id": "...", "nickname": "..."} to also
// fix the nickname, so routing by nickname needs no set_nickname call.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export type Pin = { id: string; nickname?: string; key: string };

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function defaultPinsPath(home = process.env.HOME ?? ""): string {
  return process.env.CLAUDE_PEERS_PINS_FILE ?? join(home, ".claude-peers", "pinned-ids.json");
}

export function defaultT3StatePath(home = process.env.HOME ?? ""): string {
  return process.env.CLAUDE_PEERS_T3_STATE_DB ?? join(home, ".t3", "userdata", "statev2.sqlite");
}

export function readPins(path: string): Record<string, unknown> {
  try {
    const pins = JSON.parse(readFileSync(path, "utf8"));
    return pins && typeof pins === "object" && !Array.isArray(pins) ? pins : {};
  } catch {
    return {};
  }
}

function toPin(key: string, value: unknown): Pin | undefined {
  if (typeof value === "string") return ID_RE.test(value) ? { id: value, key } : undefined;
  if (value && typeof value === "object") {
    const { id, nickname } = value as { id?: unknown; nickname?: unknown };
    if (typeof id !== "string" || !ID_RE.test(id)) return undefined;
    const nick = typeof nickname === "string" && nickname.trim() ? nickname.trim().slice(0, 64) : undefined;
    return { id, key, ...(nick ? { nickname: nick } : {}) };
  }
  return undefined;
}

// The T3 thread that owns a Claude session, from T3's own state database.
// T3 records the session id before it starts the Claude process.
export function t3ThreadForSession(dbPath: string, sessionId: string): string | undefined {
  if (!existsSync(dbPath)) return undefined;
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .query(
        `SELECT thread_id FROM orchestration_v2_projection_provider_threads
          WHERE json_extract(payload_json, '$.nativeThreadRef.nativeId') = ?
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(sessionId) as { thread_id?: string } | null;
    return typeof row?.thread_id === "string" ? row.thread_id : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

export type ResolveOptions = {
  sessionId?: string;
  pinsPath?: string;
  t3StatePath?: string;
  waitMs?: number;
  stepMs?: number;
};

// Session-id keys first (no lookup needed), then the session's T3 thread.
// When thread keys exist but T3 has not recorded the session yet, retry for
// waitMs; with no thread keys, or no T3 database, it returns at once.
export async function resolvePin(opts: ResolveOptions = {}): Promise<Pin | undefined> {
  const sessionId = opts.sessionId ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return undefined;
  const pins = readPins(opts.pinsPath ?? defaultPinsPath());
  if (sessionId in pins) {
    const pin = toPin(sessionId, pins[sessionId]);
    if (pin) return pin;
  }
  const hasThreadKeys = Object.keys(pins).some((k) => k !== sessionId && !ID_UUID_RE.test(k));
  if (!hasThreadKeys) return undefined;
  const dbPath = opts.t3StatePath ?? defaultT3StatePath();
  if (!existsSync(dbPath)) return undefined;
  const deadline = Date.now() + (opts.waitMs ?? 5000);
  for (;;) {
    const thread = t3ThreadForSession(dbPath, sessionId);
    if (thread) return thread in pins ? toPin(thread, pins[thread]) : undefined;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, opts.stepMs ?? 250));
  }
}
