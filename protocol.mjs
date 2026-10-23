// Pure routing rules for lead-wake.
import { createHash } from "node:crypto";

export const PEER_ID = /^[a-zA-Z0-9_-]{3,64}$/;
export const THREAD_ID = /^(?:mcp:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::[A-Za-z0-9_-]{1,32})?$/i;
const TERMINAL = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
export const MAX_MESSAGE = 8000;

export function loadRoutes(text) {
  const data = JSON.parse(text);
  const table = data.routes ?? data;
  if (!table || typeof table !== "object" || Array.isArray(table)) throw Error("routes file must be an object");
  const routes = {};
  for (const [id, route] of Object.entries(table)) {
    if (!PEER_ID.test(id)) throw Error(`bad peer id in routes: ${id}`);
    if (!route || !THREAD_ID.test(route.threadId ?? "")) throw Error(`bad thread id for ${id}`);
    routes[id] = { threadId: route.threadId, title: typeof route.title === "string" ? route.title : "" };
  }
  return routes;
}

export function parseWakeText(text) {
  let to_id = null, kind = null, header = true;
  const body = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (header && !line.trim()) continue;
    const match = header && /^(to|kind):\s*(\S+)\s*$/i.exec(line);
    if (match) {
      if (match[1].toLowerCase() === "to") to_id = match[2];
      else kind = match[2].toLowerCase();
      continue;
    }
    header = false;
    body.push(line);
  }
  return { to_id, kind, message: body.join("\n").trim() };
}

export function threadText({ from_id, to_id, kind, message }) {
  const who = PEER_ID.test(from_id ?? "") ? from_id : "unknown";
  const how = kind && /^(notification|request|reply)$/.test(kind) ? ` (${kind})` : "";
  return [
    `Peers message for ${to_id} from ${who}${how}.`,
    "The seat was not on peers, so lead-wake delivered this into the T3 thread.",
    "",
    message.trim(),
  ].join("\n");
}

const WAKE_NAMESPACE = "c3a1e5b0-7d24-4f6a-9b18-2e6d0a4c8f51";
export const WAKE_TEXT = "peers mail waiting; run check_messages";

export function wakeCommandId(messageId) {
  const namespace = Buffer.from(WAKE_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(namespace).update(String(messageId)).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function matchWorktree(threads, cwd) {
  const path = String(cwd ?? "").replace(/\\/g, "/");
  if (!path.includes("/.t3/worktrees/")) return null;
  const norm = (value) => String(value).replace(/\/+$/, "");
  const live = (threads ?? []).filter((thread) => thread?.id && !thread.archivedAt && thread.worktreePath && !String(thread.id).replace(/^mcp:/i, "").includes(":"));
  const matches = live.filter((thread) => norm(thread.worktreePath) === norm(path));
  return matches.length === 1 ? matches[0].id : null;
}

export function planWake({ routes, to_id, message, from_id, kind, cwd, threads, message_id }) {
  if (!PEER_ID.test(to_id ?? "")) return { error: "to_id must match [a-zA-Z0-9_-]{3,64}" };
  const broker = message_id !== undefined && message_id !== null && message_id !== "";
  const body = String(message ?? "").trim();
  if (!broker && !body) return { error: "message is empty" };
  if (!broker && body.length > MAX_MESSAGE) return { error: "message is too long" };
  const threadId = routes?.[to_id]?.threadId ?? matchWorktree(threads, cwd);
  if (!threadId) return { error: broker ? "no-route" : `no wake route for ${to_id}` };
  return {
    threadId,
    text: broker ? WAKE_TEXT : threadText({ from_id, to_id, kind, message: body }),
    ...(broker ? { commandId: wakeCommandId(message_id) } : {}),
  };
}

export function latestRun(projection) {
  return [...(projection?.runs ?? [])].sort((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0))[0] ?? null;
}

// auto only: start an idle thread, or queue behind a live run. Never steer or restart.
export function chooseAutoMode(run) {
  return run && !TERMINAL.has(run.status) ? { type: "queue_after_active" } : { type: "start_immediately" };
}
