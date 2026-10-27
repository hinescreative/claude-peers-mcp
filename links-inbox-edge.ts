#!/usr/bin/env bun
// Hosted inbox for the Links seat. Mailbox, broker ack, and doorbell are the butler-inbox ones.
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Mailbox, ringDoorbell } from "./butler-inbox-edge";

export const PEER_ID = "links-inbox";
export const SUMMARY = "Hosted inbox for the Links seat. Send link drops here as kind=notification; Links drains them when the doorbell rings.";
export { Mailbox, ringDoorbell };

const stamp = () => new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour12: true });
const log = (s: string) => console.log(`[${stamp()}] [links-inbox] ${s}`);
const BELL_EVERY = 300_000;
const PATH_HOOK = /^\/api\/hooks\/[A-Za-z0-9_.%-]+\/[A-Za-z0-9_.%-]+$/;
const RELAY_HOOK = /^https:\/\/relay\.t3\.codes\/v1\/hooks\/[A-Za-z0-9_.%:-]+(?:\/[A-Za-z0-9_.%:-]+)+$/;

// Path hooks reuse the Butler ringer. Absolute relay hooks are the current T3 webhook shape.
export async function ringLinksDoorbell(mail: Mailbox, state: string, now = Date.now(), post = fetch, report = log) {
  if (!mail.unread().length) return;
  if (now - Number(mail.get("bell.last_attempt") ?? 0) < BELL_EVERY) return;
  const file = join(state, "doorbell");
  let hook: string;
  try {
    if (statSync(file).mode & 0o077) throw new Error("unsafe permissions");
    hook = readFileSync(file, "utf8").trim();
  } catch (e: any) {
    if (now - Number(mail.get("bell.last_missing") ?? 0) >= BELL_EVERY) {
      report(e.code === "ENOENT" ? "no doorbell path" : "doorbell file unavailable or not mode 600");
      mail.set("bell.last_missing", String(now));
    }
    return;
  }
  if (PATH_HOOK.test(hook)) return ringDoorbell(mail, state, now, post, report);
  if (!RELAY_HOOK.test(hook)) {
    if (now - Number(mail.get("bell.last_missing") ?? 0) >= BELL_EVERY) {
      report("invalid doorbell target");
      mail.set("bell.last_missing", String(now));
    }
    return;
  }
  mail.set("bell.last_attempt", String(now));
  try {
    const res = await post(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"doorbell":true}',
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    report(res.ok ? `doorbell rang (${res.status})` : `doorbell failed (HTTP ${res.status})`);
  } catch {
    report("doorbell failed (network/timeout)");
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// Save first. A failed or short broker ack leaves the rows local so the next claim dedupes by id.
export async function storeClaimed(
  mail: Mailbox,
  messages: any[],
  ack: (ids: number[]) => Promise<{ acked: number }>,
) {
  mail.save(messages);
  const a = await ack(messages.map((m) => m.id));
  if (a.acked !== messages.length) throw new Error("broker ack incomplete; messages retained locally");
  return a.acked;
}

export async function start() {
  process.umask(0o077);
  const state = process.env.LINKS_INBOX_STATE ?? join(process.env.HOME!, ".local/state/links-inbox");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const mail = new Mailbox(join(state, "mailbox.sqlite"));
  const token = requireEnv("CLAUDE_PEERS_TOKEN");
  const brokerURL = requireEnv("CLAUDE_PEERS_BROKER_URL").replace(/\/$/, "");
  const host = requireEnv("LINKS_INBOX_HOST");
  const port = Number(requireEnv("LINKS_INBOX_PORT"));
  const machine = requireEnv("LINKS_INBOX_MACHINE");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("LINKS_INBOX_PORT is invalid");
  const instance = mail.get("instance") ?? crypto.randomUUID();
  mail.set("instance", instance);
  let lease = mail.get("lease");
  const credentials = () => ({ id: PEER_ID, instance_id: instance, lease_id: lease });
  async function broker(route: string, body: any) {
    const res = await fetch(brokerURL + route, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`broker ${route}: HTTP ${res.status}`);
    return res.json() as Promise<any>;
  }
  async function register() {
    const r = await broker("/register", {
      ...credentials(), requested_id: PEER_ID, payload_version: 2, nickname: "Links inbox",
      pid: process.pid, cwd: process.cwd(), git_root: null, tty: null, machine,
      tier: "infrastructure", summary: SUMMARY, runtime: "hosted",
    });
    if (r.id !== PEER_ID || r.role !== "owner" || !r.lease_id) throw new Error("broker did not grant the links-inbox lease");
    lease = r.lease_id;
    mail.set("lease", lease!);
  }
  async function collect() {
    const r = await broker("/claim-messages", credentials());
    const messages = r.messages ?? [];
    if (!messages.length) return;
    let peers: any[] = [];
    try { peers = await broker("/list-peers", { scope: "fleet", cwd: "/", git_root: null }); } catch { /* Keep mail even if the directory is unavailable. */ }
    const stamped = messages.map((m: any) => ({ ...m, machine: peers.find((p) => p.id === m.from_id)?.machine ?? "unknown" }));
    await storeClaimed(mail, stamped, (ids) => broker("/ack-messages", { ...credentials(), message_ids: ids }));
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
    await ringLinksDoorbell(mail, state);
  }
  await register();
  const tools = [
    { name: "check_messages", description: "Read durable unread Links mail without marking it read.", inputSchema: { type: "object", properties: {} } },
    { name: "ack_messages", description: "Acknowledge only after filing durably.", inputSchema: { type: "object", properties: { message_ids: { type: "array", items: { type: "integer", minimum: 1 } } }, required: ["message_ids"] } },
  ];
  function rpc(msg: any): any {
    const id = msg?.id ?? null;
    if (msg?.jsonrpc !== "2.0") return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
    const result = (r: any) => ({ jsonrpc: "2.0", id, result: r });
    if (msg.method === "initialize") return result({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "links-inbox-edge", version: "1.0.0" } });
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
    hostname: host,
    port,
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
  while (true) {
    await tick();
    await Bun.sleep(5_000);
  }
}

if (import.meta.main) start().catch(() => { log("fatal startup error (check broker access and lease state)"); process.exit(1); });
