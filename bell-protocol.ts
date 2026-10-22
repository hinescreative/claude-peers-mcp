// Pure rules for the peers bell. The broker and the bell both import this so
// "who gets a wake" and "which thread" stay the same in tests and in production.
import { createHash } from "node:crypto";

export const WAKE_TEXT = "peers mail waiting; run check_messages";
export const NO_PUSH = new Set(["codex", "cursor", "opencode", "grok", "poll"]);
const HARNESS = "claude|codex|cursor|opencode|grok|bell|poll";
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
// T3 thread ids are a uuid, an optional mcp: prefix, and an optional label
// such as :fork. mcp:3e3e7dbd-4ab2-454b-8ae2-cebf0a87193c:fork is a real one.
const THREAD = `(?:mcp:)?${UUID}(?::[A-Za-z0-9_-]{1,32})?`;
export const THREAD_ID = new RegExp(`^${THREAD}$`, "i");
const RUNTIME = new RegExp(`^(?:t3:(?<bare>${THREAD})|(?<harness>${HARNESS})(?::t3:(?<bound>${THREAD}))?)$`, "i");
const LEGACY_RUNTIME = /^[a-zA-Z0-9_-]{1,32}$/;
const TMUX_TARGET = /^[a-zA-Z0-9_.:@=-]{1,80}$/;
const PEER_ID = /^[a-zA-Z0-9_-]{3,64}$/;

export interface ThreadFact {
  id: string;
  worktreePath?: string | null;
  archivedAt?: string | null;
  latestTurnState?: string | null;
}

export interface RouteOverride {
  threadId?: string;
  tmux?: string;
}

export type ResolvedRoute =
  | { kind: "thread"; threadId: string }
  | { kind: "tmux"; target: string }
  | { error: "no-route" };

export function parseRuntime(value: string | null | undefined): { harness: string | null; threadId: string | null } {
  if (!value) return { harness: null, threadId: null };
  const match = RUNTIME.exec(value.trim());
  if (!match?.groups) return { harness: null, threadId: null };
  return {
    harness: match.groups.harness ?? null,
    threadId: match.groups.bare ?? match.groups.bound ?? null,
  };
}

export function normalizeRuntime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 96) return null;
  const parsed = parseRuntime(trimmed);
  if (parsed.harness || parsed.threadId) return trimmed;
  return LEGACY_RUNTIME.test(trimmed) ? trimmed : null;
}

export function isNoPush(runtime: string | null | undefined): boolean {
  const { harness } = parseRuntime(runtime);
  return harness !== null && NO_PUSH.has(harness);
}

// A wake is required when nobody is sitting on a push channel: the row is gone
// or stale, the v2 owner lease is dead, or the harness has no messaging socket.
export function needsWake(input: {
  present: boolean;
  stale: boolean;
  runtime: string | null;
  ownerLive?: boolean;
}): boolean {
  if (!input.present || input.stale || input.ownerLive === false) return true;
  return isNoPush(input.runtime);
}

// Keep a thread id that was bound earlier when a refresh only names the harness.
export function mergeRuntime(incoming: string | null, prior: string | null): string | null {
  const next = parseRuntime(incoming);
  const previous = parseRuntime(prior);
  if (next.harness && !next.threadId && previous.threadId) return `${next.harness}:t3:${previous.threadId}`;
  return incoming ?? prior;
}

export function routeIsFresh(updatedAt: string | null | undefined, now = Date.now(), ttlMs = 7 * 24 * 60 * 60 * 1000): boolean {
  const at = Date.parse(updatedAt ?? "");
  return Number.isFinite(at) && now - at <= ttlMs;
}

// Retry the wake only when a re-read shows a turn actually running. A lost
// response is not that, and must not send a second command.
export function retryDispatch(mode: string, turnState: string | null | undefined): "queue" | "abort" {
  if (mode !== "start_immediately") return "abort";
  return turnState === "running" ? "queue" : "abort";
}

export function parentChanged(startPid: number, currentPid: number): boolean {
  if (!startPid || startPid === 1) return false;
  return Number.isInteger(currentPid) && currentPid !== startPid;
}

// mcp:uuid:fork is a fork. A plain uuid or mcp:uuid is not.
export function isForkThread(id: string): boolean {
  return id.replace(/^mcp:/i, "").includes(":");
}

// A project root is not unique. T3 gives each thread its own directory under here.
export function isWorktreePath(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  return cwd.replace(/\\/g, "/").includes("/.t3/worktrees/");
}

export function bellPeerId(machine: string): string {
  const safe = machine.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const id = `bell-${safe || "host"}`;
  return id.length >= 3 ? id.slice(0, 64) : "bell-host";
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\/+$/, "");
  return norm(a) === norm(b);
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return code === "EPERM";
  }
}

export function planDispatch(turnState: string | null | undefined): { type: "start_immediately" } | { type: "queue_after_active" } {
  return turnState === "running" ? { type: "queue_after_active" } : { type: "start_immediately" };
}

