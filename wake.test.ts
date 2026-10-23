import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadRoutes, matchWorktree, planWake, wakeCommandId, WAKE_TEXT } from "./protocol.mjs";
import { isNoPush, parentChanged } from "./bell-protocol.ts";

const THREAD = "mcp:36a41ff7-8eef-49ab-a947-55027c14f468";
const WORKTREE = "/Users/wesleyhines/.t3/worktrees/bell-proof/codex";

test("a broker wake uses one command id and the fixed line", () => {
  expect(wakeCommandId(7)).toBe(wakeCommandId(7));
  expect(wakeCommandId(7)).not.toBe(wakeCommandId(8));
  expect(wakeCommandId(7)[14]).toBe("5");
  const planned = planWake({
    routes: { "mac-shaw": { threadId: THREAD } },
    to_id: "mac-shaw",
    message_id: 7,
    from_id: "mac-sender",
    cwd: "/tmp/root",
  });
  expect(planned.text).toBe(WAKE_TEXT);
  expect(planned.commandId).toBe(wakeCommandId(7));
  expect(planned.text).not.toContain("secret");
});

test("a worktree match is one live non-fork thread, and a route file wins", () => {
  const threads = [{ id: THREAD, worktreePath: WORKTREE, archivedAt: null }];
  expect(matchWorktree(threads, WORKTREE)).toBe(THREAD);
  expect(matchWorktree(threads, "/Users/wesleyhines/hines/assistant-claude")).toBeNull();
  expect(matchWorktree([{ id: "mcp:22222222-2222-4222-8222-222222222222:fork", worktreePath: WORKTREE, archivedAt: null }], WORKTREE)).toBeNull();
  expect(matchWorktree([
    { id: THREAD, worktreePath: WORKTREE, archivedAt: null },
    { id: "mcp:33333333-3333-4333-8333-333333333333", worktreePath: WORKTREE, archivedAt: null },
  ], WORKTREE)).toBeNull();
  const routed = planWake({
    routes: { "codex-seat": { threadId: "mcp:44444444-4444-4444-8444-444444444444" } },
    to_id: "codex-seat",
    message_id: 1,
    cwd: WORKTREE,
    threads,
  });
  expect(routed.threadId).toBe("mcp:44444444-4444-4444-8444-444444444444");
  const matched = planWake({ routes: {}, to_id: "codex-seat", message_id: 1, cwd: WORKTREE, threads });
  expect(matched.threadId).toBe(THREAD);
  const missing = planWake({ routes: {}, to_id: "codex-seat", message_id: 1, cwd: "/tmp/nope", threads });
  expect(missing.error).toBe("no-route");
});

test("the parent-death predicate notices a new parent and ignores pid 1", () => {
  const died = parentChanged;
  expect(died(10, 11)).toBe(true);
  expect(died(10, 10)).toBe(false);
  expect(died(1, 50)).toBe(false);
  const source = readFileSync(new URL("./codex-server.ts", import.meta.url), "utf8");
  expect(source).toContain("return parentChanged(START_PARENT_PID, currentParent);");
});

test("an explicit route may name the Assistant fork", () => {
  const fork = "mcp:3e3e7dbd-4ab2-454b-8ae2-cebf0a87193c:fork";
  const routes = loadRoutes(JSON.stringify({ routes: { "mac-assistant-claude-no-tty": { threadId: fork } } }));
  expect(routes["mac-assistant-claude-no-tty"].threadId).toBe(fork);
});

