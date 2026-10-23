#!/usr/bin/env bun
// Always-on peers edge. A Grok Bot or hosted edge sends here when a Mac lead
// is off peers. This starts that lead's T3 thread with the message.
import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchToThread, readShell } from "./dispatch.mjs";
import { loadRoutes, parseWakeText, planWake } from "./protocol.mjs";

export const PEER_ID = "lead-wake";
const SUMMARY = "Wakes a sleeping Mac T3 lead. Send a message whose first line is `to: <peer-id>` and whose body is the text the lead should see. Or POST /wake.";
const stamp = () => new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour12: true });
const log = (line: string) => console.log(`[${stamp()}] [lead-wake] ${line}`);

function authorized(header: string | null, token: string) {
  const got = Buffer.from(header ?? "");
  const expect = Buffer.from(`Bearer ${token}`);
  return got.length === expect.length && timingSafeEqual(got, expect);
}

function loadAuth(path: string) {
  const auth = JSON.parse(readFileSync(path, "utf8"));
  if (!auth.baseUrl || !auth.token || !auth.environmentId) throw Error("Mac T3 credential file is incomplete");
  return { baseUrl: auth.baseUrl, token: auth.token, environmentId: auth.environmentId };
}

class Seen {
  db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, result TEXT NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  get(key: string): string | undefined {
    return (this.db.query("SELECT value FROM meta WHERE key=?").get(key) as { value?: string } | null)?.value;
  }
  set(key: string, value: string) {
    this.db.query("INSERT OR REPLACE INTO meta VALUES (?,?)").run(key, value);
  }
  recall(key: string) {
    const row = this.db.query("SELECT result FROM seen WHERE key=?").get(key) as { result?: string } | null;
    return row?.result ? JSON.parse(row.result) : null;
  }
  store(key: string, result: unknown) {
    this.db.query("INSERT OR IGNORE INTO seen VALUES (?,?)").run(key, JSON.stringify(result));
  }
}

