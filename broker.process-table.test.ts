import { afterAll, beforeAll, expect, test } from "bun:test";

const probe = Bun.serve({ port: 0, fetch() { return new Response(""); } });
const PORT = probe.port;
probe.stop(true);
const DB = `/tmp/claude-peers-pt-${process.pid}.db`;
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ReturnType<typeof Bun.spawn> | null = null;

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(BASE + "/health");
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(50);
  }
  throw new Error("broker did not start");
}

const oldPayload = {
  requested_id: "test-old-client",
  pid: 4242,
  cwd: "/tmp/old",
  git_root: null,
  tty: null,
  machine: "testbox",
  summary: "old client",
  ignored_future_field: "ok",
};

beforeAll(async () => {
  try {
    await Bun.file(DB).delete();
  } catch {
    // no prior db
  }
  proc = Bun.spawn(["bun", "broker.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(PORT),
      CLAUDE_PEERS_DB: DB,
      CLAUDE_PEERS_TOKEN: "",
      CLAUDE_PEERS_REQUIRE_AUTH: "",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitHealth();
});

afterAll(() => {
  proc?.kill();
  for (const extra of ["", "-wal", "-shm"]) {
    try {
      Bun.file(DB + extra).delete();
    } catch {
      // ignore
    }
  }
});

test("old register payload still works", async () => {
  const reg = await post("/register", oldPayload);
  expect(reg.status).toBe(200);
  expect(reg.json.id).toBe("test-old-client");
  const list = await post("/list-peers", {
    scope: "fleet",
    cwd: "/tmp/old",
    git_root: null,
  });
  expect(list.status).toBe(200);
  const row = (list.json as { id: string; parent_id: string | null; rings: number[] | null }[]).find(
    (p) => p.id === "test-old-client",
  );
  expect(row).toBeTruthy();
  expect(row?.parent_id ?? null).toBeNull();
  expect(row?.rings ?? null).toBeNull();
});

test("new register persists parent runtime rings", async () => {
  const reg = await post("/register", {
    requested_id: "test-new-client",
    pid: 4243,
    cwd: "/tmp/new",
    git_root: null,
    tty: null,
    machine: "testbox",
    summary: "new client",
    parent_id: "test-old-client",
    runtime: "grok-build",
    rings: [1, 2, 3],
  });
  expect(reg.status).toBe(200);
  const list = await post("/list-peers", { scope: "fleet", cwd: "/tmp/new", git_root: null });
  const row = (list.json as { id: string; parent_id: string; runtime: string; rings: number[] }[]).find(
    (p) => p.id === "test-new-client",
  );
  expect(row?.parent_id).toBe("test-old-client");
  expect(row?.runtime).toBe("grok-build");
  expect(row?.rings).toEqual([1, 2, 3]);
});

test("re-register without new fields keeps parent runtime rings", async () => {
  const reg = await post("/register", {
    requested_id: "test-new-client",
    pid: 4243,
    cwd: "/tmp/new",
    git_root: null,
    tty: null,
    machine: "testbox",
    summary: "new client again",
  });
  expect(reg.status).toBe(200);
  const list = await post("/list-peers", { scope: "fleet", cwd: "/tmp/new", git_root: null });
  const row = (list.json as { id: string; parent_id: string; runtime: string; rings: number[] }[]).find(
    (p) => p.id === "test-new-client",
  );
  expect(row?.parent_id).toBe("test-old-client");
  expect(row?.runtime).toBe("grok-build");
  expect(row?.rings).toEqual([1, 2, 3]);
});

test("heartbeat id-only still works", async () => {
  const beforeList = await post("/list-peers", { scope: "fleet", cwd: "/tmp/old", git_root: null });
  const before = (beforeList.json as { id: string; last_seen: string }[]).find(
    (p) => p.id === "test-old-client",
  );
  await Bun.sleep(20);
  const hb = await post("/heartbeat", { id: "test-old-client" });
  expect(hb.status).toBe(200);
  expect(hb.json.ok).toBe(true);
  expect(hb.json.found).toBe(true);
  const afterList = await post("/list-peers", { scope: "fleet", cwd: "/tmp/old", git_root: null });
  const after = (afterList.json as { id: string; last_seen: string }[]).find(
    (p) => p.id === "test-old-client",
  );
  expect(after?.last_seen).toBeTruthy();
  expect(after!.last_seen >= before!.last_seen).toBe(true);
});

test("heartbeat context_used updates rss", async () => {
  const hb = await post("/heartbeat", { id: "test-new-client", context_used: 12000, context_window: 500000 });
  expect(hb.status).toBe(200);
  expect(hb.json.found).toBe(true);
  const list = await post("/list-peers", { scope: "fleet", cwd: "/tmp/new", git_root: null });
  const row = (list.json as { id: string; context_used: number; context_window: number }[]).find(
    (p) => p.id === "test-new-client",
  );
  expect(row?.context_used).toBe(12000);
  expect(row?.context_window).toBe(500000);

  const idOnly = await post("/heartbeat", { id: "test-new-client" });
  expect(idOnly.json.found).toBe(true);
  const again = await post("/list-peers", { scope: "fleet", cwd: "/tmp/new", git_root: null });
  const still = (again.json as { id: string; context_used: number; context_window: number }[]).find(
    (p) => p.id === "test-new-client",
  );
  expect(still?.context_used).toBe(12000);
  expect(still?.context_window).toBe(500000);
});

test("send_message works when rings is null", async () => {
  const sent = await post("/send-message", {
    from_id: "test-old-client",
    to_id: "test-new-client",
    text: "hi",
  });
  expect(sent.status).toBe(200);
  expect(sent.json.ok).toBe(true);
});

test("duplicate nicknames still register", async () => {
  const a = await post("/register", {
    requested_id: "test-nick-a",
    nickname: "m3-bob-grok",
    pid: 5001,
    cwd: "/tmp/a",
    git_root: null,
    tty: "ttys001",
    machine: "testbox",
    summary: "a",
  });
  const b = await post("/register", {
    requested_id: "test-nick-b",
    nickname: "m3-bob-grok",
    pid: 5002,
    cwd: "/tmp/b",
    git_root: null,
    tty: "ttys002",
    machine: "testbox",
    summary: "b",
  });
  expect(a.json.id).toBe("test-nick-a");
  expect(b.json.id).toBe("test-nick-b");
});

test("set-state blocked_on", async () => {
  const st = await post("/set-state", { id: "test-old-client", blocked_on: "human" });
  expect(st.status).toBe(200);
  expect(st.json.ok).toBe(true);
  const list = await post("/list-peers", { scope: "fleet", cwd: "/tmp/old", git_root: null });
  const row = (list.json as { id: string; blocked_on: string; blocked_since: string | null }[]).find(
    (p) => p.id === "test-old-client",
  );
  expect(row?.blocked_on).toBe("human");
  expect(row?.blocked_since).toBeTruthy();
});

test("set-summary is unchanged by set-state", async () => {
  const set = await post("/set-summary", { id: "test-old-client", summary: "still summarizing" });
  expect(set.status).toBe(200);
  expect(set.json.ok).toBe(true);
  const list = await post("/list-peers", { scope: "fleet", cwd: "/tmp/old", git_root: null });
  const row = (list.json as { id: string; summary: string; blocked_on: string | null }[]).find(
    (p) => p.id === "test-old-client",
  );
  expect(row?.summary).toBe("still summarizing");
  expect(row?.blocked_on).toBe("human");
});
