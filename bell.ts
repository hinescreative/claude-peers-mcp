#!/usr/bin/env bun
// One bell per T3 host. The broker calls POST /wake when a seat has no push
// channel, or when its process is gone. This starts that seat's thread, or
// rings a tmux session. The mailbox text stays on the broker.
import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { bellPeerId, keepWake, loadRouteTable, pidAlive, planWake, shareWake, wakeCommandId, type RouteOverride } from "./bell-protocol.ts";
import { dispatchToThread, readShell, type T3Auth } from "./bell-dispatch.ts";

const PEER_ID_RE = /^[a-zA-Z0-9_-]{3,64}$/;

function authorized(header: string | null, token: string) {
  const got = Buffer.from(header ?? "");
  const expect = Buffer.from(`Bearer ${token}`);
  return got.length === expect.length && timingSafeEqual(got, expect);
}

function readJsonFile(path: string | undefined): string | null {
  if (!path) return null;
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

export function loadT3Auth(path: string): T3Auth {
  const info = statSync(path);
  if ((info.mode & 0o777) !== 0o600) throw new Error("T3 credential file must be mode 600");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("T3 credential file must be owned by this user");
  }
  const auth = JSON.parse(readFileSync(path, "utf8"));
  if (!auth.baseUrl || !auth.token) throw new Error("T3 credential file is incomplete");
  return { baseUrl: auth.baseUrl, token: auth.token, environmentId: auth.environmentId };
}

export type WakeOutcome = {
  ok: boolean;
  error?: string;
  uncertain?: boolean;
  to_id?: string;
  threadId?: string;
  dispatchMode?: string;
  tmux?: string;
};

export function wakeFailure(error: unknown): WakeOutcome {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const uncertain = /^RPC .+ timed out$/i.test(message);
  return { ok: false, error: "dispatch-failed", ...(uncertain ? { uncertain: true } : {}) };
}

export async function deliverWake(input: {
  body: any;
  commandId: string | null;
  overrides: Record<string, RouteOverride>;
  threads: { id: string; worktreePath: string | null; archivedAt: string | null; latestTurnState: string | null }[] | undefined;
  shellFailed: boolean;
  authOk: boolean;
  dispatch: (threadId: string, text: string, mode: { type: "start_immediately" } | { type: "queue_after_active" }, commandId: string) => Promise<{ dispatchMode: string }>;
  ring: (target: string, text: string) => Promise<void>;
}): Promise<WakeOutcome> {
  const body = input.body;
  const toId = typeof body?.to_id === "string" ? body.to_id : "";
  if (!PEER_ID_RE.test(toId)) return { ok: false, error: "no-route" };
  const planned = planWake({
    peerId: toId,
    cwd: typeof body?.cwd === "string" ? body.cwd : null,
    runtime: typeof body?.runtime === "string" ? body.runtime : null,
    overrides: input.overrides,
    threads: input.threads,
  });
  if ("error" in planned) {
    return { ok: false, error: input.shellFailed ? "thread-list-unavailable" : "no-route" };
  }
  if ("tmux" in planned) {
    try {
      await input.ring(planned.tmux, planned.text);
      return { ok: true, to_id: toId, tmux: planned.tmux };
    } catch {
      return { ok: false, error: "tmux-failed" };
    }
  }
  if (!input.authOk) return { ok: false, error: "credential-unavailable" };
  if (!input.commandId) return { ok: false, error: "dispatch-failed" };
  try {
    const sent = await input.dispatch(planned.threadId, planned.text, planned.dispatchMode, input.commandId);
    return { ok: true, to_id: toId, threadId: planned.threadId, dispatchMode: sent.dispatchMode };
  } catch (error) {
    return wakeFailure(error);
  }
}

export function wakeSeat(
  memory: Map<string, { at: number; result: Promise<WakeOutcome> }>,
  body: any,
  deliver: (body: any, commandId: string | null) => Promise<WakeOutcome>,
): Promise<WakeOutcome> {
  const messageId = Number.isSafeInteger(body?.message_id) ? Number(body.message_id) : null;
  const run = () => deliver(body, messageId === null ? null : wakeCommandId(messageId));
  if (messageId === null) return run();
  return shareWake(memory, String(messageId), Date.now(), 10 * 60 * 1000, run, keepWake);
}

