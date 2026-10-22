// Starts an idle T3 thread, or queues behind a turn that is already running.
// Same dispatch lead-wake uses. Never steers and never restarts a live run.

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
    signal: AbortSignal.timeout(15000),
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
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let counter = 0;
  const rejectAll = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("RPC connection closed"));
    }
    pending.clear();
  };
  ws.addEventListener("message", (event) => {
    let decoded: any;
    try { decoded = JSON.parse(String(event.data)); } catch { rejectAll(); return; }
    for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
      if (frame._tag === "Ping") { ws.send(JSON.stringify({ _tag: "Pong" })); continue; }
      const item = pending.get(String(frame.requestId));
      if (frame._tag === "Exit" && item) {
        clearTimeout(item.timer);
        pending.delete(String(frame.requestId));
        try { item.resolve(decodeExit(frame)); } catch (error) { item.reject(error as Error); }
      }
    }
  });
  ws.addEventListener("close", rejectAll);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("WebSocket open timed out")); }, 15000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket open failed")); }, { once: true });
  });
  return {
    close: () => ws.close(),
    call: (tag: string, payload: unknown) => new Promise<any>((resolve, reject) => {
      const id = String(++counter);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${tag} timed out`)); }, 40000);
      pending.set(id, { resolve, reject, timer });
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
    latestTurnState: typeof thread.latestTurn?.state === "string" ? thread.latestTurn.state : null,
  }));
}

async function dispatch(rpc: Awaited<ReturnType<typeof connect>>, threadId: string, text: string, dispatchMode: { type: string }) {
  const commandId = crypto.randomUUID();
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

export async function dispatchToThread(
  auth: T3Auth,
  threadId: string,
  text: string,
  dispatchMode: { type: "start_immediately" } | { type: "queue_after_active" },
) {
  if (!auth?.baseUrl || !auth?.token) throw new Error("T3 credential is missing");
  const rpc = await connect(auth);
  try {
    try {
      return await dispatch(rpc, threadId, text, dispatchMode);
    } catch (error) {
      if (dispatchMode.type !== "start_immediately") throw error;
      return await dispatch(rpc, threadId, text, { type: "queue_after_active" });
    }
  } finally {
    rpc.close();
  }
}
