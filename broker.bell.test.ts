import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = Bun.serve({ port: 0, fetch() { return new Response(""); } });
const PORT = probe.port;
probe.stop(true);
const bellProbe = Bun.serve({ port: 0, fetch() { return new Response(""); } });
const BELL_PORT = bellProbe.port;
bellProbe.stop(true);

const DB = `/tmp/claude-peers-bell-${process.pid}.db`;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "peers-bell-"));
const bellsFile = join(dir, "bells.json");
writeFileSync(bellsFile, JSON.stringify({ mac: `http://127.0.0.1:${BELL_PORT}` }));

const wakes: { body: any; auth: string | null; command_id?: string | null }[] = [];
let bellMode: "ok" | "no-route" = "ok";
let bellHold: Promise<void> | null = null;
const bell = Bun.serve({
  port: BELL_PORT,
  fetch: async (req) => {
    const body = await req.json() as { command_id?: string; message_id?: number };
    wakes.push({ body, auth: req.headers.get("Authorization"), command_id: body.command_id });
    if (bellHold) await bellHold;
    if (bellMode === "no-route") return Response.json({ ok: false, error: "no-route" });
    return Response.json({ ok: true, threadId: "mcp:36a41ff7-8eef-49ab-a947-55027c14f468", dispatchMode: "queue_after_active" });
  },
});

let proc: ReturnType<typeof Bun.spawn> | null = null;

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function seat(id: string, extra: Record<string, unknown> = {}) {
  return {
    requested_id: id,
    pid: process.pid,
    cwd: "/work/only",
    git_root: null,
    tty: null,
    machine: "mac",
    summary: id,
    ...extra,
  };
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", "broker.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(PORT),
      CLAUDE_PEERS_DB: DB,
      CLAUDE_PEERS_TOKEN: "test-token",
      CLAUDE_PEERS_TOKENS: "",
      CLAUDE_PEERS_TOKENS_FILE: "",
      CLAUDE_PEERS_BELLS: bellsFile,
      CLAUDE_PEERS_LOCAL_MACHINES: "mac",
      CLAUDE_CODE_MESSAGING_SOCKET: "",
      CLAUDE_CODE_MESSAGING_TOKEN: "",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE + "/health")).ok) return;
    } catch { /* not up */ }
    await Bun.sleep(50);
  }
  throw new Error("broker did not start");
});

afterAll(() => {
  proc?.kill();
  bell.stop(true);
});

test("a live claude seat is not forwarded, and the mail stays", async () => {
  expect((await post("/register", seat("mac-claude", { runtime: "claude" }))).status).toBe(200);
  expect((await post("/register", seat("mac-sender", { machine: "testbox", pid: 7 }))).status).toBe(200);
  const before = wakes.length;
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "mac-claude", text: "SECRET-MAIL hello" });
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBe("skipped");
  expect(wakes.length).toBe(before);
  const polled = await post("/poll-messages", { id: "mac-claude" });
  expect(polled.json.messages.map((m: { text: string }) => m.text)).toEqual(["SECRET-MAIL hello"]);
});

test("a codex seat is woken with no message body, and the mail stays", async () => {
  expect((await post("/register", seat("codex-only", { runtime: "codex", pid: 4242 }))).status).toBe(200);
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "codex-only", text: "SECRET-MAIL please ack" });
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBe("sent");
  const wake = wakes.at(-1)!;
  expect(wake.auth).toBe("Bearer test-token");
  expect(wake.body.to_id).toBe("codex-only");
  expect(wake.body.cwd).toBe("/work/only");
  expect(JSON.stringify(wake.body)).not.toContain("SECRET-MAIL");
  const polled = await post("/poll-messages", { id: "codex-only" });
  expect(polled.json.messages[0].text).toBe("SECRET-MAIL please ack");
});

test("a seat that has unregistered is still woken from the remembered route", async () => {
  await post("/unregister", { id: "codex-only" });
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "codex-only", text: "SECRET-MAIL again" });
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBe("sent");
  expect(wakes.at(-1)!.body.runtime).toBe("codex");
});

test("a dead local pid is reaped and the next send wakes that route", async () => {
  expect((await post("/register", seat("codex-dead", { runtime: "codex", pid: 2147483646 }))).status).toBe(200);
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "codex-dead", text: "SECRET-MAIL dead" });
  expect(sent.json.wake).toBe("sent");
  expect(wakes.at(-1)!.body.to_id).toBe("codex-dead");
});

test("an unknown peer is no-route and the bell is not asked", async () => {
  const before = wakes.length;
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "nobody-here", text: "hi" });
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBe("no-route");
  expect(wakes.length).toBe(before);
});

test("the bell refusing a route is returned to the sender", async () => {
  bellMode = "no-route";
  expect((await post("/register", seat("codex-lost", { runtime: "codex" }))).status).toBe(200);
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "codex-lost", text: "SECRET-MAIL lost" });
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBe("no-route");
  expect(sent.json.message_id).toBeGreaterThan(0);
  bellMode = "ok";
});

