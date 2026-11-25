#!/usr/bin/env bun
/**
 * A hosted claude-peers edge for Claude Duet, like butler-inbox-edge.ts.
 *
 * Claude Duet reaches it through an OAuth connector Worker. The Worker signs every
 * call with a shared secret, and this edge accepts nothing else. It listens on
 * loopback; a Cloudflare Tunnel carries the Worker's calls to it. The broker
 * itself is never exposed.
 *
 * It holds one leased peer id (default "duet") with its own broker token, keeps
 * the peer's mail in a durable SQLite mailbox, and offers four calls:
 * peers, send, inbox, ack. There is no shell, file, register or settings call.
 * Sends go only to ids on DUET_PEER_ALLOWLIST; an empty list sends nothing.
 * There is no doorbell: mail waits in the mailbox until Claude Duet reads it.
 *
 * Env:
 *   CLAUDE_PEERS_BROKER_URL  broker base URL (required)
 *   CLAUDE_PEERS_TOKEN       this edge's own broker bearer (required; one line of the broker's tokens file)
 *   DUET_EDGE_SECRET         HMAC key shared with the connector Worker (required, 32+ chars)
 *   DUET_PEER_ALLOWLIST      comma-separated peer ids this edge may send to (empty = no sends)
 *   DUET_PEER_ID             default duet
 *   DUET_PEER_NICKNAME       default Claude Duet
 *   DUET_PEER_MACHINE        default duet
 *   DUET_PEER_SUMMARY        optional register summary override
 *   DUET_EDGE_HOST           default 127.0.0.1
 *   DUET_EDGE_PORT           default 8804
 *   DUET_EDGE_STATE          default ~/.local/state/duet-edge
 *   DUET_SEND_PER_MINUTE     default 20
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { Mailbox } from "./butler-inbox-edge.ts";
import { formatSendResult, sendPeerMessage } from "./shared/message-contract.ts";

export const PEER_ID_RE = /^[a-zA-Z0-9_-]{3,64}$/;
export const SKEW_SECONDS = 60;
export const MAX_BODY = 64 * 1024;
export const MAX_MESSAGE = 16_000;
export const INBOX_PAGE = 50;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SIG_RE = /^v1=[0-9a-f]{64}$/;
const ROUTES = new Set(["/v1/peers", "/v1/send", "/v1/inbox", "/v1/ack"]);
const stamp = () => new Date().toISOString();
const log = (s: string) => console.log(`[${stamp()}] [duet-edge] ${s}`);

export type BrokerCall = (route: string, body: any) => Promise<any>;

export interface EdgeConfig {
  peerId: string;
  nickname: string;
  machine: string;
  summary: string;
  allowlist: string[];
  secret: string;
  sendPerMinute: number;
}

/** Thrown by the broker client. `status` is the broker's HTTP status, or 0 when it could not be reached. */
export class BrokerError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---------- Request signing (the Worker computes the same string) ----------

