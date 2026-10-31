import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePin, t3ThreadForSession } from "./shared/pins.ts";

const THREAD = "mcp:aaaaaaaa-0000-4000-8000-000000000001:fork";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

let dir: string;
let pinsPath: string;
let dbPath: string;

function addProviderThread(db: Database, threadId: string, sessionId: string, updatedAt: string) {
  db.run(
    "INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, provider, status, updated_at, payload_json) VALUES (?, ?, 'claudeAgent', 'idle', ?, ?)",
    [`pt-${sessionId}`, threadId, updatedAt, JSON.stringify({ appThreadId: threadId, nativeThreadRef: { driver: "claudeAgent", nativeId: sessionId } })],
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "peers-pins-"));
  pinsPath = join(dir, "pinned-ids.json");
  dbPath = join(dir, "statev2.sqlite");
  const db = new Database(dbPath);
  db.run(
    "CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, owner_node_id TEXT, provider TEXT NOT NULL, provider_session_id TEXT, status TEXT NOT NULL, first_run_ordinal INTEGER, last_run_ordinal INTEGER, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL)",
  );
  addProviderThread(db, THREAD, SESSION_A, "2026-10-21T00:00:00Z");
  addProviderThread(db, THREAD, SESSION_B, "2026-10-23T00:00:00Z");
  db.close();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("finds the T3 thread for a Claude session id", () => {
  expect(t3ThreadForSession(dbPath, SESSION_B)).toBe(THREAD);
  expect(t3ThreadForSession(dbPath, "33333333-3333-4333-8333-333333333333")).toBeUndefined();
  expect(t3ThreadForSession(join(dir, "missing.sqlite"), SESSION_B)).toBeUndefined();
});

test("a thread pin holds for every session under that thread, with its nickname", async () => {
  writeFileSync(pinsPath, JSON.stringify({ [THREAD]: { id: "mac-assistant", nickname: "assistant" } }));
  for (const sessionId of [SESSION_A, SESSION_B]) {
    expect(await resolvePin({ sessionId, pinsPath, t3StatePath: dbPath, waitMs: 0 })).toEqual({
      id: "mac-assistant",
      nickname: "assistant",
      key: THREAD,
    });
  }
});

test("a session id pin still works and wins over a thread pin", async () => {
  writeFileSync(pinsPath, JSON.stringify({ [SESSION_A]: "mac-old", [THREAD]: "mac-assistant" }));
  expect(await resolvePin({ sessionId: SESSION_A, pinsPath, t3StatePath: dbPath, waitMs: 0 })).toEqual({ id: "mac-old", key: SESSION_A });
  expect(await resolvePin({ sessionId: SESSION_B, pinsPath, t3StatePath: dbPath, waitMs: 0 })).toEqual({ id: "mac-assistant", key: THREAD });
});

test("no pin for other threads, bad ids, or a missing pins file", async () => {
  writeFileSync(pinsPath, JSON.stringify({ "mcp:other": "mac-other", [THREAD]: { id: "bad id!" } }));
  expect(await resolvePin({ sessionId: SESSION_B, pinsPath, t3StatePath: dbPath, waitMs: 0 })).toBeUndefined();
  expect(await resolvePin({ sessionId: SESSION_B, pinsPath: join(dir, "none.json"), t3StatePath: dbPath, waitMs: 0 })).toBeUndefined();
  expect(await resolvePin({ sessionId: undefined, pinsPath, t3StatePath: dbPath, waitMs: 0 })).toBeUndefined();
});

test("waits for T3 to record a new session, then stops at the deadline", async () => {
  writeFileSync(pinsPath, JSON.stringify({ [THREAD]: "mac-assistant" }));
  const late = "44444444-4444-4444-8444-444444444444";
  setTimeout(() => {
    const db = new Database(dbPath);
    addProviderThread(db, THREAD, late, "2026-10-23T01:00:00Z");
    db.close();
  }, 100);
  expect(await resolvePin({ sessionId: late, pinsPath, t3StatePath: dbPath, waitMs: 2000, stepMs: 25 })).toEqual({ id: "mac-assistant", key: THREAD });

  const started = Date.now();
  expect(await resolvePin({ sessionId: "55555555-5555-4555-8555-555555555555", pinsPath, t3StatePath: dbPath, waitMs: 150, stepMs: 25 })).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(1000);
});