const probe = Bun.serve({ port: 0, fetch() { return new Response(""); } });
const PORT = probe.port;
probe.stop(true);
const edgeProbe = Bun.serve({ port: 0, fetch() { return new Response(""); } });
const EDGE_PORT = edgeProbe.port;
edgeProbe.stop(true);
const DB = `/tmp/claude-peers-wake-${process.pid}.db`;
const BASE = `http://127.0.0.1:${PORT}`;
const wakes: any[] = [];
const wakeAuth: (string | null)[] = [];
let edgeMode: "ok" | "no-route" | "hold" = "ok";
const edge = Bun.serve({
  port: EDGE_PORT,
  fetch: async (req) => {
    const body = await req.json();
    wakes.push(body);
    wakeAuth.push(req.headers.get("Authorization"));
    if (edgeMode === "hold") await new Promise(() => {});
    if (edgeMode === "no-route") return Response.json({ ok: false, error: "no-route" });
    return Response.json({ ok: true, threadId: THREAD, dispatchMode: "start_immediately" });
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
  return { requested_id: id, pid: process.pid, cwd: WORKTREE, git_root: null, tty: null, machine: "mac", summary: id, ...extra };
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
      LEAD_WAKE_URL: `http://127.0.0.1:${EDGE_PORT}/wake`,
      CLAUDE_CODE_MESSAGING_SOCKET: "",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return; } catch { /* not up */ }
    await Bun.sleep(50);
  }
  throw new Error("broker did not start");
});

afterAll(() => {
  proc?.kill();
  edge.stop(true);
});

test("a live seat with a socket is not forwarded", async () => {
  expect((await post("/register", seat("mac-live", { runtime: "claude" }))).status).toBe(200);
  expect((await post("/register", seat("mac-sender", { pid: 7 }))).status).toBe(200);
  const before = wakes.length;
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "mac-live", text: "hello" });
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBeUndefined();
  expect(wakes.length).toBe(before);
});

test("a missing seat is forwarded", async () => {
  const before = wakes.length;
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "missing-seat", text: "where" });
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBe("sent");
  expect(wakes.length).toBe(before + 1);
  expect(wakes.at(-1).to_id).toBe("missing-seat");
  expect(wakes.at(-1).message_id).toBe(sent.json.message_id);
});

test("a stale seat is forwarded", async () => {
  expect((await post("/register", seat("mac-stale", { runtime: "claude" }))).status).toBe(200);
  const { Database } = await import("bun:sqlite");
  const db = new Database(DB);
  db.run("UPDATE peers SET last_seen = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", "mac-stale"]);
  db.close();
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "mac-stale", text: "old" });
  expect(sent.json.wake).toBe("sent");
  expect(wakes.at(-1).cwd).toBe(WORKTREE);
});

test("a poll-only seat is forwarded", async () => {
  expect((await post("/register", seat("mac-poll", { runtime: "poll" }))).status).toBe(200);
  const before = wakes.length;
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "mac-poll", text: "ping" });
  expect(sent.json.wake).toBe("sent");
  expect(wakes.length).toBe(before + 1);
});

test("a valid unknown id is forwarded to the edge", async () => {
  const before = wakes.length;
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "no-such-seat", text: "where" });
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBe("sent");
  expect(wakes.length).toBe(before + 1);
  expect(wakes.at(-1).to_id).toBe("no-such-seat");
});

test("an invalid id is stored and not forwarded", async () => {
  const before = wakes.length;
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "bad id", text: "nope" });
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBe("no-route");
  expect(wakes.length).toBe(before);
});

test("the edge's no-route and sent statuses come back unchanged", async () => {
  edgeMode = "no-route";
  const missed = await post("/send-message", { from_id: "mac-sender", to_id: "nobody-home", text: "x" });
  expect(missed.json.ok).toBe(true);
  expect(missed.json.wake).toBe("no-route");
  edgeMode = "ok";
  const hit = await post("/send-message", { from_id: "mac-sender", to_id: "somebody-home", text: "y" });
  expect(hit.json.wake).toBe("sent");
});

test("a stuck edge comes back failed within 3 seconds and the mail stays", async () => {
  edgeMode = "hold";
  const started = Date.now();
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "slow-seat", text: "wait" });
  const elapsed = Date.now() - started;
  edgeMode = "ok";
  expect(elapsed).toBeGreaterThan(2500);
  expect(elapsed).toBeLessThan(3900);
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBe("failed");
  expect(sent.json.message_id).toBeGreaterThan(0);
}, 15_000);

