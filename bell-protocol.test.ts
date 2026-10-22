import { expect, test } from "bun:test";
import {
  WAKE_TEXT,
  bellPeerId,
  loadAllowlist,
  loadBells,
  loadRouteTable,
  needsWake,
  nicknameDecision,
  normalizeRuntime,
  planDispatch,
  resolveRoute,
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

test("bell files reject a bad url, a bad route, and a nameless reservation", () => {
  expect(bellPeerId("mac")).toBe("bell-mac");
  expect(bellPeerId("MacBook-Air.local")).toBe("bell-MacBook-Air-local");
  expect(loadBells('{"bells":{"mac":"http://100.103.170.84:8812"}}')).toEqual({ mac: "http://100.103.170.84:8812" });
  expect(() => loadBells('{"mac":"http://user:pw@127.0.0.1:8812"}')).toThrow(/credentials/);
  expect(() => loadRouteTable('{"routes":{"ok-peer":{"threadId":"nope"}}}')).toThrow(/bad thread id/);
  const routes = loadRouteTable(`{"routes":{"codex-a":{"threadId":"${THREAD}"}}}`);
  expect(routes["codex-a"]?.threadId).toBe(THREAD);
});
