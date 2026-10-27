import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PEER_ID as BUTLER_PEER_ID, Mailbox, ringDoorbell } from "./butler-inbox-edge";
import { PEER_ID, requireEnv, ringLinksDoorbell, storeClaimed } from "./links-inbox-edge";

test("links identity stays separate from the butler inbox", () => {
  expect(PEER_ID).toBe("links-inbox");
  expect(BUTLER_PEER_ID).toBe("butler-inbox");
});

test("requireEnv rejects a missing value and does not invent one", () => {
  const name = "LINKS_INBOX_TEST_ABSENT";
  delete process.env[name];
  expect(() => requireEnv(name)).toThrow(`${name} is required`);
  process.env[name] = "present";
  try {
    expect(requireEnv(name)).toBe("present");
  } finally {
    delete process.env[name];
  }
});

test("storeClaimed keeps the row when ack fails or is short, then dedupes the retry", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".links-mail-"));
  try {
    const mail = new Mailbox(join(dir, "mail.sqlite"));
    const messages = [{ id: 7, kind: "notification", text: "link for Links: https://example.invalid/card-461" }];
    await expect(storeClaimed(mail, messages, async () => { throw new Error("down"); })).rejects.toThrow("down");
    expect(mail.unread().map((m) => m.id)).toEqual([7]);
    await expect(storeClaimed(mail, messages, async () => ({ acked: 0 }))).rejects.toThrow("broker ack incomplete");
    expect(mail.unread()).toHaveLength(1);
    let calls = 0;
    const n = await storeClaimed(mail, messages, async (ids) => {
      calls++;
      expect(ids).toEqual([7]);
      return { acked: 1 };
    });
    expect(n).toBe(1);
    expect(calls).toBe(1);
    expect(mail.unread().map((m) => m.text)).toEqual([messages[0].text]);
    mail.db.close();
  } finally { rmSync(dir, { recursive: true }); }
});

test("relay doorbell posts only the marker body and never logs the hook", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".links-relay-"));
  try {
    const mail = new Mailbox(join(dir, "mail.sqlite"));
    mail.save([{ id: 9, kind: "notification", text: "private mail" }]);
    const hook = "https://relay.t3.codes/v1/hooks/test-id/scheduled-task%3Aabc/test-token";
    writeFileSync(join(dir, "doorbell"), hook + "\n", { mode: 0o600 });
    const logs: string[] = [];
    let calls = 0;
    const post = (async (url: any, opts: any) => {
      calls++;
      expect(String(url)).toBe(hook);
      expect(opts.body).toBe('{"doorbell":true}');
      expect(opts.redirect).toBe("error");
      return new Response("", { status: 202 });
    }) as typeof fetch;
    const now = 5_000_000;
    await ringLinksDoorbell(mail, dir, now, post, (s) => logs.push(s));
    await ringLinksDoorbell(mail, dir, now + 1, post, (s) => logs.push(s));
    expect(calls).toBe(1);
    expect(logs).toEqual(["doorbell rang (202)"]);
    expect(logs.join(" ")).not.toContain("relay.t3.codes");
    writeFileSync(join(dir, "doorbell"), "https://evil.example/v1/hooks/test-id/test-token", { mode: 0o600 });
    await ringLinksDoorbell(mail, dir, now + 300_002, post, (s) => logs.push(s));
    expect(calls).toBe(1);
    expect(logs.at(-1)).toBe("invalid doorbell target");
    mail.db.close();
  } finally { rmSync(dir, { recursive: true }); }
});

test("doorbell refuses a group-readable hook file and does not post", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".links-bell-"));
  try {
    const mail = new Mailbox(join(dir, "mail.sqlite"));
    mail.save([{ id: 1, kind: "notification", text: "private" }]);
    writeFileSync(join(dir, "doorbell"), "/api/hooks/test-id/test-token", { mode: 0o644 });
    let calls = 0;
    const logs: string[] = [];
    const post = (async () => { calls++; return new Response("", { status: 202 }); }) as typeof fetch;
    await ringDoorbell(mail, dir, 1_800_000, post, (s) => logs.push(s));
    expect(calls).toBe(0);
    expect(logs).toEqual(["doorbell file unavailable or not mode 600"]);
    mail.db.close();
  } finally { rmSync(dir, { recursive: true }); }
});
