import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Mailbox } from "./butler-inbox-edge";
import {
  BrokerError, brokerClient, configFromEnv, createHandler, createPeer, NonceStore, sign, type BrokerCall, type EdgeConfig,
} from "./duet-edge";

const SECRET = "fake".repeat(10);
const NOW = 1_800_000_000_000;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(import.meta.dir, prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const cfg = (over: Partial<EdgeConfig> = {}): EdgeConfig => ({
  peerId: "duet", nickname: "Claude Duet", machine: "duet", summary: "test", allowlist: ["alice-seat"],
  secret: SECRET, sendPerMinute: 20, ...over,
});

/** A broker stand-in that records calls. */
function fakeBroker(peers: any[] = []) {
  const calls: Array<{ route: string; body: any }> = [];
  let mail: any[] = [];
  let next = 100;
  const call: BrokerCall = async (route, body) => {
    calls.push({ route, body });
    if (route === "/register") return { id: body.requested_id, role: "owner", lease_id: "lease-1" };
    if (route === "/heartbeat") return { ok: true, found: true };
    if (route === "/list-peers") return peers;
    if (route === "/claim-messages") { const m = mail; mail = []; return { messages: m }; }
    if (route === "/ack-messages") return { acked: body.message_ids.length };
    if (route === "/capabilities") return { message_contract: 1 };
    if (route === "/send-message") return { ok: true, message_id: next++, to_id: body.to_id };
    throw new BrokerError(404, `broker ${route}: not found`);
  };
  return { call, calls, deliver: (m: any[]) => { mail.push(...m); } };
}

function setup(over: Partial<EdgeConfig> = {}, peers: any[] = []) {
  const dir = tempDir(".duet-test-");
  const mail = new Mailbox(join(dir, "mail.sqlite"));
  cleanups.push(() => mail.db.close());
  const nonces = new NonceStore(mail.db);
  const broker = fakeBroker(peers);
  const config = cfg(over);
  const peer = createPeer(mail, broker.call, config);
  let clock = NOW;
  const handle = createHandler({ mail, nonces, call: broker.call, peer, cfg: config, now: () => clock });
  let n = 0;
  const signed = (path: string, body: unknown, opts: { secret?: string; ts?: number; nonce?: string; sigPath?: string } = {}) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor((opts.ts ?? clock) / 1000));
    const nonce = opts.nonce ?? `nonce-${String(++n).padStart(12, "0")}`;
    return new Request(`http://127.0.0.1:8804${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "X-Duet-Ts": ts, "X-Duet-Nonce": nonce,
        "X-Duet-Sig": sign(opts.secret ?? SECRET, "POST", opts.sigPath ?? path, ts, nonce, raw),
      },
      body: raw,
    });
  };
  return { dir, mail, broker, peer, handle, signed, tick: (ms: number) => { clock += ms; } };
}

test("signature: only a fresh, correctly signed request for this path is accepted", async () => {
  const e = setup();
  expect((await e.handle(e.signed("/v1/inbox", {}))).status).toBe(200);
  expect((await e.handle(e.signed("/v1/inbox", {}, { secret: "nope".repeat(10) }))).status).toBe(401);
  expect((await e.handle(e.signed("/v1/inbox", {}, { ts: NOW - 61_000 }))).status).toBe(401);
  expect((await e.handle(e.signed("/v1/inbox", {}, { ts: NOW + 61_000 }))).status).toBe(401);
  // A signature for one route does not open another.
  expect((await e.handle(e.signed("/v1/ack", { message_ids: [1] }, { sigPath: "/v1/inbox" }))).status).toBe(401);
  // A changed body fails.
  const req = e.signed("/v1/ack", { message_ids: [1] });
  const tampered = new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify({ message_ids: [2] }) });
  expect((await e.handle(tampered)).status).toBe(401);
  // Unsigned and bearer-only requests fail.
  expect((await e.handle(new Request("http://127.0.0.1:8804/v1/inbox", { method: "POST", body: "{}" }))).status).toBe(401);
  expect((await e.handle(new Request("http://127.0.0.1:8804/v1/inbox", { method: "POST", headers: { Authorization: `Bearer ${SECRET}` }, body: "{}" }))).status).toBe(401);
});

test("signature: a nonce works once, and the record survives a restart", async () => {
  const e = setup();
  expect((await e.handle(e.signed("/v1/inbox", {}, { nonce: "replay-nonce-000001" }))).status).toBe(200);
  expect((await e.handle(e.signed("/v1/inbox", {}, { nonce: "replay-nonce-000001" }))).status).toBe(401);
  const again = new Mailbox(join(e.dir, "mail.sqlite"));
  cleanups.push(() => again.db.close());
  expect(new NonceStore(again.db).use("replay-nonce-000001", 1)).toBe(false);
  // Purging removes only expired nonces.
  const store = new NonceStore(again.db);
  store.purge(NOW / 1000 + 10_000);
  expect(store.use("replay-nonce-000001", 1)).toBe(true);
});

test("routes: health says only ok, unknown paths 404, GET on a route 405, big bodies 413", async () => {
  const e = setup();
  const health = await e.handle(new Request("http://127.0.0.1:8804/health"));
  expect(await health.json()).toEqual({ status: "ok" });
  expect((await e.handle(new Request("http://127.0.0.1:8804/mcp", { method: "POST", body: "{}" }))).status).toBe(404);
  expect((await e.handle(new Request("http://127.0.0.1:8804/v1/inbox"))).status).toBe(405);
  const big = e.signed("/v1/send", { to_id: "alice-seat", message: "x".repeat(70_000) });
  expect((await e.handle(big)).status).toBe(413);
});

test("send: pinned sender with lease, allowlist enforced, empty allowlist sends nothing", async () => {
  const e = setup();
  await e.peer.register();
  const ok = await (await e.handle(e.signed("/v1/send", { to_id: "alice-seat", message: "hello", kind: "notification" }))).json() as any;
  expect(ok.ok).toBe(true);
  expect(ok.message_id).toBe(100);
  const sent = e.broker.calls.find(c => c.route === "/send-message")!.body;
  expect(sent).toMatchObject({ from_id: "duet", to_id: "alice-seat", text: "hello", kind: "notification", lease_id: "lease-1" });
  expect(typeof sent.instance_id).toBe("string");
  // A from_id in the request cannot change the sender.
  await e.handle(e.signed("/v1/send", { to_id: "alice-seat", message: "x", from_id: "someone-else" }));
  expect(e.broker.calls.filter(c => c.route === "/send-message").every(c => c.body.from_id === "duet")).toBe(true);

  const off = await (await e.handle(e.signed("/v1/send", { to_id: "bob-seat", message: "hi" }))).json() as any;
  expect(off).toEqual({ ok: false, error: "bob-seat is not on this edge's recipient allowlist" });
  const bad = await (await e.handle(e.signed("/v1/send", { to_id: "../broker", message: "hi" }))).json() as any;
  expect(bad.ok).toBe(false);

  const closed = setup({ allowlist: [] });
  const none = await (await closed.handle(closed.signed("/v1/send", { to_id: "alice-seat", message: "hi" }))).json() as any;
  expect(none).toEqual({ ok: false, error: "sending is off: this edge has no recipient allowlist" });
  expect(closed.broker.calls.some(c => c.route === "/send-message")).toBe(false);
});

test("send: rate limit per minute", async () => {
  const e = setup({ sendPerMinute: 2 });
  await e.peer.register();
  for (let i = 0; i < 2; i++) expect(((await (await e.handle(e.signed("/v1/send", { to_id: "alice-seat", message: `m${i}` }))).json()) as any).ok).toBe(true);
  const third = await (await e.handle(e.signed("/v1/send", { to_id: "alice-seat", message: "m3" }))).json() as any;
  expect(third.error).toContain("too many sends");
  e.tick(60_000);
  expect(((await (await e.handle(e.signed("/v1/send", { to_id: "alice-seat", message: "m4" }))).json()) as any).ok).toBe(true);
});

test("inbox and ack: collected mail is durable, paged, and acked only by id", async () => {
  const e = setup({}, [{ id: "alice-seat", machine: "mac" }]);
  await e.peer.register();
  e.broker.deliver([
    { id: 7, from_id: "alice-seat", to_id: "duet", text: "please check X", kind: "request", reply_to_id: null, sent_at: "2026-11-24T10:00:00Z" },
    { id: 8, from_id: "alice-seat", to_id: "duet", text: "fyi", kind: "notification", reply_to_id: null, sent_at: "2026-11-24T10:01:00Z" },
  ]);
  expect(await e.peer.collect()).toBe(2);
  const ackCall = e.broker.calls.find(c => c.route === "/ack-messages")!;
  expect(ackCall.body.message_ids).toEqual([7, 8]);
  const inbox = await (await e.handle(e.signed("/v1/inbox", {}))).json() as any;
  expect(inbox.unread).toBe(2);
  expect(inbox.messages[0]).toEqual({ id: 7, from_id: "alice-seat", from_machine: "mac", kind: "request", reply_to_id: null, sent_at: "2026-11-24T10:00:00Z", text: "please check X" });
  // Reading does not mark read.
  expect(((await (await e.handle(e.signed("/v1/inbox", {}))).json()) as any).unread).toBe(2);
  const acked = await (await e.handle(e.signed("/v1/ack", { message_ids: [7, 7, 99] }))).json() as any;
  expect(acked).toEqual({ ok: true, acked: 1, unread: 1 });
  expect(((await (await e.handle(e.signed("/v1/ack", { message_ids: [] }))).json()) as any).ok).toBe(false);
  expect(((await (await e.handle(e.signed("/v1/ack", { message_ids: ["7"] }))).json()) as any).ok).toBe(false);

  const many = Array.from({ length: 60 }, (_, i) => ({ id: 200 + i, from_id: "alice-seat", text: `m${i}`, kind: "notification" }));
  e.mail.save(many);
  const paged = await (await e.handle(e.signed("/v1/inbox", {}))).json() as any;
  expect(paged.messages.length).toBe(50);
  expect(paged.more).toBe(11);
});

test("peers: self excluded, allowlisted first, filters and clipped summaries", async () => {
  const e = setup({}, [
    { id: "duet", nickname: "Claude Duet", machine: "duet" },
    { id: "zed-seat", nickname: "Zed", machine: "pc", summary: "s".repeat(400), last_seen: new Date(NOW - 5_000).toISOString() },
    { id: "alice-seat", nickname: "Alice", machine: "mac", summary: "builds sites" },
  ]);
  const r = await (await e.handle(e.signed("/v1/peers", {}))).json() as any;
  expect(r.peers.map((p: any) => p.id)).toEqual(["alice-seat", "zed-seat"]);
  expect(r.peers[0].can_send).toBe(true);
  expect(r.peers[1].summary.length).toBe(160);
  expect(r.peers[1].age_s).toBe(5);
  const q = await (await e.handle(e.signed("/v1/peers", { q: "SITES" }))).json() as any;
  expect(q.peers.map((p: any) => p.id)).toEqual(["alice-seat"]);
  await e.handle(e.signed("/v1/peers", { machine: "pc" }));
  expect(e.broker.calls.at(-1)!.body).toMatchObject({ scope: "machine", machine: "pc", exclude_id: "duet" });
  expect(((await (await e.handle(e.signed("/v1/peers", { limit: 0 }))).json()) as any).ok).toBe(false);
});

test("broker failures: 4xx text is passed on, an outage is a plain 502", async () => {
  const dir = tempDir(".duet-test-");
  const mail = new Mailbox(join(dir, "mail.sqlite"));
  cleanups.push(() => mail.db.close());
  let mode: "4xx" | "down" = "4xx";
  const call: BrokerCall = async (route) => {
    if (route === "/register") return { id: "duet", role: "owner", lease_id: "l" };
    if (mode === "down") throw new BrokerError(0, "broker /list-peers: unreachable");
    throw new BrokerError(400, "broker /send-message: reply must reverse the participants of an existing request");
  };
  const config = cfg();
  const peer = createPeer(mail, call, config);
  const handle = createHandler({ mail, nonces: new NonceStore(mail.db), call, peer, cfg: config, now: () => NOW });
  const req = (path: string, body: unknown, nonce: string) => {
    const raw = JSON.stringify(body);
    const ts = String(NOW / 1000);
    return new Request(`http://x${path}`, { method: "POST", headers: { "X-Duet-Ts": ts, "X-Duet-Nonce": nonce, "X-Duet-Sig": sign(SECRET, "POST", path, ts, nonce, raw) }, body: raw });
  };
  const r = await handle(req("/v1/send", { to_id: "alice-seat", message: "x", kind: "reply", reply_to_id: 3 }, "nonce-aaaaaaaaaaaaaa"));
  expect(await r.json()).toEqual({ ok: false, error: "broker /send-message: reply must reverse the participants of an existing request" });
  mode = "down";
  const down = await handle(req("/v1/peers", {}, "nonce-bbbbbbbbbbbbbb"));
  expect(down.status).toBe(502);
  expect(await down.json()).toEqual({ ok: false, error: "the peers broker is unavailable right now" });
});