test("a completed retry keeps its message when the recipient has gone stale", async () => {
  expect((await post("/register", seat("mac-retry", { runtime: "claude" }))).status).toBe(200);
  const first = await post("/send-message", {
    from_id: "mac-sender", to_id: "mac-retry", text: "keep-me", client_message_id: "dup-1",
  });
  expect(first.json.ok).toBe(true);
  expect(first.json.wake).toBeUndefined();
  const { Database } = await import("bun:sqlite");
  const db = new Database(DB);
  db.run("UPDATE peers SET last_seen = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", "mac-retry"]);
  db.close();
  const again = await post("/send-message", {
    from_id: "mac-sender", to_id: "mac-retry", text: "keep-me", client_message_id: "dup-1",
  });
  expect(again.json.ok).toBe(true);
  expect(again.json.duplicate).toBe(true);
  expect(again.json.message_id).toBe(first.json.message_id);
  expect(again.json.wake).toBe("sent");
  const check = new Database(DB, { readonly: true });
  const row = check.query("SELECT id, text FROM messages WHERE id = ?").get(first.json.message_id) as { id: number; text: string } | null;
  check.close();
  expect(row?.text).toBe("keep-me");
});

test("a dead local pid with a fresh heartbeat is forwarded, using the saved cwd", async () => {
  const host = (await import("node:os")).hostname();
  expect((await post("/register", seat("mac-dead", { runtime: "claude", machine: host, pid: 2147483646, cwd: WORKTREE }))).status).toBe(200);
  const before = wakes.length;
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "mac-dead", text: "gone" });
  expect(sent.json.wake).toBe("sent");
  expect(wakes.length).toBe(before + 1);
  expect(wakes.at(-1).cwd).toBe(WORKTREE);
});

test("codex-direct ask prints the wake line and does not wait after no-route", async () => {
  edgeMode = "no-route";
  const started = Date.now();
  const child = Bun.spawn(["bun", "codex-direct.ts", "ask", "ask-target", "hello", "--seconds", "30"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_PEERS_BROKER_URL: BASE,
      CLAUDE_PEERS_TOKEN: "test-token",
      CLAUDE_PEERS_MACHINE: "mac",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  const text = await new Response(child.stdout).text();
  edgeMode = "ok";
  expect(Date.now() - started).toBeLessThan(5000);
  expect(text).toContain("wake: no-route");
  expect(code).toBe(1);
});

test("an unset lead-wake url is unconfigured and does not call the edge", async () => {
  const bare = Bun.serve({ port: 0, fetch() { return new Response(""); } });
  const port = bare.port;
  bare.stop(true);
  const db = `/tmp/claude-peers-wake-off-${process.pid}.db`;
  const child = Bun.spawn(["bun", "broker.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: db,
      CLAUDE_PEERS_TOKEN: "test-token",
      CLAUDE_PEERS_TOKENS: "",
      CLAUDE_PEERS_TOKENS_FILE: "",
      LEAD_WAKE_URL: "",
      CLAUDE_CODE_MESSAGING_SOCKET: "",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up */ }
      await Bun.sleep(50);
    }
    const reg = await fetch(`http://127.0.0.1:${port}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify(seat("off-sender")),
    });
    expect(reg.ok).toBe(true);
    const before = wakes.length;
    const res = await fetch(`http://127.0.0.1:${port}/send-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ from_id: "off-sender", to_id: "off-target", text: "z" }),
    });
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.wake).toBe("unconfigured");
    expect(wakes.length).toBe(before);
  } finally {
    child.kill();
  }
});

async function waitHealth(url: string) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up */ }
    await Bun.sleep(50);
  }
  throw new Error(`not up: ${url}`);
}