async function ringTmux(target: string, text: string) {
  const proc = Bun.spawn(["tmux", "send-keys", "-t", target, text, "Enter"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error("tmux send-keys failed");
}

export async function start() {
  const token = process.env.CLAUDE_PEERS_TOKEN ?? "";
  if (!token) throw new Error("CLAUDE_PEERS_TOKEN is required");
  const machine = process.env.CLAUDE_PEERS_MACHINE ?? "mac";
  const peerId = bellPeerId(machine);
  const brokerURL = (process.env.CLAUDE_PEERS_BROKER_URL ?? "http://100.108.57.10:7899").replace(/\/$/, "");
  const routesPath = process.env.BELL_ROUTES ?? join(process.env.HOME ?? "", ".local/state/peers-bell/routes.json");
  const t3Path = process.env.BELL_T3 ?? join(process.env.HOME ?? "", ".local/state/peers-bell/t3.json");
  const host = process.env.BELL_HOST ?? "127.0.0.1";
  const port = Number(process.env.BELL_PORT ?? 8812);

  function log(line: string) {
    console.log(`[bell] ${line}`);
  }

  async function broker(route: string, body: unknown) {
    const res = await fetch(brokerURL + route, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`broker ${route} HTTP ${res.status}`);
    return res.json() as Promise<any>;
  }

  let lease: string | null = null;
  const instance = crypto.randomUUID();

  async function register() {
    const registered = await broker("/register", {
      requested_id: peerId,
      instance_id: instance,
      ...(lease ? { lease_id: lease } : {}),
      payload_version: 2,
      nickname: `Bell ${machine}`,
      pid: process.pid,
      cwd: process.cwd(),
      git_root: null,
      tty: null,
      machine,
      tier: "infrastructure",
      runtime: "bell",
      summary: `Wakes ${machine} seats that have no push channel.`,
    });
    if (registered.id !== peerId || registered.role !== "owner" || !registered.lease_id) {
      throw new Error("broker did not grant the bell lease");
    }
    lease = registered.lease_id;
  }

  function overrides(): Record<string, RouteOverride> {
    const text = readJsonFile(routesPath);
    if (!text) return {};
    try { return loadRouteTable(text); } catch (error) {
      log(error instanceof Error ? error.message : "routes file unreadable");
      return {};
    }
  }

  const wakeMemory = new Map<string, { at: number; result: Promise<WakeOutcome> }>();

  function wake(body: any) {
    return wakeSeat(wakeMemory, body, async (wakeBody, commandId) => {
      let threads: { id: string; worktreePath: string | null; archivedAt: string | null; latestTurnState: string | null }[] | undefined;
      let shellFailed = false;
      try {
        threads = await readShell(loadT3Auth(t3Path));
      } catch {
        shellFailed = true;
      }
      let authOk = true;
      let auth: T3Auth | null = null;
      try { auth = loadT3Auth(t3Path); } catch { authOk = false; }
      const outcome = await deliverWake({
        body: wakeBody,
        commandId,
        overrides: overrides(),
        threads,
        shellFailed,
        authOk,
        ring: ringTmux,
        dispatch: (threadId, text, mode, id) => dispatchToThread(auth as T3Auth, threadId, text, mode, id),
      });
      if (outcome.ok) log(outcome.tmux ? `rang tmux for ${outcome.to_id}` : `woke ${outcome.to_id} ${outcome.dispatchMode}`);
      return outcome;
    });
  }

  async function reapDead() {
    if (!lease) return;
    const peers = await broker("/list-peers", {
      scope: "machine",
      machine,
      cwd: process.cwd(),
      git_root: null,
    });
    for (const peer of Array.isArray(peers) ? peers : []) {
      if (!peer?.id || peer.id === peerId || peer.machine !== machine) continue;
      if (pidAlive(Number(peer.pid))) continue;
      await broker("/reap-dead", {
        id: peerId,
        instance_id: instance,
        lease_id: lease,
        peer_id: peer.id,
        pid: peer.pid,
        machine,
      });
      log(`reaped dead peer ${peer.id}`);
    }
  }

  await register();
  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      if (!authorized(req.headers.get("Authorization"), token)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/health") {
        return Response.json({ status: "ok", peer_id: peerId, machine });
      }
      if (req.method !== "POST" || path !== "/wake") return new Response("not found", { status: 404 });
      let body: unknown;
      try { body = await req.json(); } catch { return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }); }
      const result = await wake(body);
      const status = result.ok ? 200 : result.error === "no-route" ? 200 : 502;
      return Response.json(result, { status });
    },
  });
  log(`listening ${server.hostname}:${server.port} as ${peerId}`);

  while (true) {
    try {
      const beat = await broker("/heartbeat", { id: peerId, instance_id: instance, lease_id: lease });
      if (!beat.found) await register();
      await reapDead();
    } catch (error) {
      log(error instanceof Error && error.message.startsWith("broker ") ? error.message : "broker cycle failed");
      try { await register(); } catch { /* next loop */ }
    }
    await Bun.sleep(5_000);
  }
}

if (import.meta.main) {
  start().catch((error) => {
    console.error(`[bell] fatal: ${error instanceof Error ? error.message : "startup failed"}`);
    process.exit(1);
  });
}
