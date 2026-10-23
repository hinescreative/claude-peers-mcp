#!/usr/bin/env bun
// A hosted claude-peers edge, like grok-edge.ts; no sender, agent, or second registry.
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const PEER_ID = "butler-inbox";
export const SUMMARY = "Hosted inbox for the 🎩 Butler (Wes's soft inbox). Send reports, progress and quick-save requests here; the Butler drains it when it wakes.";
const BELL_EVERY = 300_000;
const stamp = () => new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour12: true });
const log = (s: string) => console.log(`[${stamp()}] [butler-inbox] ${s}`);

export class Mailbox {
  db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA synchronous=FULL");
    this.db.run("CREATE TABLE IF NOT EXISTS mail (id INTEGER PRIMARY KEY, message TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0)");
    this.db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  get(key: string): string | undefined {
    return (this.db.query("SELECT value FROM meta WHERE key=?").get(key) as any)?.value;
  }
  set(key: string, value: string) {
    this.db.query("INSERT OR REPLACE INTO meta VALUES (?,?)").run(key, value);
  }
  save(messages: any[]) {
    this.db.transaction(() => {
      for (const m of messages) this.db.query("INSERT OR IGNORE INTO mail(id,message) VALUES (?,?)").run(m.id, JSON.stringify(m));
    })();
  }
  unread(): any[] {
    return this.db.query("SELECT message FROM mail WHERE acked=0 ORDER BY id").all().map((r: any) => JSON.parse(r.message));
  }
  ack(ids: number[]): number {
    return this.db.transaction(() => {
      let n = 0;
      for (const id of ids) n += this.db.query("UPDATE mail SET acked=1 WHERE id=? AND acked=0").run(id).changes;
      if (n && (this.db.query("SELECT count(*) AS n FROM mail WHERE acked=0").get() as any).n === 0) {
        // A new empty -> non-empty burst rings immediately, even inside the old cooldown.
        this.set("bell.last_attempt", "0");
        this.set("bell.last_missing", "0");
      }
      return n;
    })();
  }
}

