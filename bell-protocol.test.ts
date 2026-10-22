import { expect, test } from "bun:test";
import { dispatchTimedOut, runStatus } from "./bell-dispatch.ts";
import { formatSendResult } from "./shared/message-contract.ts";
import {
  WAKE_TEXT,
  bellPeerId,
  loadAllowlist,
  loadBells,
  loadRouteTable,
  mergeRuntime,
  needsWake,
  nicknameDecision,
  normalizeRuntime,
  parentChanged,
  planDispatch,
  resolveRoute,
  retryDispatch,
  routeIsFresh,
  shouldReaskBase,
} from "./bell-protocol.ts";

const THREAD = "mcp:36a41ff7-8eef-49ab-a947-55027c14f468";
const OTHER = "6d5c4e27-9ccd-4284-9654-b96791e53ed6";

test("runtime carries a harness and an optional thread id", () => {
  expect(normalizeRuntime("codex")).toBe("codex");
  expect(normalizeRuntime(`codex:t3:${THREAD}`)).toBe(`codex:t3:${THREAD}`);
  expect(normalizeRuntime(`t3:${THREAD}`)).toBe(`t3:${THREAD}`);
  expect(normalizeRuntime("claude:t3:not-a-thread")).toBeNull();
  expect(normalizeRuntime("has space")).toBeNull();
  expect(normalizeRuntime(12)).toBeNull();
});

test("a live socket seat is not woken; a codex seat and a missing seat are", () => {
  expect(needsWake({ present: true, stale: false, runtime: "claude" })).toBe(false);
  expect(needsWake({ present: true, stale: false, runtime: null })).toBe(false);
  expect(needsWake({ present: true, stale: false, runtime: "codex" })).toBe(true);
  expect(needsWake({ present: true, stale: false, runtime: `cursor:t3:${THREAD}` })).toBe(true);
  expect(needsWake({ present: false, stale: true, runtime: "claude" })).toBe(true);
  expect(needsWake({ present: true, stale: true, runtime: "claude" })).toBe(true);
});

test("routes prefer an override, then a registered thread, then one worktree", () => {
  const threads = [
    { id: THREAD, worktreePath: "/work/shaw" },
    { id: OTHER, worktreePath: "/work/shaw" },
    { id: "mcp:11111111-1111-4111-8111-111111111111", worktreePath: "/work/only", latestTurnState: "running" },
  ];
  const ambiguous = resolveRoute({ peerId: "codex-shaw", cwd: "/work/shaw", threads });
  expect("error" in ambiguous && ambiguous.error).toBe("no-route");
  expect(resolveRoute({
    peerId: "codex-only",
    cwd: "/work/only/",
    threads,
  })).toEqual({ kind: "thread", threadId: "mcp:11111111-1111-4111-8111-111111111111" });
  expect(resolveRoute({
    peerId: "codex-shaw",
    cwd: "/work/shaw",
    runtime: `codex:t3:${THREAD}`,
    threads,
  })).toEqual({ kind: "thread", threadId: THREAD });
  expect(resolveRoute({
    peerId: "brady",
    cwd: "/somewhere",
    overrides: { brady: { tmux: "pc-grok:0" } },
    threads,
  })).toEqual({ kind: "tmux", target: "pc-grok:0" });
  expect(resolveRoute({
    peerId: "pinned",
    overrides: { pinned: { threadId: OTHER } },
    threads,
  })).toEqual({ kind: "thread", threadId: OTHER });
});

test("a running turn queues; a released thread starts", () => {
  expect(planDispatch("running")).toEqual({ type: "queue_after_active" });
  expect(planDispatch("completed")).toEqual({ type: "start_immediately" });
  expect(planDispatch(null)).toEqual({ type: "start_immediately" });
  expect(WAKE_TEXT).toBe("peers mail waiting; run check_messages");
});