export function bodyHash(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** v1 signing string: version, method, path, unix seconds, nonce, sha256 of the raw body. */
export function signingString(method: string, path: string, ts: string, nonce: string, body: Uint8Array | string): string {
  return ["v1", method.toUpperCase(), path, ts, nonce, bodyHash(body)].join("\n");
}

export function sign(secret: string, method: string, path: string, ts: string, nonce: string, body: Uint8Array | string): string {
  return "v1=" + createHmac("sha256", secret).update(signingString(method, path, ts, nonce, body)).digest("hex");
}

function sameString(a: string, b: string): boolean {
  const ea = Buffer.from(a);
  const eb = Buffer.from(b);
  return ea.length === eb.length && timingSafeEqual(ea, eb);
}

/** Checks the signature headers. Returns the nonce and its expiry, or null. Does not record the nonce. */
export function checkSignature(
  secret: string,
  method: string,
  path: string,
  headers: Headers,
  body: Uint8Array,
  nowMs: number,
): { nonce: string; expires: number } | null {
  const ts = headers.get("x-duet-ts") ?? "";
  const nonce = headers.get("x-duet-nonce") ?? "";
  const sig = headers.get("x-duet-sig") ?? "";
  if (!/^\d{1,12}$/.test(ts) || !NONCE_RE.test(nonce) || !SIG_RE.test(sig)) return null;
  const t = Number(ts);
  if (Math.abs(nowMs / 1000 - t) > SKEW_SECONDS) return null;
  if (!sameString(sig, sign(secret, method, path, ts, nonce, body))) return null;
  return { nonce, expires: t + SKEW_SECONDS * 2 };
}

/** Seen nonces, kept in the mailbox database so a restart does not reopen the replay window. */
export class NonceStore {
  constructor(private db: Database) {
    db.run("CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL)");
  }
  /** Records a nonce. False if it was already used. */
  use(nonce: string, expires: number): boolean {
    return this.db.query("INSERT OR IGNORE INTO nonces VALUES (?,?)").run(nonce, expires).changes === 1;
  }
  purge(nowSeconds: number) {
    this.db.query("DELETE FROM nonces WHERE expires < ?").run(Math.floor(nowSeconds));
  }
}

// ---------- The leased peer ----------

export function createPeer(mail: Mailbox, call: BrokerCall, cfg: Pick<EdgeConfig, "peerId" | "nickname" | "machine" | "summary">) {
  const instance = mail.get("instance") ?? crypto.randomUUID();
  mail.set("instance", instance);
  let lease = mail.get("lease");
  const credentials = () => ({ instance_id: instance, lease_id: lease });
  async function register() {
    const r = await call("/register", {
      id: cfg.peerId, ...credentials(), requested_id: cfg.peerId, payload_version: 2, nickname: cfg.nickname,
      pid: process.pid, cwd: "/", git_root: null, tty: null, machine: cfg.machine,
      tier: "infrastructure", summary: cfg.summary, runtime: "hosted",
    });
    if (r.id !== cfg.peerId || r.role !== "owner" || !r.lease_id) throw new BrokerError(0, `broker did not grant the ${cfg.peerId} lease`);
    lease = r.lease_id;
    mail.set("lease", lease!);
  }
  async function collect() {
    const r = await call("/claim-messages", { id: cfg.peerId, ...credentials() });
    const messages = r.messages ?? [];
    if (!messages.length) return 0;
    let peers: any[] = [];
    try { peers = await call("/list-peers", { scope: "fleet", cwd: "/", git_root: null }); } catch { /* Keep mail even if the directory is unavailable. */ }
    mail.save(messages.map((m: any) => ({ ...m, machine: peers.find(p => p.id === m.from_id)?.machine ?? "unknown" })));
    // Claim -> SQLite FULL commit -> broker ack. Reclaims and crash retries dedupe by broker id.
    const a = await call("/ack-messages", { id: cfg.peerId, ...credentials(), message_ids: messages.map((m: any) => m.id) });
    if (a.acked !== messages.length) throw new BrokerError(0, "broker ack incomplete; messages retained locally");
    return messages.length;
  }
  async function tick() {
    try {
      try {
        const r = await call("/heartbeat", { id: cfg.peerId, ...credentials() });
        if (!r.found) await register();
      } catch { await register(); }
      const n = await collect();
      if (n) log(`stored ${n} message(s); unread=${mail.unread().length}`);
    } catch (e: any) {
      log(e instanceof BrokerError ? e.message : "broker cycle failed");
    }
  }
  return { credentials, register, collect, tick };
}

// ---------- The HTTP face ----------

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const fail = (error: string) => json({ ok: false, error });

function clip(s: unknown, max: number): string {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 1) + "…";
}

function ageSeconds(iso: unknown, nowMs: number): number | null {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 1000)) : null;
}

export interface HandlerDeps {
  mail: Mailbox;
  nonces: NonceStore;
  call: BrokerCall;
  peer: ReturnType<typeof createPeer>;
  cfg: EdgeConfig;
  now?: () => number;
}