async function mcpRegister(script: string, env: Record<string, string>) {
  const child = Bun.spawn(["bun", script], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_PEERS_BROKER_URL: BASE,
      CLAUDE_PEERS_TOKEN: "test-token",
      CLAUDE_PEERS_MACHINE: "mac",
      CLAUDE_CODE_MESSAGING_SOCKET: "",
      CLAUDE_CODE_MESSAGING_TOKEN: "",
      ...env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines: string[] = [];
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const pump = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) lines.push(line);
    }
  })();
  if (script === "server.ts") {
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "wake-test", version: "1" } },
    }) + "\n");
    for (let i = 0; i < 40 && !lines.some((line) => line.includes('"id":1')); i++) await Bun.sleep(25);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  return { child, pump };
}

test("codex-server registers a runtime with no push channel", async () => {
  const { child } = await mcpRegister("codex-server.ts", { CODEX_PEER_ID: "real-codex" });
  try {
    let runtime = "";
    for (let i = 0; i < 40; i++) {
      const list = await post("/list-peers", { scope: "fleet", cwd: "/", git_root: null });
      runtime = (list.json as { id: string; runtime: string | null }[]).find((peer) => peer.id === "real-codex")?.runtime ?? "";
      if (runtime) break;
      await Bun.sleep(50);
    }
    expect(runtime).toBe("codex");
    expect(isNoPush(runtime)).toBe(true);
  } finally {
    child.kill();
  }
});

test("server.ts registers claude, and a later registration does not keep poll", async () => {
  const first = await mcpRegister("server.ts", {
    CLAUDE_PEER_ID: "real-claude",
    CLAUDE_PEERS_DISABLE_CHANNEL: "1",
  });
  try {
    let runtime = "";
    for (let i = 0; i < 50; i++) {
      const list = await post("/list-peers", { scope: "fleet", cwd: "/", git_root: null });
      runtime = (list.json as { id: string; runtime: string | null }[]).find((peer) => peer.id === "real-claude")?.runtime ?? "";
      if (runtime) break;
      await Bun.sleep(50);
    }
    expect(runtime).toBe("poll");
  } finally {
    first.child.kill("SIGKILL");
  }
  const { Database } = await import("bun:sqlite");
  const db = new Database(DB);
  db.run("UPDATE peer_leases SET expires_at = ? WHERE peer_id = ?", ["2000-01-01T00:00:00.000Z", "real-claude"]);
  db.close();
  const second = await mcpRegister("server.ts", { CLAUDE_PEER_ID: "real-claude" });
  try {
    let runtime = "";
    for (let i = 0; i < 50; i++) {
      const list = await post("/list-peers", { scope: "fleet", cwd: "/", git_root: null });
      runtime = (list.json as { id: string; runtime: string | null }[]).find((peer) => peer.id === "real-claude")?.runtime ?? "";
      if (runtime === "claude") break;
      await Bun.sleep(50);
    }
    expect(runtime).toBe("claude");
  } finally {
    second.child.kill("SIGKILL");
  }
});

test("the outbound bearer is the first tokens-file line when the env token is unset", async () => {
  const { writeFileSync } = await import("node:fs");
  const file = `/tmp/peers-wake-tokens-${process.pid}.txt`;
  writeFileSync(file, "file-token\nsecond-token\n");
  const bare = Bun.serve({ port: 0, fetch() { return new Response(""); } });
  const port = bare.port;
  bare.stop(true);
  const child = Bun.spawn(["bun", "broker.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: `/tmp/claude-peers-wake-token-${process.pid}.db`,
      CLAUDE_PEERS_TOKEN: "",
      CLAUDE_PEERS_TOKENS: "",
      CLAUDE_PEERS_TOKENS_FILE: file,
      LEAD_WAKE_URL: `http://127.0.0.1:${EDGE_PORT}/wake`,
      CLAUDE_CODE_MESSAGING_SOCKET: "",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await waitHealth(`http://127.0.0.1:${port}/health`);
    const reg = await fetch(`http://127.0.0.1:${port}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer file-token" },
      body: JSON.stringify(seat("token-sender")),
    });
    expect(reg.ok).toBe(true);
    const before = wakes.length;
    const res = await fetch(`http://127.0.0.1:${port}/send-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer file-token" },
      body: JSON.stringify({ from_id: "token-sender", to_id: "token-target", text: "tok" }),
    });
    const json = await res.json();
    expect(json.wake).toBe("sent");
    expect(wakeAuth[before]).toBe("Bearer file-token");
  } finally {
    child.kill();
  }
});