export async function start() {
  process.umask(0o077);
  const state = process.env.LEAD_WAKE_STATE ?? join(process.env.HOME!, ".local/state/lead-wake");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const seen = new Seen(join(state, "seen.sqlite"));
  const token = process.env.CLAUDE_PEERS_TOKEN;
  if (!token) throw Error("CLAUDE_PEERS_TOKEN is required");
  const routesPath = process.env.LEAD_WAKE_ROUTES ?? join(state, "routes.json");
  const authPath = process.env.LEAD_WAKE_T3 ?? join(state, "mac-t3.json");
  const brokerURL = (process.env.CLAUDE_PEERS_BROKER_URL ?? "http://100.108.57.10:7899").replace(/\/$/, "");
  const instance = seen.get("instance") ?? crypto.randomUUID();
  seen.set("instance", instance);
  let lease = seen.get("lease");
  const credentials = () => ({ id: PEER_ID, instance_id: instance, lease_id: lease });

  async function broker(route: string, body: unknown) {
    const res = await fetch(brokerURL + route, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!res.ok) throw Error(`broker ${route}: HTTP ${res.status}`);
    return res.json() as Promise<any>;
  }

  async function register() {
    const registered = await broker("/register", {
      ...credentials(), requested_id: PEER_ID, payload_version: 2, nickname: "Lead wake",
      pid: process.pid, cwd: process.cwd(), git_root: null, tty: null, machine: "theoldone",
      tier: "infrastructure", summary: SUMMARY, runtime: "hosted",
    });
    if (registered.id !== PEER_ID || registered.role !== "owner" || !registered.lease_id) throw Error("broker did not grant the lead-wake lease");
    lease = registered.lease_id;
    seen.set("lease", lease!);
  }

  async function wake(input: { to_id?: string; message?: string; from_id?: string; kind?: string; key?: string; message_id?: number | string; cwd?: string }) {
    if (input.key) {
      const prior = seen.recall(input.key);
      if (prior) return prior;
    }
    const brokerWake = input.message_id !== undefined && input.message_id !== null && input.message_id !== "";
    let routes = {};
    try { routes = loadRoutes(readFileSync(routesPath, "utf8")); }
    catch (error: any) {
      if (!brokerWake) return { ok: false, error: error.message?.startsWith("bad ") || error.message?.includes("routes") ? error.message : "routes file unavailable" };
    }
    let auth;
    try { auth = loadAuth(authPath); }
    catch { if (!brokerWake) return { ok: false, error: "Mac T3 credential unavailable" }; }
    let threads;
    if (brokerWake && auth && !routes[input.to_id ?? ""]) {
      try { threads = await readShell(auth); } catch { threads = undefined; }
    }
    const planned = planWake({
      routes, to_id: input.to_id, message: input.message, from_id: input.from_id, kind: input.kind,
      cwd: input.cwd, threads, message_id: brokerWake ? input.message_id : undefined,
    });
    if (planned.error) return { ok: false, error: planned.error };
    if (!auth) return { ok: false, error: "Mac T3 credential unavailable" };
    try {
      const sent = await dispatchToThread(auth, planned.threadId, planned.text, planned.commandId);
      const result = {
        ok: true, to_id: input.to_id, threadId: planned.threadId, dispatchMode: sent.dispatchMode,
        sequence: sent.sequence, threadUrl: `${auth.baseUrl}/${auth.environmentId}/${planned.threadId}`,
      };
      if (input.key) seen.store(input.key, result);
      log(`woke ${input.to_id} ${sent.dispatchMode} sequence ${sent.sequence ?? "?"}`);
      return result;
    } catch (error: any) {
      const message = /^(HTTP \d+|RPC |WebSocket |Mac T3 )/.test(error.message ?? "") ? error.message : "Mac T3 dispatch failed";
      log(`wake failed for ${input.to_id}: ${message}`);
      return { ok: false, error: message };
    }
  }

  async function reply(to_id: string, text: string) {
    if (!to_id || to_id === PEER_ID) return;
    try {
      await broker("/send-message", { ...credentials(), from_id: PEER_ID, to_id, text, kind: "notification" });
    } catch { log(`reply to ${to_id} was not delivered`); }
  }

  async function collect() {
    const claimed = await broker("/claim-messages", credentials());
    const messages = claimed.messages ?? [];
    const done: number[] = [];
    for (const message of messages) {
      if (message.from_id === PEER_ID) { done.push(message.id); continue; }
      const parsed = parseWakeText(message.text ?? "");
      const result = await wake({
        to_id: parsed.to_id ?? undefined, message: parsed.message, from_id: message.from_id,
        kind: parsed.kind ?? message.kind, key: `peers:${message.id}`,
      });
      if (!result.ok && result.error === "Mac T3 dispatch failed") continue;
      await reply(message.from_id, result.ok
        ? `woke ${result.to_id} thread ${result.threadId} (${result.dispatchMode})`
        : `lead-wake: ${result.error}`);
      done.push(message.id);
    }
    if (!done.length) return;
    const acked = await broker("/ack-messages", { ...credentials(), message_ids: done });
    if (acked.acked !== done.length) throw Error("broker ack incomplete");
  }

  async function tick() {
    try {
      try {
        const beat = await broker("/heartbeat", credentials());
        if (!beat.found) await register();
      } catch { await register(); }
      await collect();
    } catch (error: any) { log(error.message?.startsWith("broker ") ? error.message : "broker cycle failed"); }
  }

  await register();
  const server = Bun.serve({
    hostname: process.env.LEAD_WAKE_HOST ?? "100.108.57.10",
    port: Number(process.env.LEAD_WAKE_PORT ?? 8811),
    async fetch(req) {
      if (!authorized(req.headers.get("Authorization"), token)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/health") {
        let routeCount = 0;
        try { routeCount = Object.keys(loadRoutes(readFileSync(routesPath, "utf8"))).length; } catch { /* health still answers */ }
        return Response.json({ status: "ok", peer_id: PEER_ID, routes: routeCount });
      }
      if (req.method !== "POST" || path !== "/wake") return new Response("not found", { status: 404 });
      let body: any;
      try { body = await req.json(); } catch { return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }); }
      const result = await wake({
        to_id: body.to_id, message: body.message, from_id: body.from_id, kind: body.kind,
        message_id: body.message_id, cwd: body.cwd,
        key: body.message_id != null && body.message_id !== ""
          ? `broker:${body.message_id}`
          : typeof body.client_message_id === "string" ? `http:${body.client_message_id}` : undefined,
      });
      return Response.json(result, { status: result.ok ? 200 : 400 });
    },
  });
  log(`listening ${server.hostname}:${server.port} as ${PEER_ID}`);
  while (true) {
    await tick();
    await Bun.sleep(5_000);
  }
}

if (import.meta.main) start().catch(() => { log("fatal startup error"); process.exit(1); });
