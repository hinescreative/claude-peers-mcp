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

const wakes: { body: any; auth: string | null }[] = [];
let bellMode: "ok" | "no-route" = "ok";
const bell = Bun.serve({
  port: BELL_PORT,
  fetch: async (req) => {
    wakes.push({ body: await req.json(), auth: req.headers.get("Authorization") });
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
  expect(sent.json.ok).toBe(false);
  expect(sent.json.error).toBe("no-route");
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
