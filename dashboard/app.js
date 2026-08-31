const FRESH_GREEN_MS = 2 * 60 * 1000;
const FRESH_DEAD_MS = 20 * 60 * 1000;

/** broker peer.machine → Tailscale HostName. Apostrophes both ASCII and curly. */
const MACHINE_TO_HOSTS = {
  mac: ["macbook-air"],
  pc: ["wes"],
  imac: ["theoldone"],
  clarvis: ["clarvis's macbook air"],
  clarsmini: ["clars's mac mini"],
  cortext: ["clippy-wsl"],
  grater: ["cheesegrater"],
};

const FLEET_HOSTS = new Set(Object.values(MACHINE_TO_HOSTS).flat().map(norm));

const state = {
  peers: [],
  selected: null,
  tailnet: { backendState: "", self: null, peers: [] },
  view: "map",
};

const API_BASE_KEY = "claudePeersApiBase";
let apiBase = localStorage.getItem(API_BASE_KEY) || window.CLAUDE_PEERS_API_BASE || "";

const els = {
  meta: document.querySelector("#meta"),
  counts: document.querySelector("#counts"),
  map: document.querySelector("#map"),
  list: document.querySelector("#list"),
  viewMap: document.querySelector("#view-map"),
  viewList: document.querySelector("#view-list"),
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
  drawer: document.querySelector("#drawer"),
  drawerTitle: document.querySelector("#drawer-title"),
  drawerId: document.querySelector("#drawer-id"),
  drawerSummary: document.querySelector("#drawer-summary"),
  drawerMeta: document.querySelector("#drawer-meta"),
  drawerClose: document.querySelector("#drawer-close"),
};

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .trim();
}

function hostsForMachine(machine) {
  return (MACHINE_TO_HOSTS[norm(machine)] || []).map(norm);
}

function freshness(lastSeen) {
  if (!lastSeen) return "dead";
  const t = new Date(lastSeen).getTime();
  if (Number.isNaN(t) || t < 1e12) return "dead";
  const age = Date.now() - t;
  if (age < FRESH_GREEN_MS) return "green";
  if (age < FRESH_DEAD_MS) return "amber";
  return "dead";
}

function lastSeenLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 2000) return "now";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function contextLabel(peer) {
  const note = peer.context_note ? ` (${peer.context_note})` : "";
  if (peer.context_window && peer.context_used !== null && peer.context_used !== undefined) {
    return `${peer.context_used}/${peer.context_window}${note}`;
  }
  if (peer.context_window) return `${peer.context_window} window${note}`;
  return peer.context_note || "";
}

function appendMeta(root, label, value) {
  if (!value && value !== 0) return;
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = String(value);
  root.append(dt, dd);
}

