import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { deliverWake, wakeFailure, wakeSeat, type WakeOutcome } from "./bell.ts";
import { dispatchTimedOut, runStatus, T3_HTTP_TIMEOUT_MS } from "./bell-dispatch.ts";
import { formatSendResult, SEND_DEADLINE_MS } from "./shared/message-contract.ts";
import {
  WAKE_TEXT,
  bellPeerId,
  keepWake,
  loadBells,
  loadRouteTable,
  mergeRuntime,
  needsWake,
  normalizeRuntime,
  parentChanged,
  planDispatch,
  resolveRoute,
  retryDispatch,
  routeIsFresh,
  shareWake,
  wakeCommandId,
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
  const onlyPath = "/Users/wesleyhines/.t3/worktrees/proof/only";
  expect(resolveRoute({
    peerId: "codex-only",
    cwd: onlyPath + "/",
    threads: threads.map((thread) => thread.worktreePath === "/work/only" ? { ...thread, worktreePath: onlyPath } : thread),
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
  const keptPath = "/Users/wesleyhines/.t3/worktrees/kept/only";
  const only = resolveRoute({ peerId: "kept", cwd: keptPath, threads: [{ id: OTHER, worktreePath: keptPath }] });
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

test("only a single live worktree thread matches by path; a project root does not", () => {
  const plain = "mcp:33333333-3333-4333-8333-333333333333";
  const root = resolveRoute({
    cwd: "/Users/wesleyhines/hines/assistant-claude",
    threads: [{ id: plain, worktreePath: "/Users/wesleyhines/hines/assistant-claude" }],
  });
  expect("error" in root && root.error).toBe("no-route");
  const worktree = "/Users/wesleyhines/.t3/worktrees/bell-proof/codex";
  const fork = resolveRoute({
    cwd: worktree,
    threads: [{ id: "mcp:22222222-2222-4222-8222-222222222222:fork", worktreePath: worktree }],
  });
  expect("error" in fork && fork.error).toBe("no-route");
  const one = resolveRoute({
    cwd: worktree,
    threads: [{ id: plain, worktreePath: worktree }],
  });
  expect("threadId" in one && one.threadId).toBe(plain);
});

test("wakeCommandId is stable for a message id", () => {
  expect(wakeCommandId(42)).toBe(wakeCommandId(42));
  expect(wakeCommandId(42)).not.toBe(wakeCommandId(43));
  expect(wakeCommandId(42)[14]).toBe("5");
});

test("a no-route is not cached, so a corrected routes file wakes on retry", async () => {
  const thread = "mcp:36a41ff7-8eef-49ab-a947-55027c14f468";
  const memory = new Map<string, { at: number; result: Promise<WakeOutcome> }>();
  let routes: Record<string, { threadId: string }> = {};
  let calls = 0;
  const deliver = (body: any, commandId: string | null) => deliverWake({
    body,
    commandId,
    overrides: routes,
    threads: [{ id: thread, worktreePath: null, archivedAt: null, latestTurnState: null }],
    shellFailed: false,
    authOk: true,
    ring: async () => {},
    dispatch: async () => {
      calls += 1;
      return { dispatchMode: "start_immediately" };
    },
  });
  const body = {
    to_id: "mac-shaw-plumbing-no-tty",
    cwd: "/Users/wesleyhines/hines/shaw",
    runtime: "codex",
    message_id: 7,
  };
  const first = await wakeSeat(memory, body, deliver);
  expect(first).toEqual({ ok: false, error: "no-route" });
  expect(calls).toBe(0);
  routes = { "mac-shaw-plumbing-no-tty": { threadId: thread } };
  const second = await wakeSeat(memory, body, deliver);
  expect(second.ok).toBe(true);
  expect(second.threadId).toBe(thread);
  expect(calls).toBe(1);
  const third = await wakeSeat(memory, body, deliver);
  expect(third.ok).toBe(true);
  expect(calls).toBe(1);
});

test("a timeout after the command is sent is kept, and an earlier failure is not", () => {
  expect(keepWake({ ok: true })).toBe(true);
  expect(keepWake(wakeFailure(new Error("RPC orchestration.dispatchCommand timed out")))).toBe(true);
  expect(keepWake(wakeFailure(new Error("WebSocket open timed out")))).toBe(false);
  expect(keepWake(wakeFailure(new Error("HTTP 500 at /api/auth/websocket-ticket")))).toBe(false);
  expect(keepWake({ ok: false, error: "no-route" })).toBe(false);
  expect(keepWake({ ok: false, error: "credential-unavailable" })).toBe(false);
});

test("one message shares one wake outcome", async () => {
  const memory = new Map<string, { at: number; result: Promise<string> }>();
  let calls = 0;
  const run = () => {
    calls += 1;
    return Promise.resolve("sent");
  };
  const [first, second] = await Promise.all([
    shareWake(memory, "9", 1_000, 600_000, run),
    shareWake(memory, "9", 1_000, 600_000, run),
  ]);
  expect(first).toBe("sent");
  expect(second).toBe("sent");
  expect(calls).toBe(1);
  const later = await shareWake(memory, "9", 1_000 + 60_000, 600_000, run);
  expect(later).toBe("sent");
  expect(calls).toBe(1);
});

test("T3 HTTP calls give up at 3 seconds", () => {
  expect(T3_HTTP_TIMEOUT_MS).toBe(3_000);
  const source = readFileSync(new URL("./bell-dispatch.ts", import.meta.url), "utf8");
  expect(source).toContain("AbortSignal.timeout(T3_HTTP_TIMEOUT_MS)");
  expect(source).toContain("T3_HTTP_TIMEOUT_MS);");
  expect(source).not.toContain("15000");
  expect(source).not.toContain("crypto.randomUUID");
});

test("senders wait 10 seconds and print the wake line", () => {
  expect(SEND_DEADLINE_MS).toBe(10_000);
  const sent = formatSendResult("codex-only", { ok: true, message_id: 8, wake: "sent" });
  expect(sent.text).toContain("wake: sent");
  expect(sent.isError).toBe(false);
  const cli = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
  const direct = readFileSync(new URL("./codex-direct.ts", import.meta.url), "utf8");
  for (const source of [cli, direct]) {
    expect(source).toContain("AbortSignal.timeout(SEND_DEADLINE_MS)");
    expect(source).toContain("formatSendResult");
  }
});

test("bell files reject a bad url and a bad route", () => {
  expect(bellPeerId("mac")).toBe("bell-mac");
  expect(bellPeerId("MacBook-Air.local")).toBe("bell-MacBook-Air-local");
  expect(loadBells('{"bells":{"mac":"http://100.103.170.84:8812"}}')).toEqual({ mac: "http://100.103.170.84:8812" });
  expect(() => loadBells('{"mac":"http://user:pw@127.0.0.1:8812"}')).toThrow(/credentials/);
  expect(() => loadRouteTable('{"routes":{"ok-peer":{"threadId":"nope"}}}')).toThrow(/bad thread id/);
  const routes = loadRouteTable(`{"routes":{"codex-a":{"threadId":"${THREAD}"}}}`);
  expect(routes["codex-a"]?.threadId).toBe(THREAD);
});