test("nicknames are unique among live peers, and assistant is reserved", () => {
  const allowlist = loadAllowlist('{"assistant":"mac-assistant-claude-no-tty"}');
  const live = [
    { id: "mac-other", nickname: "Fable" },
    { id: "mac-assistant-claude-no-tty", nickname: "assistant" },
  ];
  expect(nicknameDecision({ callerId: "mac-new", nickname: "Fable", live, allowlist }).ok).toBe(false);
  expect(nicknameDecision({ callerId: "mac-other", nickname: "Fable", live, allowlist })).toEqual({ ok: true, clearIds: [] });
  expect(nicknameDecision({ callerId: "mac-new", nickname: "Assistant", live, allowlist })).toEqual({
    ok: false,
    error: "nickname reserved",
  });
  const takeback = nicknameDecision({
    callerId: "mac-assistant-claude-no-tty",
    nickname: "assistant",
    live: [...live, { id: "mac-impostor", nickname: "assistant" }],
    allowlist,
  });
  expect(takeback).toEqual({ ok: true, clearIds: ["mac-impostor"] });
  expect(nicknameDecision({ callerId: "mac-new", nickname: "   ", live, allowlist })).toEqual({ ok: true, clearIds: [] });
});

const FORK = "mcp:3e3e7dbd-4ab2-454b-8ae2-cebf0a87193c:fork";

test("a T3 fork id is a thread id, in a route file and in a runtime", () => {
  const routes = loadRouteTable(JSON.stringify({ routes: { "mac-assistant-claude-no-tty": { threadId: FORK } } }));
  expect(routes["mac-assistant-claude-no-tty"]?.threadId).toBe(FORK);
  expect(normalizeRuntime(`claude:t3:${FORK}`)).toBe(`claude:t3:${FORK}`);
  expect(resolveRoute({ peerId: "mac-assistant-claude-no-tty", overrides: routes, threads: [{ id: FORK }] })).toEqual({
    kind: "thread",
    threadId: FORK,
  });
});

test("an archived thread is not a route, and its cwd does not fall through to a survivor", () => {
  const original = "mcp:11111111-1111-4111-8111-111111111111";
  const survivor = "mcp:22222222-2222-4222-8222-222222222222:fork";
  const threads = [
    { id: original, worktreePath: "/work/assistant", archivedAt: "2026-10-22T00:00:00Z" },
    { id: survivor, worktreePath: "/work/assistant" },
  ];
  const byPath = resolveRoute({ peerId: "mac-assistant-claude-no-tty", cwd: "/work/assistant", threads });
  const byRuntime = resolveRoute({ peerId: "mac-assistant-claude-no-tty", runtime: `claude:t3:${original}`, threads });
  const only = resolveRoute({ peerId: "kept", cwd: "/work/only", threads: [{ id: OTHER, worktreePath: "/work/only" }] });
  expect("error" in byPath && byPath.error).toBe("no-route");
  expect("error" in byRuntime && byRuntime.error).toBe("no-route");
  expect("threadId" in only && only.threadId).toBe(OTHER);
});

test("a dead owner lease needs a wake, and a poll-only claude seat is not a push seat", () => {
  expect(needsWake({ present: true, stale: false, runtime: "claude", ownerLive: false })).toBe(true);
  expect(needsWake({ present: true, stale: false, runtime: "claude", ownerLive: true })).toBe(false);
  expect(needsWake({ present: true, stale: false, runtime: "poll" })).toBe(true);
});

test("a refresh keeps a bound thread id, and a stale route is not fresh", () => {
  expect(mergeRuntime("claude", `claude:t3:${FORK}`)).toBe(`claude:t3:${FORK}`);
  expect(mergeRuntime(`codex:t3:${OTHER}`, `claude:t3:${FORK}`)).toBe(`codex:t3:${OTHER}`);
  expect(routeIsFresh(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString())).toBe(false);
  expect(routeIsFresh(new Date().toISOString())).toBe(true);
});

