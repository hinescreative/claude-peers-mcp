// Starts an idle T3 thread, or queues behind a turn that is already running.
// Same dispatch lead-wake uses. Never steers and never restarts a live run.
import { retryDispatch } from "./bell-protocol.ts";

export const T3_HTTP_TIMEOUT_MS = 3_000;
// One dispatch may outlive the broker's 4s. The command id is the message id,
// and the bell remembers that outcome, so the late finish is a replay.
const T3_RPC_TIMEOUT_MS = 40_000;

export function runStatus(snapshot: any): string | null {
  const thread = snapshot?.thread ?? snapshot?.projection ?? snapshot;
  const runs = thread?.projection?.runs ?? thread?.runs ?? snapshot?.projection?.runs;
  if (Array.isArray(runs) && runs.length) {
    const latest = [...runs].sort((a, b) => (b?.ordinal ?? 0) - (a?.ordinal ?? 0))[0];
    if (typeof latest?.status === "string") return latest.status;
  }
  if (typeof thread?.activityRunStatus === "string") return thread.activityRunStatus;
  if (typeof thread?.latestTurn?.state === "string") return thread.latestTurn.state;
  return null;
}

export function dispatchTimedOut(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /timed out|timeout/i.test(message);
}

export interface T3Auth {
  baseUrl: string;
  token: string;
  environmentId?: string;
}

async function http(auth: T3Auth, path: string, payload?: unknown) {
  const response = await fetch(new URL(path, auth.baseUrl), {
    method: payload === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      "x-t3-orchestration-protocol": "2",
      ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(T3_HTTP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} at ${path}`);
  return response.json() as Promise<any>;
}

function decodeExit(frame: any) {
  if (frame.exit?._tag !== "Success") throw new Error("RPC failed");
  return frame.exit.value;
}

async function connect(auth: T3Auth) {
  const ticket = await http(auth, "/api/auth/websocket-ticket", {});
  const url = new URL("/ws", auth.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("orchestrationProtocol", "2");
  url.searchParams.set("wsTicket", ticket.ticket);
  const ws = new WebSocket(url);
  const waiters = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let counter = 0;
  const rejectAll = () => {
    for (const item of waiters.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("RPC connection closed"));
    }
    waiters.clear();
  };
  ws.addEventListener("message", (event) => {
    let decoded: any;
    try { decoded = JSON.parse(String(event.data)); } catch { rejectAll(); return; }
    for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
      if (frame._tag === "Ping") { ws.send(JSON.stringify({ _tag: "Pong" })); continue; }
      const item = waiters.get(String(frame.requestId));
      if (frame._tag === "Exit" && item) {
        clearTimeout(item.timer);
        waiters.delete(String(frame.requestId));
        try { item.resolve(decodeExit(frame)); } catch (error) { item.reject(error as Error); }
      }
    }
  });
  ws.addEventListener("close", rejectAll);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("WebSocket open timed out")); }, T3_HTTP_TIMEOUT_MS);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket open failed")); }, { once: true });
  });
  return {
    close: () => ws.close(),
    call: (tag: string, payload: unknown) => new Promise<any>((resolve, reject) => {
      const id = String(++counter);
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`RPC ${tag} timed out`)); }, T3_RPC_TIMEOUT_MS);
      waiters.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    }),
  };
}

export interface ShellThread {
  id: string;
  worktreePath: string | null;
  archivedAt: string | null;
  latestTurnState: string | null;
}

export async function readShell(auth: T3Auth): Promise<ShellThread[]> {
  const snapshot = await http(auth, "/api/orchestration/shell");
  const threads = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
  return threads.map((thread: any) => ({
    id: String(thread.id ?? ""),
    worktreePath: typeof thread.worktreePath === "string" ? thread.worktreePath : null,
    archivedAt: typeof thread.archivedAt === "string" ? thread.archivedAt : null,
    latestTurnState: runStatus(thread),
  }));
}

async function dispatch(
  rpc: Awaited<ReturnType<typeof connect>>,
  threadId: string,
  text: string,
  dispatchMode: { type: string },
  commandId: string,
) {
  const result = await rpc.call("orchestration.dispatchCommand", {
    type: "message.dispatch",
    commandId,
    threadId,
    messageId: commandId,
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "mcp",
    dispatchMode,
  });
  return { commandId, sequence: result?.sequence ?? null, dispatchMode: dispatchMode.type };
}

async function readTurnState(auth: T3Auth, threadId: string): Promise<string | null> {
  const snapshot = await http(auth, `/api/orchestration/threads/${encodeURIComponent(threadId)}`);
  return runStatus(snapshot);
}

export async function dispatchToThread(
  auth: T3Auth,
  threadId: string,
  text: string,
  dispatchMode: { type: "start_immediately" } | { type: "queue_after_active" },
  commandId: string,
) {
  if (!auth?.baseUrl || !auth?.token) throw new Error("T3 credential is missing");
  const rpc = await connect(auth);
  try {
    try {
      return await dispatch(rpc, threadId, text, dispatchMode, commandId);
    } catch (error) {
      if (dispatchTimedOut(error)) throw error;
      let turn: string | null = null;
      try { turn = await readTurnState(auth, threadId); } catch { throw error; }
      if (retryDispatch(dispatchMode.type, turn) !== "queue") throw error;
      return await dispatch(rpc, threadId, text, { type: "queue_after_active" }, commandId);
    }
  } finally {
    rpc.close();
  }
}