test("mail to a missing seat older than a day is deleted and a fresh one stays", async () => {
  const old = await post("/send-message", { from_id: "mac-sender", to_id: "gone-seat", text: "old-mail" });
  const { Database } = await import("bun:sqlite");
  const db = new Database(DB);
  db.run("UPDATE messages SET sent_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", old.json.message_id]);
  db.close();
  const fresh = await post("/send-message", { from_id: "mac-sender", to_id: "gone-seat", text: "fresh-mail" });
  const check = new Database(DB, { readonly: true });
  const oldRow = check.query("SELECT id FROM messages WHERE id = ?").get(old.json.message_id);
  const freshRow = check.query("SELECT text FROM messages WHERE id = ?").get(fresh.json.message_id) as { text: string } | null;
  check.close();
  expect(oldRow).toBeNull();
  expect(freshRow?.text).toBe("fresh-mail");
});

async function runtimeOf(id: string) {
  const list = await post("/list-peers", { scope: "fleet", cwd: "/", git_root: null });
  return (list.json as { id: string; runtime: string | null }[]).find((peer) => peer.id === id)?.runtime ?? "";
}

async function waitRuntime(id: string) {
  let runtime = "";
  for (let i = 0; i < 40 && !runtime; i++) {
    runtime = await runtimeOf(id);
    if (!runtime) await Bun.sleep(50);
  }
  return runtime;
}