// Persist the attempt time too: a failed HTTP request must not hammer T3.
export async function ringDoorbell(mail: Mailbox, state: string, now = Date.now(), post = fetch, report = log) {
  if (!mail.unread().length) return;
  if (now - Number(mail.get("bell.last_attempt") ?? 0) < BELL_EVERY) return;
  const path = join(state, "doorbell");
  let hook: string;
  try {
    if (statSync(path).mode & 0o077) throw new Error("unsafe permissions");
    hook = readFileSync(path, "utf8").trim();
  } catch (e: any) {
    // Log once per five-minute window; keep checking for a newly installed file.
    if (now - Number(mail.get("bell.last_missing") ?? 0) >= BELL_EVERY) {
      report(e.code === "ENOENT" ? "no doorbell path" : "doorbell file unavailable or not mode 600");
      mail.set("bell.last_missing", String(now));
    }
    return;
  }
  if (!/^\/api\/hooks\/[A-Za-z0-9_.%-]+\/[A-Za-z0-9_.%-]+$/.test(hook)) {
    report("invalid doorbell path");
    return;
  }
  mail.set("bell.last_attempt", String(now));
  try {
    const res = await post(`http://100.103.170.84:3773${hook}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: '{"doorbell":true}', redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    report(res.ok ? `doorbell rang (${res.status})` : `doorbell failed (HTTP ${res.status})`);
  } catch {
    report("doorbell failed (network/timeout)"); // Never log a URL containing the hook token.
  }
}

export async function start() {
  process.umask(0o077);
  const state = process.env.BUTLER_INBOX_STATE ?? join(process.env.HOME!, ".local/state/butler-inbox");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const mail = new Mailbox(join(state, "mailbox.sqlite"));
  const token = process.env.CLAUDE_PEERS_TOKEN;
  if (!token) throw new Error("CLAUDE_PEERS_TOKEN is required");
  const brokerURL = (process.env.CLAUDE_PEERS_BROKER_URL ?? "http://100.108.57.10:7899").replace(/\/$/, "");
  const instance = mail.get("instance") ?? crypto.randomUUID();
  mail.set("instance", instance);
  let lease = mail.get("lease");
  const credentials = () => ({ id: PEER_ID, instance_id: instance, lease_id: lease });
  async function broker(route: string, body: any) {
    const res = await fetch(brokerURL + route, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    if (!res.ok) throw new Error(`broker ${route}: HTTP ${res.status}`);
    return res.json() as Promise<any>;
  }
  async function register() {
    const r = await broker("/register", {
      ...credentials(), requested_id: PEER_ID, payload_version: 2, nickname: "Butler inbox",
      pid: process.pid, cwd: process.cwd(), git_root: null, tty: null, machine: "theoldone",
      tier: "infrastructure", summary: SUMMARY, runtime: "hosted",
    });
    if (r.id !== PEER_ID || r.role !== "owner" || !r.lease_id) throw new Error("broker did not grant the butler-inbox lease");
    lease = r.lease_id;
    mail.set("lease", lease!);
  }
  async function collect() {
    const r = await broker("/claim-messages", credentials());
    const messages = r.messages ?? [];
    if (!messages.length) return;
    let peers: any[] = [];
    try { peers = await broker("/list-peers", { scope: "fleet", cwd: "/", git_root: null }); } catch { /* Keep mail even if the directory is unavailable. */ }
    mail.save(messages.map((m: any) => ({ ...m, machine: peers.find(p => p.id === m.from_id)?.machine ?? "unknown" })));
    // Claim -> SQLite FULL commit -> broker ack. Reclaims and crash retries dedupe by broker id.
    const a = await broker("/ack-messages", { ...credentials(), message_ids: messages.map((m: any) => m.id) });
    if (a.acked !== messages.length) throw new Error("broker ack incomplete; messages retained locally");
    log(`stored ${messages.length} message(s); unread=${mail.unread().length}`);
  }
  async function tick() {
    try {
      try {
        const r = await broker("/heartbeat", credentials());
        if (!r.found) await register();
      } catch { await register(); }
      await collect();
    } catch (e: any) { log(e.message?.startsWith("broker ") ? e.message : "broker cycle failed"); }
    await ringDoorbell(mail, state);
  }
  await register();
  const tools = [
    { name: "check_messages", description: "Read durable unread Butler mail without marking it read.", inputSchema: { type: "object", properties: {} } },
    { name: "ack_messages", description: "Acknowledge only after filing durably.", inputSchema: { type: "object", properties: { message_ids: { type: "array", items: { type: "integer", minimum: 1 } } }, required: ["message_ids"] } },
  ];
  function rpc(msg: any): any {
    const id = msg?.id ?? null;
    if (msg?.jsonrpc !== "2.0") return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
    const result = (r: any) => ({ jsonrpc: "2.0", id, result: r });
    if (msg.method === "initialize") return result({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "butler-inbox-edge", version: "1.0.0" } });
    if (msg.method === "notifications/initialized") return null;
    if (msg.method === "ping") return result({});
    if (msg.method === "tools/list") return result({ tools });
    if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params ?? {};
      let out: any;
      if (name === "check_messages") out = { messages: mail.unread() };
      else if (name === "ack_messages" && Array.isArray(args?.message_ids) && args.message_ids.every((n: any) => Number.isSafeInteger(n) && n > 0)) {
        out = { ok: true, acked: mail.ack(args.message_ids) };
      } else return result({ isError: true, content: [{ type: "text", text: "unknown tool or invalid message_ids" }] });
      return result({ content: [{ type: "text", text: JSON.stringify(out) }] });
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  }
  const server = Bun.serve({
    hostname: process.env.BUTLER_INBOX_HOST ?? "100.108.57.10", port: Number(process.env.BUTLER_INBOX_PORT ?? 8794),
    async fetch(req) {
      if (req.headers.get("Authorization") !== `Bearer ${token}`) return Response.json({ error: "unauthorized" }, { status: 401 });
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/health") return Response.json({ status: "ok", peer_id: PEER_ID, unread: mail.unread().length });
      if (req.method !== "POST" || path !== "/mcp") return new Response("not found", { status: 404 });
      let msg: any;
      try { msg = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
      const r = rpc(msg);
      return r === null ? new Response(null, { status: 202 }) : Response.json(r);
    },
  });
  log(`listening ${server.hostname}:${server.port} as ${PEER_ID}`);
  // One loop prevents overlapping claims, heartbeats and doorbell POSTs.
  while (true) {
    await tick();
    await Bun.sleep(5_000);
  }
}

if (import.meta.main) start().catch(() => { log("fatal startup error (check broker access and lease state)"); process.exit(1); });
