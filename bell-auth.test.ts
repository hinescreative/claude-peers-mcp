import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadT3Auth } from "./bell.ts";

test("a T3 credential that is not mode 600 is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "bell-auth-"));
  const path = join(dir, "t3.json");
  writeFileSync(path, JSON.stringify({ baseUrl: "http://127.0.0.1:9", token: "x", environmentId: "e" }));
  chmodSync(path, 0o644);
  expect(() => loadT3Auth(path)).toThrow(/mode 600/);
  chmodSync(path, 0o600);
  expect(loadT3Auth(path).baseUrl).toBe("http://127.0.0.1:9");
});