export function createHandler(deps: HandlerDeps) {
  const { mail, nonces, call, peer, cfg } = deps;
  const now = deps.now ?? Date.now;
  const allow = new Set(cfg.allowlist);
  let sendWindow = { start: 0, count: 0 };

  async function peers(a: any) {
    if ((a.q !== undefined && typeof a.q !== "string") || (a.machine !== undefined && typeof a.machine !== "string")) return fail("q and machine must be strings");
    if (a.limit !== undefined && !(Number.isSafeInteger(a.limit) && a.limit >= 1 && a.limit <= 100)) return fail("limit must be 1 to 100");
    const q = (a.q ?? "").trim().toLowerCase();
    const machine = (a.machine ?? "").trim();
    const list = await call("/list-peers", {
      scope: machine ? "machine" : "fleet", machine: machine || undefined,
      cwd: "/", git_root: null, exclude_id: cfg.peerId, active_only: true,
    });
    const t = now();
    let rows = (Array.isArray(list) ? list : []).filter((p: any) => p && p.id !== cfg.peerId).map((p: any) => ({
      id: String(p.id),
      nickname: clip(p.nickname, 64),
      machine: clip(p.machine, 64),
      summary: clip(p.summary, 160),
      age_s: ageSeconds(p.last_seen, t),
      can_send: allow.has(String(p.id)),
    }));
    if (q) rows = rows.filter(p => `${p.id} ${p.nickname} ${p.machine} ${p.summary}`.toLowerCase().includes(q));
    rows.sort((x, y) => Number(y.can_send) - Number(x.can_send) || (x.nickname || x.id).localeCompare(y.nickname || y.id));
    const limit = a.limit ?? 40;
    return json({ ok: true, self: { id: cfg.peerId, nickname: cfg.nickname }, total: rows.length, peers: rows.slice(0, limit), allowlist: cfg.allowlist });
  }

  async function send(a: any) {
    const to = typeof a.to_id === "string" ? a.to_id.trim() : "";
    const text = typeof a.message === "string" ? a.message : "";
    if (!PEER_ID_RE.test(to)) return fail("to_id must be a peer id ([a-zA-Z0-9_-]{3,64})");
    if (!text.trim()) return fail("message is empty");
    if (text.length > MAX_MESSAGE) return fail(`message is longer than ${MAX_MESSAGE} characters`);
    if (!allow.size) return fail("sending is off: this edge has no recipient allowlist");
    if (!allow.has(to)) return fail(`${to} is not on this edge's recipient allowlist`);
    if (a.kind !== undefined && !["request", "reply", "notification"].includes(a.kind)) return fail("kind must be request, reply or notification");
    if (a.reply_to_id !== undefined && !(Number.isSafeInteger(a.reply_to_id) && a.reply_to_id > 0)) return fail("reply_to_id must be a positive integer");
    if (a.client_message_id !== undefined && !(typeof a.client_message_id === "string" && a.client_message_id.trim() && a.client_message_id.length <= 128)) return fail("client_message_id must be 1 to 128 characters");
    const t = now();
    if (t - sendWindow.start >= 60_000) sendWindow = { start: t, count: 0 };
    if (sendWindow.count >= cfg.sendPerMinute) return fail("too many sends this minute; try again shortly");
    sendWindow.count++;
    const metadata = Object.fromEntries(["kind", "reply_to_id", "client_message_id"].filter(k => a[k] !== undefined).map(k => [k, a[k]]));
    let sent: any;
    try {
      sent = await sendPeerMessage(call, { from_id: cfg.peerId, ...peer.credentials(), to_id: to, text } as any, metadata);
    } catch (e) {
      if (e instanceof BrokerError && e.status === 409 && /lease/i.test(e.message)) return fail("this edge is re-registering with the broker; try again in a few seconds");
      throw e;
    }
    if (!sent?.ok) return fail(sent?.error ?? "send failed");
    const out = formatSendResult(to, sent);
    log(`sent message ${sent.message_id ?? "?"}`);
    return json({ ok: true, message_id: sent.message_id ?? null, duplicate: Boolean(sent.duplicate), text: out.text, is_error: out.isError });
  }

  function inbox() {
    const all = mail.unread();
    const page = all.slice(0, INBOX_PAGE).map((m: any) => ({
      id: m.id, from_id: m.from_id, from_machine: m.machine ?? "unknown", kind: m.kind ?? "request",
      reply_to_id: m.reply_to_id ?? null, sent_at: m.sent_at ?? null, text: m.text,
    }));
    return json({ ok: true, unread: all.length, more: Math.max(0, all.length - page.length), messages: page });
  }

  function ack(a: any) {
    const ids = a.message_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every((n: any) => Number.isSafeInteger(n) && n > 0)) {
      return fail("message_ids must be 1 to 200 positive integers");
    }
    return json({ ok: true, acked: mail.ack(ids), unread: mail.unread().length });
  }

  return async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/health") return json({ status: "ok" });
    if (!ROUTES.has(path)) return json({ error: "not found" }, 404);
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return json({ error: "body too large" }, 413);
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength > MAX_BODY) return json({ error: "body too large" }, 413);
    const signed = checkSignature(cfg.secret, req.method, path, req.headers, body, now());
    // Record the nonce only after the signature checks, so unsigned noise cannot fill the table.
    if (!signed || !nonces.use(signed.nonce, signed.expires)) return json({ error: "unauthorized" }, 401);
    let args: any;
    try { args = body.byteLength ? JSON.parse(new TextDecoder().decode(body)) : {}; } catch { return json({ error: "invalid JSON" }, 400); }
    if (!args || typeof args !== "object" || Array.isArray(args)) return json({ error: "body must be a JSON object" }, 400);
    try {
      if (path === "/v1/peers") return await peers(args);
      if (path === "/v1/send") return await send(args);
      if (path === "/v1/inbox") return inbox();
      return ack(args);
    } catch (e) {
      if (e instanceof BrokerError && e.status >= 400 && e.status < 500) return fail(e.message);
      log(`${path} failed: broker unavailable`);
      return json({ ok: false, error: "the peers broker is unavailable right now" }, 502);
    }
  };
}

