// Pure rules for the peers bell. The broker and the bell both import this so
// "who gets a wake" and "which thread" stay the same in tests and in production.

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

// A suffix is a sibling waiting on the base. It asks again every heartbeat.
export function shouldReaskBase(requestedId: string, effectiveId: string): boolean {
  return Boolean(requestedId) && requestedId !== effectiveId;
}

// mcp:uuid:fork is a fork. A plain uuid or mcp:uuid is not.
export function isForkThread(id: string): boolean {
  return id.replace(/^mcp:/i, "").includes(":");
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
  seenOnPath?: string[];
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

  // The shell snapshot does not include archived threads, so a cwd match is
  // only safe when one live thread has this path, it is not a fork, and this
  // bell has never seen a second thread on the path.
  if ((input.seenOnPath?.length ?? 0) > 1) return { error: "no-route" };
  const live = (threads ?? []).filter((thread) => !thread.archivedAt && thread.worktreePath);
  const archivedSame = (threads ?? []).some((thread) => thread.archivedAt && samePath(thread.worktreePath, input.cwd));
  if (archivedSame) return { error: "no-route" };
  const matches = live.filter((thread) => samePath(thread.worktreePath, input.cwd));
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only && THREAD_ID.test(only.id) && !isForkThread(only.id)) return { kind: "thread", threadId: only.id };
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
    const exact = input.callerId === reservedOwner;
    const suffix = input.callerId.startsWith(`${reservedOwner}-`);
    const baseLive = input.live.some((peer) => peer.id === reservedOwner);
    // A suffixed respawn may take the name back only after the base seat is gone.
    if (!exact && !(suffix && !baseLive)) return { ok: false, error: "nickname reserved" };
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
