import { afterAll, beforeAll, expect, test } from "bun:test";

// Card 719: a send to a nickname either reaches that seat or fails with an
// error the sender sees. Before this, the broker stored to_id=assistant and
// answered ok; nobody ever claimed that row.

const probe = Bun.serve({ port: 0, fetch() { return new Response(""); } });
const PORT = probe.port;
probe.stop(true);
const DB = `/tmp/claude-peers-nickname-${process.pid}.db`;
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ReturnType<typeof Bun.spawn> | null = null;

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// Distinct pids: the broker treats same pid + machine as a re-registration.
let nextPid = 41000;
function seat(id: string, extra: Record<string, unknown> = {}) {
  nextPid += 1;
  return { requested_id: id, pid: nextPid, cwd: "/tmp/nickname-test", git_root: null, tty: null, machine: "testbox", summary: id, runtime: "claude", ...extra };
}

async function inbox(id: string): Promise<{ to_id: string; text: string; kind: string }[]> {
  return (await post("/poll-messages", { id })).json.messages;
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
      LEAD_WAKE_URL: "",
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
});

test("a nickname that one peer holds routes to that peer's id, whatever the case", async () => {
  expect((await post("/register", seat("mac-assistant-test", { nickname: "assistant" }))).status).toBe(200);
  expect((await post("/register", seat("mac-sender", { nickname: "joey" }))).status).toBe(200);
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "assistant", text: "board reads hang" });
  expect(sent.status).toBe(200);
  expect(sent.json.ok).toBe(true);
  expect(sent.json.to_id).toBe("mac-assistant-test");
  expect(sent.json.resolved_from).toBe("assistant");
  expect(sent.json.wake).toBeUndefined();
  const upper = await post("/send-message", { from_id: "mac-sender", to_id: "ASSISTANT ", text: "again" });
  expect(upper.json.to_id).toBe("mac-assistant-test");
  const got = await inbox("mac-assistant-test");
  expect(got.map((m) => m.text)).toEqual(["board reads hang", "again"]);
  expect(got.every((m) => m.to_id === "mac-assistant-test")).toBe(true);
});

test("a reply may name the requester by nickname and still reverses the request", async () => {
  const ask = await post("/send-message", { from_id: "mac-sender", to_id: "assistant", text: "please", kind: "request" });
  expect(ask.json.ok).toBe(true);
  await inbox("mac-assistant-test");
  const reply = await post("/send-message", { from_id: "mac-assistant-test", to_id: "joey", text: "done", kind: "reply", reply_to_id: ask.json.message_id });
  expect(reply.status).toBe(200);
  expect(reply.json.to_id).toBe("mac-sender");
  expect(reply.json.resolved_from).toBe("joey");
  const got = await inbox("mac-sender");
  expect(got.map((m) => [m.kind, m.text])).toEqual([["reply", "done"]]);
});

test("a nickname several peers hold is refused with their ids and nothing is stored", async () => {
  expect((await post("/register", seat("mac-wildlife-a", { nickname: "claude" }))).status).toBe(200);
  expect((await post("/register", seat("mac-wildlife-b", { nickname: "Claude" }))).status).toBe(200);
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "claude", text: "which one" });
  expect(sent.status).toBe(409);
  expect(sent.json.error).toContain("mac-wildlife-a");
  expect(sent.json.error).toContain("mac-wildlife-b");
  expect(await inbox("mac-wildlife-a")).toEqual([]);
  expect(await inbox("mac-wildlife-b")).toEqual([]);
});

test("a peer id wins over another peer's nickname with the same text", async () => {
  expect((await post("/register", seat("mac-shaw"))).status).toBe(200);
  expect((await post("/register", seat("mac-impostor", { nickname: "mac-shaw" }))).status).toBe(200);
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "mac-shaw", text: "for shaw" });
  expect(sent.json.to_id).toBe("mac-shaw");
  expect(sent.json.resolved_from).toBeUndefined();
  expect((await inbox("mac-shaw")).map((m) => m.text)).toEqual(["for shaw"]);
  expect(await inbox("mac-impostor")).toEqual([]);
});

test("a name nobody holds is still stored for a later registration and says so", async () => {
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "nobody-here", text: "hello?" });
  expect(sent.status).toBe(200);
  expect(sent.json.to_id).toBe("nobody-here");
  expect(sent.json.resolved_from).toBeUndefined();
  expect(sent.json.wake).toBe("unconfigured");
});

test("the sender's tool text names the resolved peer, and a failed wake says the mail did not land", async () => {
  const { formatSendResult } = await import("./shared/message-contract.ts");
  const ok = formatSendResult("assistant", { message_id: 9, to_id: "mac-assistant", resolved_from: "assistant" });
  expect(ok.isError).toBe(false);
  expect(ok.text).toBe("Message sent to peer mac-assistant (nickname assistant). Message ID: 9.");
  const missed = formatSendResult("nobody", { message_id: 10, to_id: "nobody", wake: "no-route" });
  expect(missed.isError).toBe(true);
  expect(missed.text).toContain("Not delivered");
  expect(missed.text).toContain("nobody");
});
