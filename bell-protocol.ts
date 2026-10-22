// Pure rules for the peers bell. The broker and the bell both import this so
// "who gets a wake" and "which thread" stay the same in tests and in production.

export const WAKE_TEXT = "peers mail waiting; run check_messages";
export const NO_PUSH = new Set(["codex", "cursor", "opencode", "grok"]);
const HARNESS = "claude|codex|cursor|opencode|grok|bell";
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export const THREAD_ID = new RegExp(`^(?:mcp:)?${UUID}$`);
const THREAD = `(?:mcp:)?${UUID}`;
const RUNTIME = new RegExp(`^(?:t3:(?<bare>${THREAD})|(?<harness>${HARNESS})(?::t3:(?<bound>${THREAD}))?)$`);
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
  if (!trimmed || trimmed.length > 80) return null;
  const parsed = parseRuntime(trimmed);
  if (parsed.harness || parsed.threadId) return trimmed;
  return LEGACY_RUNTIME.test(trimmed) ? trimmed : null;
}

export function isNoPush(runtime: string | null | undefined): boolean {
  const { harness } = parseRuntime(runtime);
  return harness !== null && NO_PUSH.has(harness);
}

// A wake is required when nobody is sitting on a push channel: the row is gone
// or stale, or the harness that registered has no messaging socket.
export function needsWake(input: { present: boolean; stale: boolean; runtime: string | null }): boolean {
  if (!input.present || input.stale) return true;
  return isNoPush(input.runtime);
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
  const override = input.peerId ? input.overrides?.[input.peerId] : undefined;
  if (override?.threadId && THREAD_ID.test(override.threadId)) {
    return { kind: "thread", threadId: override.threadId };
  }
  if (override?.tmux && TMUX_TARGET.test(override.tmux)) {
    return { kind: "tmux", target: override.tmux };
  }

  const fromRuntime = parseRuntime(input.runtime).threadId;
  if (fromRuntime && THREAD_ID.test(fromRuntime)) {
    return { kind: "thread", threadId: fromRuntime };
  }

  const threads = (input.threads ?? []).filter((thread) => !thread.archivedAt && thread.worktreePath);
  const matches = threads.filter((thread) => samePath(thread.worktreePath, input.cwd));
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only && THREAD_ID.test(only.id)) return { kind: "thread", threadId: only.id };
  return { error: "no-route" };
}

export function nicknameDecision(input: {
  callerId: string;
  nickname: string;
  live: { id: string; nickname: string }[];
  allowlist: Record<string, string>;
}): { ok: true; clearIds: string[] } | { ok: false; error: string } {
  const nickname = input.nickname.trim();
  if (!nickname) return { ok: true, clearIds: [] };
  const key = nickname.toLowerCase();
  const reservedOwner = Object.entries(input.allowlist).find(([name]) => name.toLowerCase() === key)?.[1];
  const holders = input.live.filter(
    (peer) => peer.id !== input.callerId && peer.nickname.trim().toLowerCase() === key,
  );
  if (reservedOwner) {
    if (input.callerId !== reservedOwner) return { ok: false, error: "nickname reserved" };
    return { ok: true, clearIds: holders.map((peer) => peer.id) };
  }
  if (holders.length) return { ok: false, error: "nickname taken" };
  return { ok: true, clearIds: [] };
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

export function loadAllowlist(text: string): Record<string, string> {
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("nickname allowlist must be an object");
  const allowlist: Record<string, string> = {};
  for (const [name, owner] of Object.entries(data)) {
    if (typeof name !== "string" || !name.trim() || typeof owner !== "string" || !PEER_ID.test(owner)) {
      throw new Error("nickname allowlist entries must map a name to a peer id");
    }
    allowlist[name.trim()] = owner;
  }
  return allowlist;
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
