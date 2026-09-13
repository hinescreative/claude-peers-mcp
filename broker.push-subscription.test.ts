import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(5_000);

const probe = Bun.serve({
  port: 0,
  fetch() {
    return new Response("");
  },
});
const PORT = probe.port;
probe.stop(true);

const DB = `/tmp/claude-peers-push-${process.pid}.db`;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "push-subscription-test-token";

let broker: ReturnType<typeof Bun.spawn> | null = null;

type JsonObject = Record<string, unknown>;
type SseEvent = { event: string; data: JsonObject };

async function post(path: string, body: JsonObject, authenticated = true) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authenticated) headers.Authorization = `Bearer ${TOKEN}`;
  const response = await fetch(BASE + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    json: contentType.includes("application/json")
      ? ((await response.json()) as JsonObject)
      : {},
  };
}

async function subscribe(body: JsonObject, authenticated = true) {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  };
  if (authenticated) headers.Authorization = `Bearer ${TOKEN}`;
  return fetch(BASE + "/subscribe-messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function registration(requestedId: string, instanceId: string, pid: number) {
  return {
    payload_version: 2,
    requested_id: requestedId,
    instance_id: instanceId,
    pid,
    cwd: `/tmp/${requestedId}`,
    git_root: null,
    tty: null,
    machine: "push-subscription-testbox",
    summary: "push subscription integration test",
  };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(BASE + "/health");
      if (response.ok) return;
    } catch {
      // Broker has not started listening yet.
    }
    await Bun.sleep(25);
  }
  throw new Error("isolated broker did not start");
}

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffered = "";

  constructor(response: Response) {
    if (!response.body) throw new Error("SSE response has no body");
    this.reader = response.body.getReader();
  }

  async nextEvent(timeoutMs = 1_000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frameEnd = this.buffered.indexOf("\n\n");
      if (frameEnd >= 0) {
        const frame = this.buffered.slice(0, frameEnd);
        this.buffered = this.buffered.slice(frameEnd + 2);
        const eventLine = frame.split("\n").find((line) => line.startsWith("event:"));
        const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
        if (!eventLine || !dataLine) continue;
        return {
          event: eventLine.slice("event:".length).trim(),
          data: JSON.parse(dataLine.slice("data:".length).trim()) as JsonObject,
        };
      }

      const remaining = deadline - Date.now();
      const result = await Promise.race([
        this.reader.read(),
        Bun.sleep(remaining).then(() => ({ timeout: true }) as const),
      ]);
      if ("timeout" in result) throw new Error("Timed out waiting for SSE event");
      if (result.done) throw new Error("SSE stream ended before the next event");
      this.buffered += this.decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
    }
    throw new Error("Timed out waiting for SSE event");
  }

  async cancel(): Promise<void> {
    await this.reader.cancel();
  }
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Bun.file(DB + suffix).delete();
    } catch {
      // No prior isolated database file.
    }
  }

  broker = Bun.spawn(["bun", "broker.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(PORT),
      CLAUDE_PEERS_DB: DB,
      CLAUDE_PEERS_TOKEN: TOKEN,
      CLAUDE_PEERS_REQUIRE_AUTH: "1",
      CLAUDE_PEERS_LEASE_TTL_MS: "500",
      CLAUDE_PEERS_VISIBILITY_TIMEOUT_MS: "100",
      CLAUDE_PEERS_PUSH_KEEPALIVE_MS: "50",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForHealth();
});

afterAll(async () => {
  broker?.kill();
  if (broker) await broker.exited;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Bun.file(DB + suffix).delete();
    } catch {
      // Ignore already-removed SQLite artifacts.
    }
  }
});

describe("leased server-push subscriptions", () => {
  test("requires broker authentication and a current receiver lease", async () => {
    const receiver = await post(
      "/register",
      registration("push-auth-receiver", "push-auth-instance", 61001),
    );
    const credentials = {
      id: "push-auth-receiver",
      instance_id: "push-auth-instance",
      lease_id: receiver.json.lease_id,
    };

    const unauthenticated = await subscribe(credentials, false);
    expect(unauthenticated.status).toBe(401);

    const wrongLease = await subscribe({ ...credentials, lease_id: "wrong-lease" });
    expect(wrongLease.status).toBe(409);
  });

  test("replays retained messages and pushes later messages on one open request", async () => {
    await post("/register", {
      requested_id: "push-live-sender",
      pid: 62001,
      cwd: "/tmp/push-live-sender",
      git_root: null,
      tty: null,
      machine: "push-subscription-testbox",
      summary: "isolated push sender",
    });
    const receiver = await post(
      "/register",
      registration("push-live-receiver", "push-live-instance", 62002),
    );
    const credentials = {
      id: "push-live-receiver",
      instance_id: "push-live-instance",
      lease_id: receiver.json.lease_id,
    };

    await post("/send-message", {
      from_id: "push-live-sender",
      to_id: "push-live-receiver",
      text: "queued while subscriber is offline",
    });

    const response = await subscribe(credentials);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = new SseReader(response);
    expect((await stream.nextEvent()).event).toBe("ready");
    const queued = await stream.nextEvent();
    expect(queued.event).toBe("message");
    expect(queued.data.text).toBe("queued while subscriber is offline");

    await post("/send-message", {
      from_id: "push-live-sender",
      to_id: "push-live-receiver",
      text: "pushed after subscription opened",
    });
    const pushed = await stream.nextEvent();
    expect(pushed.event).toBe("message");
    expect(pushed.data.text).toBe("pushed after subscription opened");

    const ack = await post("/ack-messages", {
      ...credentials,
      message_ids: [queued.data.id, pushed.data.id],
    });
    expect(ack.json).toMatchObject({ ok: true, acked: 2 });
    await stream.cancel();
  });

  test("redelivers an unacked message on reconnect and never replays it after ack", async () => {
    await post("/register", {
      requested_id: "push-retry-sender",
      pid: 63001,
      cwd: "/tmp/push-retry-sender",
      git_root: null,
      tty: null,
      machine: "push-subscription-testbox",
      summary: "isolated retry sender",
    });
    const receiver = await post(
      "/register",
      registration("push-retry-receiver", "push-retry-instance", 63002),
    );
    const credentials = {
      id: "push-retry-receiver",
      instance_id: "push-retry-instance",
      lease_id: receiver.json.lease_id,
    };
    await post("/send-message", {
      from_id: "push-retry-sender",
      to_id: "push-retry-receiver",
      text: "retry me until acknowledged",
    });

    const first = new SseReader(await subscribe(credentials));
    await first.nextEvent();
    const original = await first.nextEvent();
    await first.cancel();

    const second = new SseReader(await subscribe(credentials));
    await second.nextEvent();
    const redelivery = await second.nextEvent();
    expect(redelivery.data.id).toBe(original.data.id);
    const ack = await post("/ack-messages", {
      ...credentials,
      message_ids: [redelivery.data.id],
    });
    expect(ack.json).toMatchObject({ ok: true, acked: 1 });
    await second.cancel();

    const third = new SseReader(await subscribe(credentials));
    await third.nextEvent();
    await expect(third.nextEvent(180)).rejects.toThrow("Timed out waiting for SSE event");
    await third.cancel();
  });
});