test("grok-edge registers hosted and a live send is not forwarded", async () => {
  const child = Bun.spawn(["bun", "grok-edge.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_PEERS_BROKER_URL: BASE,
      CLAUDE_PEERS_TOKEN: "test-token",
      GROK_MCP_TOKEN: "public-token",
      GROK_PEER_ID: "grok-hosted-test",
      GROK_EDGE_HOST: "127.0.0.1",
      GROK_EDGE_PORT: "18791",
      CLAUDE_CODE_MESSAGING_SOCKET: "",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    expect(await waitRuntime("grok-hosted-test")).toBe("hosted");
    const before = wakes.length;
    const sent = await post("/send-message", { from_id: "mac-sender", to_id: "grok-hosted-test", text: "hi" });
    expect(sent.json.wake).toBeUndefined();
    expect(wakes.length).toBe(before);
  } finally {
    child.kill();
  }
});

test("butler-inbox registers hosted and a live send is not forwarded", async () => {
  const child = Bun.spawn(["bun", "butler-inbox-edge.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_PEERS_BROKER_URL: BASE,
      CLAUDE_PEERS_TOKEN: "test-token",
      BUTLER_INBOX_HOST: "127.0.0.1",
      BUTLER_INBOX_PORT: "18794",
      BUTLER_INBOX_STATE: `/tmp/butler-inbox-test-${process.pid}`,
      CLAUDE_CODE_MESSAGING_SOCKET: "",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    expect(await waitRuntime("butler-inbox")).toBe("hosted");
    const before = wakes.length;
    const sent = await post("/send-message", { from_id: "mac-sender", to_id: "butler-inbox", text: "hi" });
    expect(sent.json.wake).toBeUndefined();
    expect(wakes.length).toBe(before);
  } finally {
    child.kill();
  }
});

test("a request to lead-wake comes back as a reply the sender can read", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const state = `/tmp/lead-wake-test-${process.pid}`;
  mkdirSync(state, { recursive: true });
  writeFileSync(`${state}/routes.json`, '{"routes":{}}');
  const child = Bun.spawn(["bun", "lead-wake-edge.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_PEERS_BROKER_URL: BASE,
      CLAUDE_PEERS_TOKEN: "test-token",
      LEAD_WAKE_HOST: "127.0.0.1",
      LEAD_WAKE_PORT: "18811",
      LEAD_WAKE_STATE: state,
      LEAD_WAKE_ROUTES: `${state}/routes.json`,
      LEAD_WAKE_T3: `${state}/missing-t3.json`,
      CLAUDE_CODE_MESSAGING_SOCKET: "",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    expect(await waitRuntime("lead-wake")).toBe("hosted");
    const before = wakes.length;
    const sent = await post("/send-message", {
      from_id: "mac-sender", to_id: "lead-wake", text: "to: nobody-home\nhello there",
    });
    expect(sent.json.ok).toBe(true);
    expect(sent.json.wake).toBeUndefined();
    expect(wakes.length).toBe(before);
    let reply = "";
    for (let i = 0; i < 20; i++) {
      const polled = await post("/poll-messages", { id: "mac-sender" });
      const hit = (polled.json.messages as { from_id: string; text: string }[] | undefined)?.find((message) => message.from_id === "lead-wake");
      if (hit) { reply = hit.text; break; }
      await Bun.sleep(500);
    }
    expect(reply).toContain("lead-wake:");
  } finally {
    child.kill();
  }
}, 15_000);

test("a machine with a bell is woken by its bell; anything else still goes to lead-wake", async () => {
  const { writeFileSync } = await import("node:fs");
  const bellHits: any[] = [];
  const bell = Bun.serve({
    port: 0,
    fetch: async (req) => {
      bellHits.push(await req.json());
      return Response.json({ ok: true, threadId: THREAD, dispatchMode: "start_immediately" });
    },
  });
  const bellsFile = `/tmp/claude-peers-wake-bells-${process.pid}.json`;
  writeFileSync(bellsFile, JSON.stringify({ bells: { belled: `http://127.0.0.1:${bell.port}` } }));
  const bare = Bun.serve({ port: 0, fetch() { return new Response(""); } });
  const port = bare.port;
  bare.stop(true);
  const child = Bun.spawn(["bun", "broker.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: `/tmp/claude-peers-wake-both-${process.pid}.db`,
      CLAUDE_PEERS_TOKEN: "test-token",
      CLAUDE_PEERS_TOKENS: "",
      CLAUDE_PEERS_TOKENS_FILE: "",
      CLAUDE_PEERS_BELLS: bellsFile,
      LEAD_WAKE_URL: `http://127.0.0.1:${EDGE_PORT}/wake`,
      CLAUDE_CODE_MESSAGING_SOCKET: "",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const call = async (path: string, body: Record<string, unknown>) => (await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  })).json() as Promise<any>;
  try {
    await waitHealth(`http://127.0.0.1:${port}/health`);
    await call("/register", seat("both-sender"));
    await call("/register", seat("belled-codex", { machine: "belled", runtime: "codex" }));
    await call("/register", seat("plain-codex", { machine: "plain", runtime: "codex" }));
    const edgeBefore = wakes.length;
    const viaBell = await call("/send-message", { from_id: "both-sender", to_id: "belled-codex", text: "a" });
    expect(viaBell.wake).toBe("sent");
    expect(bellHits.at(-1)?.to_id).toBe("belled-codex");
    expect(wakes.length).toBe(edgeBefore);
    const viaEdge = await call("/send-message", { from_id: "both-sender", to_id: "plain-codex", text: "b" });
    expect(viaEdge.wake).toBe("sent");
    expect(wakes.at(-1)?.to_id).toBe("plain-codex");
    expect(bellHits.length).toBe(1);
  } finally {
    child.kill();
    bell.stop(true);
  }
});