export function planWake(input: {
  peerId?: string;
  cwd?: string | null;
  runtime?: string | null;
  overrides?: Record<string, RouteOverride>;
  threads?: ThreadFact[];
}): { text: string; dispatchMode: { type: "start_immediately" } | { type: "queue_after_active" }; threadId: string } | { text: string; tmux: string } | { error: "no-route" } {
  const route = resolveRoute(input);
  if ("error" in route) return route;
  if (route.kind === "tmux") return { text: WAKE_TEXT, tmux: route.target };
  const turn = input.threads?.find((thread) => thread.id === route.threadId)?.latestTurnState ?? null;
  return { text: WAKE_TEXT, threadId: route.threadId, dispatchMode: planDispatch(turn) };
}

export function resolveRoute(input: {
  peerId?: string;
  cwd?: string | null;
  runtime?: string | null;
  overrides?: Record<string, RouteOverride>;
  threads?: ThreadFact[];
}): ResolvedRoute {
  const threads = input.threads;
  const usable = (id: string): ResolvedRoute | { error: "no-route" } | null => {
    if (!THREAD_ID.test(id)) return null;
    if (!threads) return { kind: "thread", threadId: id };
    const found = threads.find((thread) => thread.id === id);
    if (!found || found.archivedAt) return { error: "no-route" };
    return { kind: "thread", threadId: id };
  };

  const override = input.peerId ? input.overrides?.[input.peerId] : undefined;
  if (override?.threadId) {
    const decided = usable(override.threadId);
    if (decided) return decided;
  }
  if (override?.tmux && TMUX_TARGET.test(override.tmux)) {
    return { kind: "tmux", target: override.tmux };
  }

  const fromRuntime = parseRuntime(input.runtime).threadId;
  if (fromRuntime) {
    const decided = usable(fromRuntime);
    if (decided) return decided;
  }

  // Project roots are explicit routes only. A worktree path matches when it
  // has exactly one live thread and that thread is not a fork.
  if (!isWorktreePath(input.cwd)) return { error: "no-route" };
  const live = (threads ?? []).filter((thread) => !thread.archivedAt && thread.worktreePath);
  const archivedSame = (threads ?? []).some((thread) => thread.archivedAt && samePath(thread.worktreePath, input.cwd));
  if (archivedSame) return { error: "no-route" };
  const matches = live.filter((thread) => samePath(thread.worktreePath, input.cwd));
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only && THREAD_ID.test(only.id) && !isForkThread(only.id)) return { kind: "thread", threadId: only.id };
  return { error: "no-route" };
}

export function loadRouteTable(text: string): Record<string, RouteOverride> {
  const data = JSON.parse(text);
  const table = data.routes ?? data;
  if (!table || typeof table !== "object" || Array.isArray(table)) throw new Error("routes file must be an object");
  const routes: Record<string, RouteOverride> = {};
  for (const [id, route] of Object.entries(table) as [string, RouteOverride][]) {
    if (!PEER_ID.test(id)) throw new Error(`bad peer id in routes: ${id}`);
    if (route?.threadId !== undefined && !THREAD_ID.test(route.threadId)) throw new Error(`bad thread id for ${id}`);
    if (route?.tmux !== undefined && !TMUX_TARGET.test(route.tmux)) throw new Error(`bad tmux target for ${id}`);
    if (!route?.threadId && !route?.tmux) throw new Error(`route for ${id} needs a threadId or tmux target`);
    routes[id] = { threadId: route?.threadId, tmux: route?.tmux };
  }
  return routes;
}

const WAKE_NAMESPACE = "c3a1e5b0-7d24-4f6a-9b18-2e6d0a4c8f51";

// UUID v5 of the message id. A retry asks T3 for the same command, which T3 dedupes.
export function wakeCommandId(messageId: number): string {
  const namespace = Buffer.from(WAKE_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(namespace).update(String(messageId)).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function shareWake<T>(
  memory: Map<string, { at: number; result: Promise<T> }>,
  key: string,
  now: number,
  ttlMs: number,
  run: () => Promise<T>,
): Promise<T> {
  for (const [id, item] of memory) {
    if (now - item.at > ttlMs) memory.delete(id);
  }
  const cached = memory.get(key);
  if (cached && now - cached.at <= ttlMs) return cached.result;
  const result = run();
  memory.set(key, { at: now, result });
  return result;
}

export function loadBells(text: string): Record<string, string> {
  const data = JSON.parse(text);
  const table = data.bells ?? data;
  if (!table || typeof table !== "object" || Array.isArray(table)) throw new Error("bells file must be an object");
  const bells: Record<string, string> = {};
  for (const [machine, url] of Object.entries(table)) {
    if (typeof machine !== "string" || !machine.trim() || typeof url !== "string") throw new Error("bad bells entry");
    const parsed = new URL(url);
    if (parsed.username || parsed.password || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      throw new Error("bell url must be http(s) without credentials");
    }
    bells[machine.trim()] = parsed.origin;
  }
  return bells;
}
