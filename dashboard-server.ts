#!/usr/bin/env bun
/**
 * Local operator dashboard for claude-peers.
 *
 * Intended origin: tailnet or localhost -> this process -> broker HTTP API.
 * The browser never sees CLAUDE_PEERS_TOKEN. Does not proxy /purge.
 */

import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";
import type { Peer } from "./shared/types.ts";

const execFileAsync = promisify(execFile);
const TAILSCALE_CANDIDATES = [
  process.env.TAILSCALE_BIN,
  "tailscale",
  "/usr/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
].filter((p): p is string => Boolean(p));

const DASHBOARD_PORT = parseInt(process.env.CLAUDE_PEERS_DASHBOARD_PORT ?? "8799", 10);
const DASHBOARD_HOST = process.env.CLAUDE_PEERS_DASHBOARD_HOST ?? "127.0.0.1";
const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = process.env.CLAUDE_PEERS_BROKER_URL ?? `http://127.0.0.1:${BROKER_PORT}`;
const AUTH_TOKEN = process.env.CLAUDE_PEERS_TOKEN ?? "";
const DEFAULT_CWD = process.env.CLAUDE_PEERS_DASHBOARD_CWD ?? process.cwd();
const DEFAULT_GIT_ROOT = process.env.CLAUDE_PEERS_DASHBOARD_GIT_ROOT ?? DEFAULT_CWD;
const DEFAULT_MACHINE = process.env.CLAUDE_PEERS_MACHINE ?? "mac";
const DASHBOARD_PEER_ID = process.env.CLAUDE_PEERS_DASHBOARD_PEER_ID ?? "dashboard";
const DASHBOARD_ALLOWED_EMAILS = new Set(
  (process.env.CLAUDE_PEERS_DASHBOARD_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);

if (!AUTH_TOKEN) {
  console.error("[claude-peers dashboard] WARNING: CLAUDE_PEERS_TOKEN is not set.");
}

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  return headers;
}

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Broker ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function requireAccess(req: IncomingMessage, res: ServerResponse): boolean {
  if (DASHBOARD_ALLOWED_EMAILS.size === 0) return true;
  const raw = req.headers["cf-access-authenticated-user-email"];
  const email = Array.isArray(raw) ? raw[0]?.toLowerCase() : raw?.toLowerCase();
  if (!email) {
    sendJson(res, 403, { error: "Missing Cloudflare Access identity header." });
    return false;
  }
  if (!DASHBOARD_ALLOWED_EMAILS.has(email)) {
    sendJson(res, 403, { error: `Access denied for ${email}.` });
    return false;
  }
  return true;
}

async function listPeers(scope = "repo"): Promise<Peer[]> {
  return brokerFetch<Peer[]>("/list-peers", {
    scope,
    cwd: DEFAULT_CWD,
    git_root: DEFAULT_GIT_ROOT,
    machine: DEFAULT_MACHINE,
  });
}

type TailnetNode = {
  id: string;
  hostName: string;
  dnsName: string;
  os: string;
  online: boolean;
  ips: string[];
  lastSeen: string;
  relay: string;
};

function slimNode(node: Record<string, unknown> | undefined): TailnetNode | null {
  if (!node) return null;
  const ips = Array.isArray(node.TailscaleIPs) ? node.TailscaleIPs.filter((ip): ip is string => typeof ip === "string") : [];
  return {
    id: String(node.ID ?? ""),
    hostName: String(node.HostName ?? ""),
    dnsName: String(node.DNSName ?? ""),
    os: String(node.OS ?? ""),
    online: Boolean(node.Online),
    ips,
    lastSeen: String(node.LastSeen ?? ""),
    relay: String(node.Relay ?? ""),
  };
}