// ---------- Startup ----------

export function brokerClient(base: string, token: string, fetchImpl: typeof fetch = fetch): BrokerCall {
  const url = base.replace(/\/+$/, "");
  return async (route, body) => {
    let res: Response;
    try {
      res = await fetchImpl(url + route, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error",
      });
    } catch {
      throw new BrokerError(0, `broker ${route}: unreachable`);
    }
    const text = await res.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* Not JSON: report the status only. */ }
    if (!res.ok) throw new BrokerError(res.status, `broker ${route}: ${typeof data.error === "string" ? clip(data.error, 200) : `HTTP ${res.status}`}`);
    return data;
  };
}

export function configFromEnv(env: Record<string, string | undefined>): EdgeConfig & { broker: string; token: string; host: string; port: number; state: string } {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const broker = need("CLAUDE_PEERS_BROKER_URL");
  const token = need("CLAUDE_PEERS_TOKEN");
  const secret = need("DUET_EDGE_SECRET");
  if (secret.length < 32) throw new Error("DUET_EDGE_SECRET must be at least 32 characters");
  const peerId = env.DUET_PEER_ID?.trim() || "duet";
  if (!PEER_ID_RE.test(peerId)) throw new Error("DUET_PEER_ID must match [a-zA-Z0-9_-]{3,64}");
  const allowlist = (env.DUET_PEER_ALLOWLIST ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const bad = allowlist.filter(id => !PEER_ID_RE.test(id));
  if (bad.length) throw new Error("DUET_PEER_ALLOWLIST holds an entry that is not a peer id");
  const nickname = env.DUET_PEER_NICKNAME?.trim() || "Claude Duet";
  const sendPerMinute = Number(env.DUET_SEND_PER_MINUTE ?? 20);
  if (!Number.isSafeInteger(sendPerMinute) || sendPerMinute < 1) throw new Error("DUET_SEND_PER_MINUTE must be a positive integer");
  return {
    broker, token, secret, peerId, nickname, allowlist, sendPerMinute,
    machine: env.DUET_PEER_MACHINE?.trim() || "duet",
    summary: env.DUET_PEER_SUMMARY?.trim()
      || `${nickname}, the person's chief of staff app. Mail waits in its inbox until it next checks, so a reply is not instant.`,
    host: env.DUET_EDGE_HOST?.trim() || "127.0.0.1",
    port: Number(env.DUET_EDGE_PORT ?? 8804),
    state: env.DUET_EDGE_STATE?.trim() || join(env.HOME ?? ".", ".local/state/duet-edge"),
  };
}

export async function start() {
  process.umask(0o077);
  const cfg = configFromEnv(process.env);
  mkdirSync(cfg.state, { recursive: true, mode: 0o700 });
  const mail = new Mailbox(join(cfg.state, "mailbox.sqlite"));
  const nonces = new NonceStore(mail.db);
  const call = brokerClient(cfg.broker, cfg.token);
  const peer = createPeer(mail, call, cfg);
  await peer.register();
  const handle = createHandler({ mail, nonces, call, peer, cfg });
  const server = Bun.serve({ hostname: cfg.host, port: cfg.port, fetch: handle });
  log(`listening ${server.hostname}:${server.port} as ${cfg.peerId}; ${cfg.allowlist.length} allowed recipient(s)`);
  // One loop prevents overlapping claims and heartbeats.
  while (true) {
    await peer.tick();
    nonces.purge(Date.now() / 1000);
    await Bun.sleep(5_000);
  }
}

if (import.meta.main) start().catch((e) => { log(`fatal: ${e instanceof BrokerError || /required|must/.test(String(e?.message)) ? e.message : "startup error (check broker access and lease state)"}`); process.exit(1); });