test("config: required values, secret length, allowlist ids", () => {
  const base = { CLAUDE_PEERS_BROKER_URL: "http://127.0.0.1:1", CLAUDE_PEERS_TOKEN: "t", DUET_EDGE_SECRET: SECRET, HOME: "/tmp/h" };
  const c = configFromEnv({ ...base, DUET_PEER_ALLOWLIST: " a-seat, b_seat ,," });
  expect(c).toMatchObject({ peerId: "duet", host: "127.0.0.1", port: 8804, allowlist: ["a-seat", "b_seat"], state: "/tmp/h/.local/state/duet-edge" });
  expect(() => configFromEnv({ ...base, CLAUDE_PEERS_BROKER_URL: "" })).toThrow("CLAUDE_PEERS_BROKER_URL is required");
  expect(() => configFromEnv({ ...base, DUET_EDGE_SECRET: "short" })).toThrow("at least 32");
  expect(() => configFromEnv({ ...base, DUET_PEER_ALLOWLIST: "ok-seat,bad id" })).toThrow("not a peer id");
  expect(() => configFromEnv({ ...base, DUET_PEER_ID: "x" })).toThrow("DUET_PEER_ID");
});

// ---------- Against a real broker ----------

async function startBroker(tokensFile: string, dir: string) {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  const proc = Bun.spawn(["bun", "broker.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_CODE_MESSAGING_SOCKET: "",
      CLAUDE_CODE_MESSAGING_TOKEN: "",
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: `${dir}/broker.db`,
      CLAUDE_PEERS_TOKEN: "",
      CLAUDE_PEERS_TOKENS: "",
      CLAUDE_PEERS_TOKENS_FILE: tokensFile,
      CLAUDE_PEERS_REQUIRE_AUTH: "1",
      LEAD_WAKE_URL: "",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  cleanups.push(async () => { proc.kill(); await proc.exited; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return { base, proc }; } catch { /* starting */ }
    await Bun.sleep(25);
  }
  throw new Error("isolated broker did not start");
}

test("end to end: the edge's own token, mail in and out, and revoking that token", async () => {
  const dir = tempDir(".duet-e2e-");
  const tokens = join(dir, "tokens");
  writeFileSync(tokens, "fake-fleet-token\nfake-duet-token\n", { mode: 0o600 });
  const { base, proc } = await startBroker(tokens, dir);
  const fleet = brokerClient(base, "fake-fleet-token");
  const duetCall = brokerClient(base, "fake-duet-token");

  // A plain seat on the fleet token.
  await fleet("/register", { requested_id: "alice-seat", pid: 4242, cwd: "/work", git_root: null, tty: null, machine: "mac", summary: "Alice" });

  const mail = new Mailbox(join(dir, "mail.sqlite"));
  cleanups.push(() => mail.db.close());
  const config = cfg();
  const peer = createPeer(mail, duetCall, config);
  await peer.register();
  const handle = createHandler({ mail, nonces: new NonceStore(mail.db), call: duetCall, peer, cfg: config });
  let n = 0;
  const signed = (path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = `e2e-nonce-${String(++n).padStart(8, "0")}`;
    return new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "X-Duet-Ts": ts, "X-Duet-Nonce": nonce, "X-Duet-Sig": sign(SECRET, "POST", path, ts, nonce, raw) }, body: raw });
  };

  const peers = await (await handle(signed("/v1/peers", {}))).json() as any;
  expect(peers.peers.map((p: any) => p.id)).toContain("alice-seat");
  expect(peers.peers.map((p: any) => p.id)).not.toContain("duet");

  // Alice asks; the edge stores it durably and acks it at the broker.
  const asked = await fleet("/send-message", { from_id: "alice-seat", to_id: "duet", text: "status of the site?" });
  await peer.tick();
  const inbox = await (await handle(signed("/v1/inbox", {}))).json() as any;
  expect(inbox.messages).toMatchObject([{ id: asked.message_id, from_id: "alice-seat", from_machine: "mac", kind: "request", text: "status of the site?" }]);

  // Duet replies to the request it got; the broker checks participants and the lease.
  const reply = await (await handle(signed("/v1/send", { to_id: "alice-seat", message: "on it", reply_to_id: asked.message_id }))).json() as any;
  expect(reply.ok).toBe(true);
  const got = await fleet("/poll-messages", { id: "alice-seat" });
  expect(got.messages).toMatchObject([{ from_id: "duet", text: "on it", kind: "reply", reply_to_id: asked.message_id }]);
  expect(((await (await handle(signed("/v1/ack", { message_ids: [asked.message_id] }))).json()) as any).acked).toBe(1);

  // Removing the edge's line from the tokens file cuts only the edge off.
  writeFileSync(tokens, "fake-fleet-token\n", { mode: 0o600 });
  proc.kill("SIGHUP");
  let refused = false;
  for (let i = 0; i < 80 && !refused; i++) {
    try { await duetCall("/capabilities", {}); await Bun.sleep(100); } catch (e) { refused = e instanceof BrokerError && e.status === 401; }
  }
  expect(refused).toBe(true);
  expect((await fleet("/capabilities", {})).message_contract).toBe(1);
}, 30_000);