test("a restarted suffixed seat keeps the mail, and a free base can be taken again", async () => {
  const sleeps = [Bun.spawn(["sleep", "30"]), Bun.spawn(["sleep", "30"]), Bun.spawn(["sleep", "30"])];
  const pids = sleeps.map((child) => child.pid);
  try {
  const holder = await post("/register", {
    ...seat("mac-box", { pid: pids[0] }),
    instance_id: "holder-instance-01",
    payload_version: 2,
    cwd: "/work/box",
    runtime: "claude:t3:mcp:3e3e7dbd-4ab2-454b-8ae2-cebf0a87193c:fork",
  });
  expect(holder.json.id).toBe("mac-box");
  const sent = await post("/send-message", {
    from_id: "mac-sender", to_id: "mac-box", text: "stable-mail", client_message_id: "stable-1",
  });
  expect(sent.json.ok).toBe(true);
  const sibling = await post("/register", {
    ...seat("mac-box", { pid: pids[1] }),
    instance_id: "suffix-instance-02",
    payload_version: 2,
    cwd: "/work/box",
  });
  expect(String(sibling.json.id).startsWith("mac-box-")).toBe(true);
  const siblingMail = await post("/claim-messages", {
    id: sibling.json.id, instance_id: "suffix-instance-02", lease_id: sibling.json.lease_id,
  });
  expect((siblingMail.json.messages as { text: string }[]).some((message) => message.text === "stable-mail")).toBe(false);
  await post("/unregister", { id: holder.json.id, instance_id: "holder-instance-01", lease_id: holder.json.lease_id });
  const again = await post("/send-message", {
    from_id: "mac-sender", to_id: "mac-box", text: "stable-mail", client_message_id: "stable-1",
  });
  expect(again.status).not.toBe(409);
  expect(again.json.duplicate).toBe(true);
  const respawned = await post("/register", {
    ...seat("mac-box", { pid: pids[2], runtime: "claude" }),
    instance_id: "holder-instance-03",
    payload_version: 2,
    cwd: "/work/box",
  });
  expect(respawned.json.id).toBe("mac-box");
  const list = await post("/list-peers", { scope: "fleet", cwd: "/work/box", git_root: null });
  const row = (list.json as { id: string; runtime: string | null }[]).find((peer) => peer.id === "mac-box");
  expect(row?.runtime).toBe("claude:t3:mcp:3e3e7dbd-4ab2-454b-8ae2-cebf0a87193c:fork");
  const mailbox = await post("/claim-messages", {
    id: "mac-box", instance_id: "holder-instance-03", lease_id: respawned.json.lease_id,
  });
  expect((mailbox.json.messages as { text: string; to_id: string }[]).some((message) => message.text === "stable-mail" && message.to_id === "mac-box")).toBe(true);
  } finally {
    for (const child of sleeps) child.kill();
  }
});

test("a failed wake stays accepted, and the same client id retries the wake", async () => {
  bellMode = "no-route";
  const first = await post("/send-message", {
    from_id: "mac-sender", to_id: "codex-only", text: "once", client_message_id: "retry-1",
  });
  expect(first.json.ok).toBe(true);
  expect(first.json.wake).toBe("no-route");
  const id = first.json.message_id;
  bellMode = "ok";
  const again = await post("/send-message", {
    from_id: "mac-sender", to_id: "codex-only", text: "once", client_message_id: "retry-1",
  });
  expect(again.json.ok).toBe(true);
  expect(again.json.wake).toBe("sent");
  expect(again.json.message_id).toBe(id);
  expect(again.json.duplicate).toBe(true);
});

test("an expired owner lease is woken even though the row and the pid are alive", async () => {
  const sleeper = Bun.spawn(["sleep", "30"]);
  const reg = await post("/register", {
    ...seat("mac-lease-dead", { runtime: "claude", pid: sleeper.pid }),
    instance_id: "lease-dead-instance",
    payload_version: 2,
  });
  expect(reg.json.role).toBe("owner");
  const { Database } = await import("bun:sqlite");
  const db = new Database(DB);
  db.run("UPDATE peer_leases SET expires_at = ? WHERE peer_id = ?", ["2000-01-01T00:00:00.000Z", "mac-lease-dead"]);
  db.close();
  const before = wakes.length;
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "mac-lease-dead", text: "lease-mail" });
  try {
    expect(sent.json.ok).toBe(true);
    expect(sent.json.wake).toBe("sent");
    expect(wakes.length).toBe(before + 1);
  } finally {
    sleeper.kill();
  }
});

test("a heartbeat keeps a route alive across unregister", async () => {
  expect((await post("/register", seat("codex-only", { runtime: "codex" }))).status).toBe(200);
  const { Database } = await import("bun:sqlite");
  const db = new Database(DB);
  db.run("UPDATE peer_routes SET updated_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", "codex-only"]);
  db.close();
  const beat = await post("/heartbeat", { id: "codex-only" });
  expect(beat.json.found).toBe(true);
  await post("/unregister", { id: "codex-only" });
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "codex-only", text: "still-routed" });
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBe("sent");
});

