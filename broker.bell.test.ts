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
    const body = await req.json();
    if (bellHold) await bellHold;
    wakes.push({ body, auth: req.headers.get("Authorization"), command_id: body.command_id });
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
  expect(sent.json.dispatchMode).toBe("queue_after_active");
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
  expect(sent.json).toEqual({ ok: false, error: "no-route" });
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

test("a live nickname cannot be taken, and assistant stays reserved", async () => {
  expect((await post("/register", seat("mac-one"))).status).toBe(200);
  expect((await post("/register", seat("mac-two", { pid: 8 }))).status).toBe(200);
  expect((await post("/set-nickname", { id: "mac-one", nickname: "Fable" })).json.ok).toBe(true);
  const taken = await post("/set-nickname", { id: "mac-two", nickname: "fable" });
  expect(taken.status).toBe(409);
  expect(taken.json.error).toBe("nickname taken");
  const reserved = await post("/set-nickname", { id: "mac-two", nickname: "assistant" });
  expect(reserved.status).toBe(409);
  expect(reserved.json.error).toBe("nickname reserved");
  expect((await post("/register", seat("mac-assistant-claude-no-tty", { pid: 9 }))).status).toBe(200);
  expect((await post("/set-nickname", { id: "mac-assistant-claude-no-tty", nickname: "assistant" })).json.ok).toBe(true);
});

test("registration cannot take a reserved or held nickname", async () => {
  const owner = await post("/register", seat("mac-assistant-claude-no-tty", { nickname: "assistant" }));
  expect(owner.status).toBe(200);
  const impostor = await post("/register", seat("mac-impostor", { nickname: "assistant", pid: process.ppid || process.pid }));
  expect(impostor.status).toBe(200);
  const list = await post("/list-peers", { scope: "fleet", cwd: "/work/only", git_root: null });
  const rows = list.json as { id: string; nickname: string }[];
  expect(rows.find((row) => row.id === "mac-impostor")?.nickname).toBe("");
  expect(rows.find((row) => row.id === "mac-assistant-claude-no-tty")?.nickname).toBe("assistant");
});

test("a restarted suffixed seat keeps the mail, and the reserved owner reclaims the base", async () => {
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

  const old = await post("/register", {
    ...seat("mac-assistant-claude-no-tty", { pid: process.pid, cwd: "/tmp/assistant" }),
    instance_id: "assistant-old-01",
    payload_version: 2,
    nickname: "Grok",
  });
  expect(old.json.id).toBe("mac-assistant-claude-no-tty");
  const respawn = await post("/register", {
    ...seat("mac-assistant-claude-no-tty", { pid: process.ppid || process.pid, cwd: "/tmp/assistant" }),
    instance_id: "assistant-new-02",
    payload_version: 2,
    nickname: "Grok",
  });
  expect(String(respawn.json.id).startsWith("mac-assistant-claude-no-tty-")).toBe(true);
  const denied = await post("/set-nickname", {
    id: respawn.json.id, nickname: "assistant", instance_id: "assistant-new-02", lease_id: respawn.json.lease_id,
  });
  expect(denied.status).toBe(409);
  await post("/unregister", { id: old.json.id, instance_id: "assistant-old-01", lease_id: old.json.lease_id });
  const reclaimed = await post("/register", {
    ...seat("mac-assistant-claude-no-tty", { pid: process.ppid || process.pid, cwd: "/tmp/assistant" }),
    instance_id: "assistant-new-02",
    lease_id: respawn.json.lease_id,
    payload_version: 2,
    nickname: "Grok",
  });
  expect(reclaimed.json.id).toBe("mac-assistant-claude-no-tty");
  const claimed = await post("/set-nickname", {
    id: reclaimed.json.id, nickname: "assistant", instance_id: "assistant-new-02", lease_id: reclaimed.json.lease_id,
  });
  expect(claimed.json.ok).toBe(true);
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
  const marker = wakes.length;
  const first = post("/send-message", {
    from_id: "mac-sender", to_id: "codex-lost", text: "overlap", client_message_id: "overlap-1",
  });
  await Bun.sleep(80);
  const second = await post("/send-message", {
    from_id: "mac-sender", to_id: "codex-lost", text: "overlap", client_message_id: "overlap-1",
  });
  expect(second.json.wake).toBe("pending");
  expect(wakes.length).toBe(marker);
  release();
  bellHold = null;
  const done = await first;
  expect(done.json.ok).toBe(true);
  expect(wakes.length).toBe(marker + 1);
});