test("a lost dispatch response is not retried, and a parent change is noticed", () => {
  expect(retryDispatch("start_immediately", "running")).toBe("queue");
  expect(retryDispatch("start_immediately", null)).toBe("abort");
  expect(retryDispatch("start_immediately", "completed")).toBe("abort");
  expect(retryDispatch("queue_after_active", "running")).toBe("abort");
  expect(parentChanged(10, 11)).toBe(true);
  expect(parentChanged(10, 10)).toBe(false);
  expect(parentChanged(1, 50)).toBe(false);
  expect(shouldReaskBase("mac-assistant-claude-no-tty", "mac-assistant-claude-no-tty-ab12")).toBe(true);
  expect(shouldReaskBase("mac-assistant-claude-no-tty", "mac-assistant-claude-no-tty")).toBe(false);
});

test("turn state is read from projection.runs, and a timeout is not a retry", () => {
  expect(runStatus({ projection: { runs: [{ ordinal: 1, status: "completed" }, { ordinal: 2, status: "running" }] } })).toBe("running");
  expect(runStatus({ activityRunStatus: "running" })).toBe("running");
  expect(dispatchTimedOut(new Error("RPC orchestration.dispatchCommand timed out"))).toBe(true);
  expect(dispatchTimedOut(new Error("HTTP 409"))).toBe(false);
  const hidden = formatSendResult("mac-box", { ok: true, message_id: 4, wake: "no-route" });
  expect(hidden.text).toContain("wake: no-route");
  expect(hidden.isError).toBe(true);
});

test("a fork is not a cwd match, and a path that has held two threads is not either", () => {
  const survivor = "mcp:22222222-2222-4222-8222-222222222222:fork";
  const only = resolveRoute({
    cwd: "/work/assistant",
    threads: [{ id: survivor, worktreePath: "/work/assistant" }],
  });
  expect("error" in only && only.error).toBe("no-route");
  const plain = "mcp:33333333-3333-4333-8333-333333333333";
  const crowded = resolveRoute({
    cwd: "/work/only",
    threads: [{ id: plain, worktreePath: "/work/only" }],
    seenOnPath: [plain, "mcp:44444444-4444-4444-8444-444444444444"],
  });
  expect("error" in crowded && crowded.error).toBe("no-route");
  const fresh = resolveRoute({
    cwd: "/work/only",
    threads: [{ id: plain, worktreePath: "/work/only" }],
    seenOnPath: [plain],
  });
  expect("threadId" in fresh && fresh.threadId).toBe(plain);
});

test("a suffixed respawn can reclaim a reserved name only after the base seat is gone", () => {
  const allowlist = loadAllowlist('{"assistant":"mac-assistant-claude-no-tty"}');
  const live = [{ id: "mac-assistant-claude-no-tty", nickname: "Grok" }];
  expect(nicknameDecision({
    callerId: "mac-assistant-claude-no-tty-ab12",
    nickname: "assistant",
    live,
    allowlist,
  }).ok).toBe(false);
  expect(nicknameDecision({
    callerId: "mac-assistant-claude-no-tty-ab12",
    nickname: "assistant",
    live: [],
    allowlist,
  }).ok).toBe(true);
});

test("bell files reject a bad url, a bad route, and a nameless reservation", () => {
  expect(bellPeerId("mac")).toBe("bell-mac");
  expect(bellPeerId("MacBook-Air.local")).toBe("bell-MacBook-Air-local");
  expect(loadBells('{"bells":{"mac":"http://100.103.170.84:8812"}}')).toEqual({ mac: "http://100.103.170.84:8812" });
  expect(() => loadBells('{"mac":"http://user:pw@127.0.0.1:8812"}')).toThrow(/credentials/);
  expect(() => loadRouteTable('{"routes":{"ok-peer":{"threadId":"nope"}}}')).toThrow(/bad thread id/);
  const routes = loadRouteTable(`{"routes":{"codex-a":{"threadId":"${THREAD}"}}}`);
  expect(routes["codex-a"]?.threadId).toBe(THREAD);
});