test("one stored message gets one wake even when the retry overlaps", async () => {
  let release: () => void = () => {};
  bellHold = new Promise<void>((resolve) => { release = resolve; });
  setTimeout(release, 100);
  const marker = wakes.length;
  const [first, second] = await Promise.all([
    post("/send-message", { from_id: "mac-sender", to_id: "codex-lost", text: "overlap", client_message_id: "overlap-1" }),
    post("/send-message", { from_id: "mac-sender", to_id: "codex-lost", text: "overlap", client_message_id: "overlap-1" }),
  ]);
  bellHold = null;
  expect(first.json.wake).toBe("sent");
  expect(second.json.wake).toBe("sent");
  expect(wakes.length).toBe(marker + 1);
});

test("a route is not moved to another machine", async () => {
  const owner = await post("/register", seat("mac-home", { runtime: "claude:t3:mcp:11111111-1111-4111-8111-111111111111", machine: "mac" }));
  expect(owner.json.id).toBe("mac-home");
  await post("/unregister", { id: "mac-home" });
  const other = await post("/register", seat("mac-home", { runtime: "claude", machine: "pc", pid: process.pid }));
  expect(other.json.id).toBe("mac-home");
  const { Database } = await import("bun:sqlite");
  const db = new Database(DB, { readonly: true });
  const route = db.query("SELECT machine, runtime FROM peer_routes WHERE id = ?").get("mac-home") as { machine: string; runtime: string };
  db.close();
  expect(route.machine).toBe("mac");
  expect(route.runtime).toBe("claude:t3:mcp:11111111-1111-4111-8111-111111111111");
});

test("a bell that does not answer within 4 seconds comes back failed, with the mail stored", async () => {
  bellHold = new Promise<void>(() => {});
  const started = Date.now();
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "codex-lost", text: "slow", client_message_id: "slow-1" });
  const elapsed = Date.now() - started;
  bellHold = null;
  expect(elapsed).toBeGreaterThan(3000);
  expect(elapsed).toBeLessThan(6000);
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBe("failed");
  expect(sent.json.message_id).toBeGreaterThan(0);
});

test("a send never returns pending", async () => {
  const sent = await post("/send-message", {
    from_id: "mac-sender", to_id: "codex-lost", text: "terminal", client_message_id: "no-pending-1",
  });
  expect(sent.status).toBe(200);
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).not.toBe("pending");
  expect(["sent", "failed", "no-route", "unconfigured", "skipped"]).toContain(sent.json.wake);
  const { Database } = await import("bun:sqlite");
  const db = new Database(DB, { readonly: true });
  const row = db.query("SELECT wake_state FROM messages WHERE id = ?").get(sent.json.message_id) as { wake_state: string | null };
  const columns = db.query("PRAGMA table_info(messages)").all() as { name: string }[];
  db.close();
  expect(row.wake_state).not.toBe("pending");
  expect(columns.some((column) => column.name === "wake_command_id")).toBe(false);
});

test("a retry after the bell times out repeats the same message id", async () => {
  bellHold = new Promise(() => {});
  const marker = wakes.length;
  const first = await post("/send-message", {
    from_id: "mac-sender", to_id: "codex-lost", text: "late", client_message_id: "late-1",
  });
  expect(first.json.wake).toBe("failed");
  expect(first.json.wake).not.toBe("pending");
  bellHold = null;
  const again = await post("/send-message", {
    from_id: "mac-sender", to_id: "codex-lost", text: "late", client_message_id: "late-1",
  });
  expect(again.json.message_id).toBe(first.json.message_id);
  expect(again.json.wake).toBe("sent");
  expect(wakes[marker]?.body.message_id).toBe(first.json.message_id);
  expect(wakes.at(-1)?.body.message_id).toBe(first.json.message_id);
}, 15_000);

test("a bookkeeping failure still returns the accepted message", async () => {
  let release: () => void = () => {};
  bellHold = new Promise<void>((resolve) => { release = resolve; });
  const marker = wakes.length;
  const inflight = post("/send-message", {
    from_id: "mac-sender", to_id: "codex-lost", text: "locked", client_message_id: "locked-1",
  });
  for (let i = 0; i < 50 && wakes.length === marker; i++) await Bun.sleep(20);
  expect(wakes.length).toBe(marker + 1);
  const { Database } = await import("bun:sqlite");
  const lock = new Database(DB);
  lock.run("PRAGMA busy_timeout = 2000");
  lock.exec("BEGIN EXCLUSIVE");
  release();
  const sent = await inflight;
  lock.exec("ROLLBACK");
  lock.close();
  bellHold = null;
  expect(sent.status).toBe(200);
  expect(sent.json.ok).toBe(true);
  expect(sent.json.message_id).toBeGreaterThan(0);
  expect(sent.json.wake).toBe("sent");
  const check = new Database(DB, { readonly: true });
  const row = check.query("SELECT wake_state FROM messages WHERE id = ?").get(sent.json.message_id) as { wake_state: string | null };
  check.close();
  expect(row.wake_state).toBeNull();
}, 10_000);