async function runTailscaleStatus(): Promise<string> {
  let lastErr: Error | null = null;
  for (const bin of TAILSCALE_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(bin, ["status", "--json"], {
        timeout: 8000,
        maxBuffer: 4_000_000,
      });
      return stdout;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr ?? new Error("tailscale not found");
}

async function readTailnet(): Promise<{ backendState: string; self: TailnetNode | null; peers: TailnetNode[] }> {
  const stdout = await runTailscaleStatus();
  const raw = JSON.parse(stdout) as {
    BackendState?: string;
    Self?: Record<string, unknown>;
    Peer?: Record<string, Record<string, unknown>>;
  };
  const peers: TailnetNode[] = [];
  if (raw.Peer && typeof raw.Peer === "object") {
    for (const node of Object.values(raw.Peer)) {
      const slim = slimNode(node);
      if (slim) peers.push(slim);
    }
  }
  return {
    backendState: raw.BackendState ?? "unknown",
    self: slimNode(raw.Self),
    peers,
  };
}

async function resolvePeerId(input: Record<string, unknown>): Promise<string | null> {
  if (typeof input.id === "string" && input.id.trim()) return input.id.trim();
  if (typeof input.nickname !== "string" || !input.nickname.trim()) return null;
  const nickname = input.nickname.trim();
  const matches = (await listPeers("fleet")).filter((peer) => peer.nickname === nickname);
  return matches.length === 1 ? matches[0].id : null;
}

async function serveStatic(url: URL, res: ServerResponse) {
  const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname.replace(/^\/+/, ""));
  if (rel.startsWith("..")) {
    send(res, 403, "Forbidden");
    return;
  }

  const file = new URL(`./dashboard/${rel}`, import.meta.url);
  try {
    const body = await readFile(file);
    const ext = extname(rel);
    const type =
      ext === ".css" ? "text/css; charset=utf-8" :
      ext === ".js" ? "text/javascript; charset=utf-8" :
      "text/html; charset=utf-8";
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  } catch {
    send(res, 404, "Not found");
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      broker_url: BROKER_URL,
      cwd: DEFAULT_CWD,
      git_root: DEFAULT_GIT_ROOT,
      machine: DEFAULT_MACHINE,
      access_email: req.headers["cf-access-authenticated-user-email"] ?? null,
    });
    return;
  }

  if (url.pathname === "/api/peers") {
    sendJson(res, 200, { peers: await listPeers(url.searchParams.get("scope") ?? "fleet") });
    return;
  }

  if (url.pathname === "/api/tailnet") {
    try {
      sendJson(res, 200, await readTailnet());
    } catch (e) {
      sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  if (url.pathname === "/api/purge" || url.pathname.includes("purge")) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  const body = await readBody(req);
  const id = await resolvePeerId(body);

  if (url.pathname === "/api/message") {
    if (!id || typeof body.message !== "string") {
      sendJson(res, 400, { error: "id or unique nickname plus message required" });
      return;
    }
    sendJson(res, 200, await brokerFetch("/send-message", {
      from_id: DASHBOARD_PEER_ID,
      to_id: id,
      text: body.message,
    }));
    return;
  }

  if (url.pathname === "/api/nickname") {
    if (!id || typeof body.value !== "string") {
      sendJson(res, 400, { error: "id plus value required" });
      return;
    }
    sendJson(res, 200, await brokerFetch("/set-nickname", { id, nickname: body.value }));
    return;
  }

  if (url.pathname === "/api/summary") {
    if (!id || typeof body.value !== "string") {
      sendJson(res, 400, { error: "id plus value required" });
      return;
    }
    sendJson(res, 200, await brokerFetch("/set-summary", { id, summary: body.value }));
    return;
  }

  if (url.pathname === "/api/context") {
    if (!id) {
      sendJson(res, 400, { error: "id or unique nickname required" });
      return;
    }
    sendJson(res, 200, await brokerFetch("/set-context", {
      id,
      context_window: body.context_window ?? null,
      context_used: body.context_used ?? null,
      context_note: body.context_note ?? "",
    }));
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  void (async () => {
    if (!req.url) {
      send(res, 400, "Bad request");
      return;
    }
    if (!requireAccess(req, res)) return;
    const url = new URL(req.url, `http://${req.headers.host ?? `${DASHBOARD_HOST}:${DASHBOARD_PORT}`}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(url, res);
  })().catch((e) => {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  });
});

server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
  console.error(`[claude-peers dashboard] listening on http://${DASHBOARD_HOST}:${DASHBOARD_PORT} -> ${BROKER_URL}`);
});