function setStatus(value) {
  if (!els.status) return;
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

function allTsNodes() {
  const nodes = [];
  if (state.tailnet.self) nodes.push({ ...state.tailnet.self, self: true });
  for (const n of state.tailnet.peers || []) nodes.push({ ...n, self: false });
  return nodes;
}

function group() {
  const tsNodes = allTsNodes();
  const usedPeerIds = new Set();
  const fleetCards = [];
  const otherCards = [];

  for (const node of tsNodes) {
    const host = norm(node.hostName);
    const agents = state.peers.filter((p) => hostsForMachine(p.machine).includes(host));
    for (const a of agents) usedPeerIds.add(a.id);
    const isFleet = FLEET_HOSTS.has(host) || agents.length > 0;
    const card = { kind: "ts", node, agents, isFleet };
    (isFleet ? fleetCards : otherCards).push(card);
  }

  const leftover = new Map();
  for (const peer of state.peers) {
    if (usedPeerIds.has(peer.id)) continue;
    const key = peer.machine || "unknown";
    if (!leftover.has(key)) leftover.set(key, []);
    leftover.get(key).push(peer);
  }
  for (const [machine, agents] of leftover) {
    fleetCards.push({
      kind: "unmatched",
      node: { hostName: machine, online: false, os: "", ips: [], lastSeen: "", dnsName: "no tailscale host mapped" },
      agents,
      isFleet: true,
    });
  }

  fleetCards.sort((a, b) => Number(b.node.online) - Number(a.node.online) || a.node.hostName.localeCompare(b.node.hostName));
  otherCards.sort((a, b) => a.node.hostName.localeCompare(b.node.hostName));
  return { fleetCards, otherCards };
}

function renderMap() {
  els.map.replaceChildren();
  const { fleetCards, otherCards } = group();
  const liveHosts = [...fleetCards, ...otherCards].filter((c) => c.node.online).length;
  els.counts.textContent = `${state.peers.length} peers · ${liveHosts} boxes up`;

  function paint(card) {
    const el = document.createElement("article");
    el.className = card.isFleet ? "card" : "card other";
    const ip = (card.node.ips || []).find((x) => x.includes(".")) || (card.node.ips || [])[0] || "";
    const online = card.node.online;
    el.innerHTML = `
      <div class="card-head">
        <h3><span class="host-dot ${online ? "live" : "off"}"></span>${card.node.hostName || "(unnamed)"}</h3>
        <span class="ip">${online ? "up" : "down"} ${card.node.os || ""}</span>
      </div>
      <div class="ip">${ip}${card.node.self ? " · this page" : ""}</div>
    `;
    if (!card.agents.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = card.kind === "unmatched"
        ? "Broker peers, no Tailscale join"
        : "No broker peers";
      el.append(empty);
    }
    for (const peer of card.agents) {
      const row = document.createElement("div");
      row.className = "agent";
      const clamp = (peer.summary || "").replace(/\s+/g, " ").trim();
      row.innerHTML = `
        <span class="fresh ${freshness(peer.last_seen)}"></span>
        <div>
          <div class="agent-name">${peer.nickname || peer.id}</div>
          <div class="agent-id">${peer.id} · ${lastSeenLabel(peer.last_seen)}</div>
          <div class="agent-sum">${clamp}</div>
        </div>
      `;
      row.addEventListener("click", () => openDrawer(peer));
      el.append(row);
    }
    els.map.append(el);
  }

  for (const card of fleetCards) paint(card);
  if (otherCards.length) {
    const label = document.createElement("h2");
    label.textContent = "Other devices";
    label.style.gridColumn = "1 / -1";
    label.style.margin = "8px 0 0";
    els.map.append(label);
    for (const card of otherCards) paint(card);
  }
}

function renderPeers() {
  els.count.textContent = String(state.peers.length);
  els.peers.replaceChildren();
  for (const peer of state.peers) {
    const tr = document.createElement("tr");
    if (state.selected?.id === peer.id) tr.classList.add("selected");
    tr.innerHTML = `
      <td>${peer.nickname || "(none)"}</td>
      <td class="mono">${peer.id}</td>
      <td>${peer.machine || "unknown"}</td>
      <td>${peer.tty || ""}</td>
      <td>${peer.pid ?? ""}</td>
      <td>${contextLabel(peer)}</td>
      <td>${lastSeenLabel(peer.last_seen)}</td>
    `;
    tr.addEventListener("click", () => selectPeer(peer.id));
    els.peers.append(tr);
  }
}

function openDrawer(peer) {
  els.drawerTitle.textContent = peer.nickname || peer.id;
  els.drawerId.textContent = peer.id;
  els.drawerSummary.textContent = peer.summary || "";
  els.drawerMeta.replaceChildren();
  appendMeta(els.drawerMeta, "Machine", peer.machine);
  appendMeta(els.drawerMeta, "Last seen", peer.last_seen);
  appendMeta(els.drawerMeta, "CWD", peer.cwd);
  appendMeta(els.drawerMeta, "PID", peer.pid);
  els.drawer.showModal();
}

function selectPeer(id) {
  state.selected = state.peers.find((peer) => peer.id === id) || null;
  const peer = state.selected;
  els.detailTitle.textContent = peer?.nickname || "Select a peer";
  els.selectedId.textContent = peer?.id || "";
  els.peerMeta.replaceChildren();
  if (peer) {
    appendMeta(els.peerMeta, "Machine", peer.machine || "unknown");
    appendMeta(els.peerMeta, "TTY", peer.tty || "unknown");
    appendMeta(els.peerMeta, "PID", peer.pid);
    appendMeta(els.peerMeta, "CWD", peer.cwd);
    appendMeta(els.peerMeta, "Git root", peer.git_root);
  }
  els.nickname.value = peer?.nickname || "";
  els.summary.value = peer?.summary || "";
  els.contextWindow.value = peer?.context_window ?? "";
  els.contextUsed.value = peer?.context_used ?? "";
  els.contextNote.value = peer?.context_note || "";
  renderPeers();
}

function setView(view) {
  state.view = view;
  els.viewMap.classList.toggle("on", view === "map");
  els.viewList.classList.toggle("on", view === "list");
  els.map.classList.toggle("hidden", view !== "map");
  els.list.classList.toggle("hidden", view !== "list");
}

async function refresh() {
  const [health, result, tailnet] = await Promise.all([
    api("/api/health"),
    api("/api/peers?scope=fleet"),
    api("/api/tailnet").catch((e) => ({ error: e.message, self: null, peers: [] })),
  ]);
  state.peers = result.peers || [];
  if (!tailnet.error) state.tailnet = tailnet;
  const tsErr = tailnet.error ? ` · tailnet: ${tailnet.error}` : "";
  els.meta.textContent = `${health.machine} · ${state.peers.length} peers · ${state.tailnet.backendState || "tailnet ?"}${tsErr}`;
  if (state.selected) {
    state.selected = state.peers.find((peer) => peer.id === state.selected.id) || null;
  }
  renderMap();
  renderPeers();
  if (state.selected) selectPeer(state.selected.id);
}

async function post(path, body) {
  const result = await api(path, { method: "POST", body: JSON.stringify(body) });
  setStatus(result);
  await refresh();
}

function selectedBody(extra = {}) {
  if (!state.selected) throw new Error("Select a peer first.");
  return { id: state.selected.id, ...extra };
}

els.refresh.addEventListener("click", () => refresh().catch((e) => setStatus(e.message)));
els.viewMap.addEventListener("click", () => setView("map"));
els.viewList.addEventListener("click", () => setView("list"));
els.drawerClose.addEventListener("click", () => els.drawer.close());
els.saveNickname.addEventListener("click", () => {
  post("/api/nickname", selectedBody({ value: els.nickname.value })).catch((e) => setStatus(e.message));
});
els.saveSummary.addEventListener("click", () => {
  post("/api/summary", selectedBody({ value: els.summary.value })).catch((e) => setStatus(e.message));
});
els.saveContext.addEventListener("click", () => {
  post("/api/context", selectedBody({
    context_window: els.contextWindow.value ? Number(els.contextWindow.value) : null,
    context_used: els.contextUsed.value ? Number(els.contextUsed.value) : null,
    context_note: els.contextNote.value,
  })).catch((e) => setStatus(e.message));
});
els.sendMessage.addEventListener("click", () => {
  post("/api/message", selectedBody({ message: els.message.value })).catch((e) => setStatus(e.message));
});

setView("map");
refresh().catch((e) => {
  els.meta.textContent = e.message;
});
setInterval(() => refresh().catch(() => {}), 10000);
