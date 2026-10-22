import { expect, test } from "bun:test";
import { shouldWakeLead } from "./grok-edge.ts";

test("lead-wake still runs for the old offline errors and for the new wake statuses", () => {
  expect(shouldWakeLead({ ok: false, error: "Peer mac-shaw-plumbing-no-tty not found" })).toBe(true);
  expect(shouldWakeLead({ ok: false, error: "Peer mac-shaw-plumbing-no-tty is stale" })).toBe(true);
  expect(shouldWakeLead({ ok: false, error: "peer not found or stale" })).toBe(true);
  expect(shouldWakeLead({ ok: true, wake: "no-route" })).toBe(true);
  expect(shouldWakeLead({ ok: false, error: "no-route" })).toBe(true);
  expect(shouldWakeLead({ ok: true, wake: "unconfigured" })).toBe(true);
  expect(shouldWakeLead({ ok: true, wake: "pending" })).toBe(false);
  expect(shouldWakeLead({ ok: true, wake: "sent" })).toBe(false);
  expect(shouldWakeLead({ ok: false, error: "send failed" })).toBe(false);
});
