import { chooseAutoMode, latestRun } from "./protocol.mjs";

async function http(baseUrl, path, token, payload) {
  const response = await fetch(new URL(path, baseUrl), {
    method: payload === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      "x-t3-orchestration-protocol": "2",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error(`HTTP ${response.status} at ${path}`);
  return response.json();
}

function decodeExit(frame) {
  if (frame.exit?._tag !== "Success") throw Error("RPC failed");
  return frame.exit.value;
}

async function connect(auth) {
  const ticket = await http(auth.baseUrl, "/api/auth/websocket-ticket", auth.token, {});
  const url = new URL("/ws", auth.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("orchestrationProtocol", "2");
  url.searchParams.set("wsTicket", ticket.ticket);
  const ws = new WebSocket(url), pending = new Map();
  let counter = 0;
  const rejectAll = () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("RPC connection closed")); }
    pending.clear();
  };
  ws.addEventListener("message", event => {
    let decoded;
    try { decoded = JSON.parse(event.data); } catch { rejectAll(); return; }
    for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
      if (frame._tag === "Ping") { ws.send(JSON.stringify({ _tag: "Pong" })); continue; }
      const item = pending.get(String(frame.requestId));
      if (frame._tag === "Exit" && item) {
        clearTimeout(item.timer);
        pending.delete(String(frame.requestId));
        try { item.resolve(decodeExit(frame)); } catch (error) { item.reject(error); }
      }
    }
  });
  ws.addEventListener("close", rejectAll);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Error("WebSocket open timed out")); }, 15000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(Error("WebSocket open failed")); }, { once: true });
  });
  return {
    close: () => ws.close(),
    call: (tag, payload) => new Promise((resolve, reject) => {
      const id = String(++counter);
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`RPC ${tag} timed out`)); }, 40000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    }),
  };
}

async function readProjection(auth, threadId) {
  const result = await http(auth.baseUrl, `/api/orchestration/threads/${encodeURIComponent(threadId)}`, auth.token);
  return result.projection ?? result;
}

export async function readShell(auth) {
  const snapshot = await http(auth.baseUrl, "/api/orchestration/shell", auth.token);
  const threads = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
  return threads.map((thread) => ({
    id: String(thread.id ?? ""),
    worktreePath: typeof thread.worktreePath === "string" ? thread.worktreePath : null,
    archivedAt: thread.archivedAt ?? null,
  }));
}

async function dispatch(rpc, threadId, text, dispatchMode, commandId = crypto.randomUUID()) {
  const result = await rpc.call("orchestration.dispatchCommand", {
    type: "message.dispatch", commandId, threadId, messageId: commandId, text, attachments: [],
    createdBy: "user", creationSource: "mcp", dispatchMode,
  });
  return { commandId, sequence: result?.sequence ?? null, dispatchMode: dispatchMode.type };
}

// Starts an idle Mac thread or queues behind its active run. One retry if the
// thread becomes active between the read and a start_immediately dispatch.
export async function dispatchToThread(auth, threadId, text, commandId) {
  if (!auth?.baseUrl || !auth?.token) throw Error("Mac T3 credential is missing");
  const before = latestRun(await readProjection(auth, threadId));
  const rpc = await connect(auth);
  try {
    try {
      return await dispatch(rpc, threadId, text, chooseAutoMode(before), commandId);
    } catch (error) {
      if (chooseAutoMode(before).type !== "start_immediately") throw error;
      const again = latestRun(await readProjection(auth, threadId));
      if (chooseAutoMode(again).type !== "queue_after_active") throw error;
      return await dispatch(rpc, threadId, text, { type: "queue_after_active" }, commandId);
    }
  } finally { rpc.close(); }
}
