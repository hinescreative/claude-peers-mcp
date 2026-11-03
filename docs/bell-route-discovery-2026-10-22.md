# Route discovery, checked before the bell was built

2026-10-22, about 7:45 AM CDT. Nightly server `0.1.1-nightly.20261020.3386` on the Mac (`127.0.0.1:3773`). Source read: `~/hines/projects/t3code/packages/contracts/src/orchestration.ts` (`OrchestrationSession`, `OrchestrationThreadShell`) and `environmentHttp.ts`.

## What the orchestration HTTP API exposes

`GET /api/orchestration/shell` and `GET /api/orchestration/threads/:id` (bearer required; a no-token call returned 401). Per thread: id, title, project, worktree path, branch, provider, session status, latest turn state. The session object is status, provider, runtime mode, active turn id, and last error.

It does not expose a process pid, a Claude session id, or `--resume` / `--session-id`.

## What the machine has besides the API

Six live Claude processes under the T3 server (pid 2056) carried `--resume` plus a 36-character id. `provider_session_runtime.resume_cursor_json` has a `resume` string on 66 rows, also 36 characters. None of the six process ids were in that set.

The peers MCP child has `CLAUDE_CODE_SESSION_ID` in its environment. The Claude process environment visible with `ps -E` has no T3 thread id. A seat cannot learn its thread id by itself today.

## What the bell does with that

In order:

1. `routes.json` override (peer id to thread id, or a tmux target for a seat outside T3).
2. The peer's `runtime`, when the seat registered `t3:<threadId>` or `<harness>:t3:<threadId>`.
3. The peer's cwd against thread worktree paths. One match wins. Zero or several is `no-route`.

A send the bell cannot place comes back to the sender as `no-route`.
