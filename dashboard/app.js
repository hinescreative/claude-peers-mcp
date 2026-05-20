const state = {
  peers: [],
  selected: null,
};

const API_BASE_KEY = "claudePeersApiBase";
let apiBase = localStorage.getItem(API_BASE_KEY) || window.CLAUDE_PEERS_API_BASE || "";

const els = {
  meta: document.querySelector("#meta"),
  scope: document.querySelector("#scope"),
  refresh: document.querySelector("#refresh"),
  count: document.querySelector("#count"),
  peers: document.querySelector("#peers"),
  detailTitle: document.querySelector("#detail-title"),
  selectedId: document.querySelector("#selected-id"),
  peerMeta: document.querySelector("#peer-meta"),
  nickname: document.querySelector("#nickname"),
  summary: document.querySelector("#summary"),
  contextWindow: document.querySelector("#context-window"),
  contextUsed: document.querySelector("#context-used"),
  contextNote: document.querySelector("#context-note"),
  message: document.querySelector("#message"),
  saveNickname: document.querySelector("#save-nickname"),
  saveSummary: document.querySelector("#save-summary"),
  saveContext: document.querySelector("#save-context"),
  sendMessage: document.querySelector("#send-message"),
  status: document.querySelector("#status"),
};

function contextLabel(peer) {
  const note = peer.context_note ? ` (${peer.context_note})` : "";
  if (peer.context_window && peer.context_used !== null && peer.context_used !== undefined) {
    return `${peer.context_used}/${peer.context_window}${note}`;
  }
  if (peer.context_window) return `${peer.context_window} window${note}`;
  return peer.context_note || "unknown";
}

function lastSeenLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function appendMeta(label, value) {
  if (!value && value !== 0) return;
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = String(value);
  els.peerMeta.append(dt, dd);
}

function setStatus(value) {
  els.status.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function api(path, options = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

function renderPeers() {
  els.count.textContent = String(state.peers.length);
  els.peers.replaceChildren();

  for (const peer of state.peers) {
    const tr = document.createElement("tr");
    if (state.selected?.id === peer.id) tr.classList.add("selected");
    tr.innerHTML = `
      <td>${peer.nickname || "(none)"}</td>
      <td>${peer.id}</td>
      <td><span class="machine">${peer.machine || "unknown"}</span></td>
      <td>${peer.tty || ""}</td>
      <td>${peer.pid}</td>
      <td>${contextLabel(peer)}</td>
      <td>${lastSeenLabel(peer.last_seen)}</td>
    `;
    tr.addEventListener("click", () => selectPeer(peer.id));
    els.peers.append(tr);
  }
}

function configureApiBase() {
  const next = prompt("API base URL", apiBase || window.location.origin);
  if (next === null) return;
  apiBase = next.replace(/\/$/, "");
  if (apiBase === window.location.origin) apiBase = "";
  if (apiBase) localStorage.setItem(API_BASE_KEY, apiBase);
  else localStorage.removeItem(API_BASE_KEY);
  refresh().catch((e) => setStatus(e.message));
}

function selectPeer(id) {
  state.selected = state.peers.find((peer) => peer.id === id) || null;
  const peer = state.selected;
  els.detailTitle.textContent = peer?.nickname || "Select Peer";
  els.selectedId.textContent = peer?.id || "";
  els.peerMeta.replaceChildren();
  if (peer) {
    appendMeta("Machine", peer.machine || "unknown");
    appendMeta("TTY", peer.tty || "unknown");
    appendMeta("PID", peer.pid);
    appendMeta("CWD", peer.cwd);
    appendMeta("Git Root", peer.git_root);
  }
  els.nickname.value = peer?.nickname || "";
  els.summary.value = peer?.summary || "";
  els.contextWindow.value = peer?.context_window ?? "";
  els.contextUsed.value = peer?.context_used ?? "";
  els.contextNote.value = peer?.context_note || "";
  renderPeers();
}

async function refresh() {
  const [health, result] = await Promise.all([
    api("/api/health"),
    api(`/api/peers?scope=${encodeURIComponent(els.scope.value)}`),
  ]);
  state.peers = result.peers || [];
  els.meta.textContent = `${health.machine} | ${health.cwd} | ${health.broker_url}`;
  if (state.selected) {
    state.selected = state.peers.find((peer) => peer.id === state.selected.id) || null;
  }
  renderPeers();
  if (state.selected) selectPeer(state.selected.id);
}

async function post(path, body) {
  const result = await api(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  setStatus(result);
  await refresh();
}

function selectedBody(extra = {}) {
  if (!state.selected) throw new Error("Select a peer first.");
  return { id: state.selected.id, ...extra };
}

els.refresh.addEventListener("click", () => refresh().catch((e) => setStatus(e.message)));
els.refresh.addEventListener("dblclick", configureApiBase);
els.scope.addEventListener("change", () => refresh().catch((e) => setStatus(e.message)));

els.saveNickname.addEventListener("click", () => {
  post("/api/nickname", selectedBody({ value: els.nickname.value })).catch((e) => setStatus(e.message));
});

els.saveSummary.addEventListener("click", () => {
  post("/api/summary", selectedBody({ value: els.summary.value })).catch((e) => setStatus(e.message));
});

els.saveContext.addEventListener("click", () => {
  post(
    "/api/context",
    selectedBody({
      context_window: els.contextWindow.value ? Number(els.contextWindow.value) : null,
      context_used: els.contextUsed.value ? Number(els.contextUsed.value) : null,
      context_note: els.contextNote.value,
    })
  ).catch((e) => setStatus(e.message));
});

els.sendMessage.addEventListener("click", () => {
  post("/api/message", selectedBody({ message: els.message.value })).catch((e) => setStatus(e.message));
});

refresh().catch((e) => setStatus(e.message));
setInterval(() => refresh().catch(() => {}), 30000);
