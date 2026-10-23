import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { SEND_DEADLINE_MS } from "./shared/message-contract.ts";
import { shouldWakeLead } from "./grok-edge.ts";

test("lead-wake still runs for the old offline errors and for the new wake statuses", () => {
  expect(shouldWakeLead({ ok: false, error: "Peer mac-shaw-plumbing-no-tty not found" })).toBe(true);
  expect(shouldWakeLead({ ok: false, error: "Peer mac-shaw-plumbing-no-tty is stale" })).toBe(true);
  expect(shouldWakeLead({ ok: false, error: "peer not found or stale" })).toBe(true);
  expect(shouldWakeLead({ ok: true, wake: "no-route" })).toBe(true);
  expect(shouldWakeLead({ ok: false, error: "no-route" })).toBe(true);
  expect(shouldWakeLead({ ok: true, wake: "unconfigured" })).toBe(true);
  expect(shouldWakeLead({ ok: true, wake: "sent" })).toBe(false);
  expect(shouldWakeLead({ ok: false, error: "send failed" })).toBe(false);
});

test("the edge uses the 10 second broker deadline", () => {
  expect(SEND_DEADLINE_MS).toBe(10_000);
  expect(readFileSync(new URL("./grok-edge.ts", import.meta.url), "utf8")).toContain("AbortSignal.timeout(SEND_DEADLINE_MS)");
});
