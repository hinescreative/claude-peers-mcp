import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

setDefaultTimeout(5_000);

type JsonObject = Record<string, unknown>;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: unknown;
};

type BrokerRequest = {
  path: string;
  body: JsonObject;
};

type BrokerReply = {
  status?: number;
  json: unknown;
};

type BrokerHandler = (
  path: string,
  body: JsonObject,
  requests: readonly BrokerRequest[],
) => BrokerReply | undefined | Promise<BrokerReply | undefined>;

const activeHarnesses = new Set<ClientHarness>();
const realBrokerCleanups: Array<() => Promise<void>> = [];
const textEncoder = new TextEncoder();

function jsonResponse(reply: BrokerReply): Response {
  return Response.json(reply.json, { status: reply.status ?? 200 });
}

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function defaultBrokerReply(path: string, body: JsonObject): BrokerReply {
  switch (path) {
    case "/list-peers":
      return { json: [] };
    case "/heartbeat":
      return { json: { ok: true, found: true, owner: true } };
    case "/claim-messages":
    case "/poll-messages":
      return { json: { messages: [] } };
    case "/ack-messages":
      return {
        json: {
          ok: true,
          acked: Array.isArray(body.message_ids) ? body.message_ids.length : 0,
        },
      };
    case "/send-message":
    case "/set-nickname":
    case "/set-context":
    case "/set-summary":
    case "/set-state":
    case "/unregister":
      return { json: { ok: true } };
    default:
      return { status: 404, json: { error: "unexpected fake broker route" } };
  }
}

function providerKeysCleared(env: Record<string, string | undefined>) {
  return {
    ...env,
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    CLAUDE_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
    XAI_API_KEY: "",
  };
}

class ClientHarness {
  readonly requests: BrokerRequest[] = [];
  readonly rpcMessages: JsonRpcMessage[] = [];
  readonly events: string[] = [];
  readonly broker: ReturnType<typeof Bun.serve>;
  readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly doorbellDir = mkdtempSync(`${import.meta.dir}/.doorbell-test-`);

  private rpcId = 10;
  private stopped = false;
  private stderrText = "";
  private readonly spawnThroughParent: boolean;
  private readonly stdoutPump: Promise<void>;
  private readonly stderrPump: Promise<void>;

  constructor(
    handler: BrokerHandler,
    envOverrides: Record<string, string> = {},
    spawnThroughParent = false,
    preload?: string,
  ) {
    this.spawnThroughParent = spawnThroughParent;
    this.broker = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/health") {
          return Response.json({ ok: true });
        }

        if (request.method !== "POST") {
          return Response.json({ error: "method not allowed" }, { status: 405 });
        }

        const body = (await request.json()) as JsonObject;
        this.requests.push({ path: url.pathname, body });
        this.events.push(`broker:${url.pathname}`);
        return jsonResponse(
          await handler(url.pathname, body, this.requests) ??
            defaultBrokerReply(url.pathname, body),
        );
      },
    });

    const command = spawnThroughParent
      ? ["/bin/sh", "-c", "bun server.ts; exit $?"]
      : ["bun", ...(preload ? ["--preload", preload] : []), "server.ts"];
    this.process = Bun.spawn(command, {
      cwd: import.meta.dir,
      env: providerKeysCleared({
        ...process.env,
        CLAUDE_PEERS_BROKER_URL: `http://127.0.0.1:${this.broker.port}`,
        CLAUDE_PEERS_TOKEN: "",
        CLAUDE_PEERS_MACHINE: "server-protocol-testbox",
        CLAUDE_PEERS_NICKNAME: "server-protocol-test-client",
        CLAUDE_PEER_ID: "server-protocol-test-peer",
        CLAUDE_PEERS_DISABLE_CHANNEL: "0",
        CLAUDE_PEERS_DOORBELL_DIR: this.doorbellDir,
        // Never inherit the host session's inbox socket: the spawned server
        // would deliver test fixtures into the developer's live session.
        CLAUDE_CODE_MESSAGING_SOCKET: "",
        CLAUDE_CODE_MESSAGING_TOKEN: "",
        CLAUDE_PEERS_RESPONSE_DELAY_MS: "0",
        CLAUDE_PEERS_POLL_INTERVAL_MS: "20",
        CLAUDE_PEERS_HEARTBEAT_INTERVAL_MS: "35",
        CLAUDE_PEERS_REGISTER_RETRY_MS: "30",
        ...envOverrides,
      }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    this.stdoutPump = this.readRpcMessages(this.process.stdout);
    this.stderrPump = this.readStderr(this.process.stderr);
  }

  async initialize(): Promise<void> {
    await this.writeRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "server-protocol-integration-test", version: "1.0.0" },
      },
    });
    await waitUntil(
      () => this.rpcMessages.some((message) => message.id === 1),
      "MCP initialize response",
    );
    await this.writeRpc({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
  }

  requestsFor(path: string): BrokerRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  async waitForRequest(path: string, count = 1, timeoutMs = 1_000): Promise<void> {
    await waitUntil(
      () => this.requestsFor(path).length >= count,
      `${path} request ${count}`,
      timeoutMs,
    );
  }

  async waitForNotification(method: string, timeoutMs = 1_000): Promise<void> {
    await waitUntil(
      () => this.rpcMessages.some((message) => message.method === method),
      `${method} notification`,
      timeoutMs,
    );
  }

  async callTool(name: string, args: JsonObject): Promise<unknown> {
    const id = ++this.rpcId;
    await this.writeRpc({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    await waitUntil(
      () => this.rpcMessages.some((message) => message.id === id),
      `${name} tool response`,
    );
    const response = this.rpcMessages.find((message) => message.id === id);
    if (response?.error) {
      throw new Error(`${name} returned an MCP error`);
    }
    return response?.result;
  }

  async killParentOnly(): Promise<void> {
    if (!this.spawnThroughParent) {
      throw new Error("Harness was not started through a parent wrapper");
    }
    this.process.kill("SIGKILL");
    await this.process.exited;
  }

  async stop(): Promise<string> {
    if (this.stopped) return this.stderrText;
    this.stopped = true;

    if (this.spawnThroughParent) {
      const registeredPid = this.requestsFor("/register")[0]?.body.pid;
      if (typeof registeredPid === "number") {
        try {
          process.kill(registeredPid, "SIGTERM");
        } catch {
          // Server already exited after detecting its missing parent.
        }
      }
      await Bun.sleep(100);
    }

    if (this.process.exitCode === null) {
      this.process.kill("SIGTERM");
      const exited = await Promise.race([
        this.process.exited.then(() => true),
        Bun.sleep(750).then(() => false),
      ]);
      if (!exited) {
        this.process.kill("SIGKILL");
        await this.process.exited;
      }
    }

    await Promise.all([this.stdoutPump, this.stderrPump]);
    this.broker.stop(true);
    rmSync(this.doorbellDir, { recursive: true, force: true });
    activeHarnesses.delete(this);
    return this.stderrText;
  }

  private async writeRpc(message: JsonRpcMessage): Promise<void> {
    this.process.stdin.write(textEncoder.encode(`${JSON.stringify(message)}\n`));
    await this.process.stdin.flush();
  }

  private async readRpcMessages(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as JsonRpcMessage;
        this.rpcMessages.push(message);
        if (message.method) this.events.push(`rpc:${message.method}`);
      }
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      this.stderrText += decoder.decode(value, { stream: true });
    }
    this.stderrText += decoder.decode();
  }
}

async function startClient(
  handler: BrokerHandler,
  envOverrides: Record<string, string> = {},
  spawnThroughParent = false,
  preload?: string,
): Promise<ClientHarness> {
  const harness = new ClientHarness(handler, envOverrides, spawnThroughParent, preload);
  activeHarnesses.add(harness);
  await harness.initialize();
  return harness;
}

async function startRealBrokerClient(pollIntervalMs = "60000") {
  const dir = mkdtempSync(`${import.meta.dir}/.real-broker-test-`);
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const base = `http://127.0.0.1:${probe.port}`;
  const port = probe.port;
  probe.stop(true);
  const broker = Bun.spawn(["bun", "broker.ts"], {
    cwd: import.meta.dir,
    env: providerKeysCleared({
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: `${dir}/broker.db`,
      CLAUDE_PEERS_TOKEN: "",
      CLAUDE_PEERS_TOKENS: "",
      CLAUDE_PEERS_TOKENS_FILE: "",
      CLAUDE_PEERS_REQUIRE_AUTH: "",
      CLAUDE_CODE_MESSAGING_SOCKET: "",
      CLAUDE_CODE_MESSAGING_TOKEN: "",
      CLAUDE_PEERS_LEASE_TTL_MS: "30000",
      CLAUDE_PEERS_VISIBILITY_TIMEOUT_MS: "30000",
    }),
    stdout: "ignore",
    stderr: "ignore",
  });
  let db: Database | undefined;
  realBrokerCleanups.push(async () => {
    broker.kill();
    await broker.exited;
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (let attempt = 0; ; attempt++) {
    if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) break;
    if (attempt >= 80) throw new Error("isolated broker did not start");
    await Bun.sleep(25);
  }
  const post = async (path: string, body: JsonObject): Promise<BrokerReply> => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  const harness = await startClient(post, { CLAUDE_PEERS_POLL_INTERVAL_MS: pollIntervalMs });
  await harness.waitForRequest("/heartbeat");
  db = new Database(`${dir}/broker.db`);
  const registration = harness.requestsFor("/register")[0]!.body;
  const recipient = registration.requested_id as string;
  await post("/register", {
    requested_id: "real-broker-sender", pid: process.pid, cwd: dir,
    machine: "server-protocol-testbox", summary: "isolated test sender",
  });
  const send = async (count: number) => {
    const ids: number[] = [];
    for (let index = 0; index < count; index++) {
      const response = await post("/send-message", {
        from_id: "real-broker-sender", to_id: recipient, text: `real message ${index}`,
      });
      const result = response.json as JsonObject;
      if (response.status !== 200 || result.ok !== true) throw new Error("test send failed");
      ids.push(result.message_id as number);
    }
    return ids;
  };
  return { harness, db, send };
}

// Control the child process's reminder clock and response-delay timer without
// changing production configuration or waiting five minutes in real time.
class DeliveryClock {
  readonly dir = mkdtempSync(`${import.meta.dir}/.delivery-clock-`);
  readonly preload = `${this.dir}/preload.ts`;
  now = 1_800_000_000_000;

  constructor() {
    this.advance(0);
    writeFileSync(this.preload, `
      import { readFileSync, writeFileSync } from "node:fs";
      Date.now = () => Number(readFileSync(${JSON.stringify(`${this.dir}/now`)}, "utf8"));
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((callback, ms, ...args) => {
        if (ms !== 200) return realSetTimeout(callback, ms, ...args);
        const deadline = Date.now() + ms;
        writeFileSync(${JSON.stringify(`${this.dir}/delaying`)}, "held");
        const tick = () => Date.now() >= deadline
          ? callback(...args) : realSetTimeout(tick, 5);
        return realSetTimeout(tick, 5);
      });
    `);
  }

  advance(ms: number) {
    this.now += ms;
    writeFileSync(`${this.dir}/now`, String(this.now));
  }

  async waitForDelay() {
    await waitUntil(() => existsSync(`${this.dir}/delaying`), "response delay");
  }

  close() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

function expectLease(body: JsonObject, instanceId: string, leaseId: string): void {
  expect(body.instance_id === instanceId).toBe(true);
  expect(body.lease_id === leaseId).toBe(true);
}

afterEach(async () => {
  for (const harness of [...activeHarnesses]) {
    await harness.stop();
  }
  for (const cleanup of realBrokerCleanups.splice(0)) await cleanup();
});

describe("server.ts payload v2 delivery client", () => {
  test("real broker confirms all 101 acknowledgments in capped batches", async () => {
    const { harness, db, send } = await startRealBrokerClient();
    const ids = await send(101);
    const firstRead = JSON.stringify(await harness.callTool("check_messages", {}));
    const secondRead = JSON.stringify(await harness.callTool("check_messages", {}));
    expect(firstRead).toContain("100 new message(s)");
    expect(secondRead).toContain(`Message ID ${ids[100]},`);

    const result = await harness.callTool("ack_message", { message_ids: ids });
    expect(JSON.stringify(result)).toContain("Acknowledged 101 message(s).");
    expect(harness.requestsFor("/ack-messages").map((r) => r.body.message_ids)).toEqual([
      ids.slice(0, 100), ids.slice(100),
    ]);
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE delivered = 1").get()).toEqual({ count: 101 });
    expect(JSON.stringify(await harness.callTool("check_messages", {}))).toContain("No new messages.");
  });

  test("real broker partial acknowledgment retains buffered and reclaimable IDs", async () => {
    const { harness, db, send } = await startRealBrokerClient("20");
    const ids = await send(3);
    await waitUntil(() => harness.rpcMessages.filter(
      (m) => m.method === "notifications/claude/channel",
    ).length === 3, "three real messages buffered and pushed");
    // The real broker skips the middle ID but acknowledges the first and last.
    db.query("UPDATE messages SET claimed_by_lease_fingerprint = NULL WHERE id = ?").run(ids[1]!);
    const result = await harness.callTool("ack_message", { message_ids: ids });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(db.query("SELECT id FROM messages WHERE delivered = 0").all()).toEqual([{ id: ids[1] }]);
    // Before visibility expiry the unprocessed message must survive in the buffer.
    const buffered = JSON.stringify(await harness.callTool("check_messages", {}));
    expect(buffered).toContain("3 new message(s)");
    expect(buffered).toContain(`Message ID ${ids[1]},`);
    // After draining, the same ID must still be recoverable from a new claim.
    db.query("UPDATE messages SET claim_expires_at = NULL WHERE delivered = 0").run();
    expect(JSON.stringify(await harness.callTool("check_messages", {}))).toContain(`Message ID ${ids[1]},`);
    expect(JSON.stringify(await harness.callTool("ack_message", { message_ids: [ids[1]] }))).toContain("Acknowledged 1 message(s).");
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE delivered = 1").get()).toEqual({ count: 3 });
    expect(JSON.stringify(await harness.callTool("check_messages", {}))).toContain("No new messages.");
  });

  test("registers payload v2 with a nonempty per-process instance ID", async () => {
    const harness = await startClient((path) => {
      if (path === "/register") {
        return {
          json: {
            id: "server-protocol-test-peer",
            role: "owner",
            lease_id: "owner-lease-registration-test",
            lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
          },
        };
      }
    });

    await harness.waitForRequest("/register");
    const registration = harness.requestsFor("/register")[0]!.body;
    expect(registration.payload_version).toBe(2);
    expect(typeof registration.instance_id).toBe("string");
    expect((registration.instance_id as string).length).toBeGreaterThan(0);
  });

  test("claims, pushes, and acknowledges as owner with the lease on every operation", async () => {
    const incomingText = "private inbound payload must stay out of diagnostic logs";
    const leaseId = "owner-lease-flow-test";
    let claimServed = false;

    const harness = await startClient((path, body) => {
      if (path === "/register") {
        return {
          json: {
            id: "server-protocol-test-peer",
            role: "owner",
            lease_id: leaseId,
            lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
          },
        };
      }
      if (path === "/claim-messages") {
        if (claimServed) return { json: { messages: [] } };
        claimServed = true;
        return {
          json: {
            messages: [
              {
                id: 701,
                from_id: "fake-sender",
                to_id: "server-protocol-test-peer",
                text: incomingText,
                sent_at: "2026-09-01T12:00:00.000Z",
                delivered: false,
              },
            ],
          },
        };
      }
      if (path === "/ack-messages") {
        return {
          json: {
            ok: true,
            acked: Array.isArray(body.message_ids) ? body.message_ids.length : 0,
          },
        };
      }
    });

    await harness.waitForRequest("/register");
    const registration = harness.requestsFor("/register")[0]!.body;
    const instanceId = registration.instance_id as string;

    await harness.waitForRequest("/claim-messages", 1, 1_250);
    await harness.waitForNotification("notifications/claude/channel", 1_250);
    await Bun.sleep(100);
    expect(harness.requestsFor("/ack-messages")).toHaveLength(0);

    await harness.callTool("ack_message", { message_ids: [701] });
    await harness.waitForRequest("/ack-messages", 1, 1_250);
    await harness.waitForRequest("/heartbeat", 1, 1_250);

    await harness.callTool("set_nickname", { nickname: "leased-client" });
    await harness.callTool("set_context", {
      context_window: 200_000,
      context_used: 1_000,
      context_note: "protocol integration test",
    });
    await harness.callTool("set_summary", { summary: "protocol integration test" });
    await harness.callTool("send_message", {
      to_id: "fake-recipient",
      message: "outbound protocol test payload",
    });

    await harness.stop();
    await harness.waitForRequest("/unregister");

    for (const path of [
      "/claim-messages",
      "/ack-messages",
      "/heartbeat",
      "/set-nickname",
      "/set-context",
      "/set-summary",
      "/send-message",
      "/unregister",
    ]) {
      expectLease(harness.requestsFor(path)[0]!.body, instanceId, leaseId);
    }

    const ack = harness.requestsFor("/ack-messages")[0]!.body;
    expect(Array.isArray(ack.message_ids)).toBe(true);
    expect((ack.message_ids as number[]).includes(701)).toBe(true);

    const notificationEvent = harness.events.indexOf(
      "rpc:notifications/claude/channel",
    );
    const ackEvent = harness.events.indexOf("broker:/ack-messages");
    expect(notificationEvent).toBeGreaterThan(-1);
    expect(ackEvent).toBeGreaterThan(notificationEvent);

    const pushed = harness.rpcMessages.some(
      (message) =>
        message.method === "notifications/claude/channel" &&
        typeof message.params?.content === "string" &&
        (message.params.content as string).length === incomingText.length,
    );
    expect(pushed).toBe(true);
    expect((await harness.stop()).includes(incomingText)).toBe(false);
  });

  for (const transport of ["channel", "inbox"] as const) {
    test(`${transport} reminds at five minutes, retains manual reads, and stays empty after ack`, async () => {
      const clock = new DeliveryClock();
      const dir = mkdtempSync(`${import.meta.dir}/.inbox-test-`);
      const socketPath = `${dir}/inbox.sock`;
      const frames: string[] = [];
      const inbox = createServer(socket => {
        let data = "";
        socket.on("data", chunk => { data += chunk.toString(); });
        socket.on("end", () => { frames.push(data); });
      });
      try {
        if (transport === "inbox") {
          await new Promise<void>(resolve => inbox.listen(socketPath, resolve));
        }
        let serveClaims = true;
        const harness = await startClient((path) => {
          if (path === "/register") return { json: {
            id: "server-protocol-test-peer", role: "owner", lease_id: "dedupe-lease",
            lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
          } };
          // Repeated claims also model a claim already in flight when ack completes.
          if (path === "/claim-messages") return { json: { messages: serveClaims ? [{
            id: 704, from_id: "fake-sender", to_id: "server-protocol-test-peer",
            text: "recoverable dedupe payload", sent_at: "2026-10-19T17:16:00.000Z",
            delivered: false,
          }] : [] } };
        }, transport === "inbox" ? { CLAUDE_CODE_MESSAGING_SOCKET: socketPath } : {}, false, clock.preload);
        const pushes = () => transport === "inbox" ? frames.length :
          harness.rpcMessages.filter(m => m.method === "notifications/claude/channel").length;
        await waitUntil(() => pushes() > 0, "first push");
        await harness.waitForRequest("/claim-messages", 4);
        expect(pushes()).toBe(1);
        expect(JSON.stringify(await harness.callTool("check_messages", {}))).toContain("recoverable dedupe payload");
        clock.advance(299_999);
        await harness.waitForRequest("/claim-messages", harness.requestsFor("/claim-messages").length + 3);
        expect(pushes()).toBe(1);
        serveClaims = false;
        expect(JSON.stringify(await harness.callTool("check_messages", {}))).toContain("recoverable dedupe payload");
        serveClaims = true;
        clock.advance(1);
        await waitUntil(() => pushes() === 2, "five-minute reminder");
        await harness.waitForRequest("/claim-messages", harness.requestsFor("/claim-messages").length + 3);
        serveClaims = false;
        expect(JSON.stringify(await harness.callTool("check_messages", {}))).toContain("recoverable dedupe payload");
        serveClaims = true;
        await harness.waitForRequest("/claim-messages", harness.requestsFor("/claim-messages").length + 3);
        await harness.callTool("ack_message", { message_ids: [704] });
        serveClaims = false;
        expect(JSON.stringify(await harness.callTool("check_messages", {}))).toContain("No new messages.");
        // Expiring reminder timestamps must not expire the acknowledgment guard.
        serveClaims = true;
        clock.advance(300_000);
        const claims = harness.requestsFor("/claim-messages").length;
        await harness.waitForRequest("/claim-messages", claims + 3);
        serveClaims = false;
        expect(JSON.stringify(await harness.callTool("check_messages", {}))).toContain("No new messages.");
        expect(pushes()).toBe(2);
        await harness.stop();
      } finally {
        for (const harness of [...activeHarnesses]) await harness.stop();
        if (inbox.listening) await new Promise<void>(resolve => inbox.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
        clock.close();
      }
    });

    test(`${transport} cancels the first push when ack wins the response delay`, async () => {
      const clock = new DeliveryClock();
      const frames: string[] = [];
      const socketPath = `${clock.dir}/inbox.sock`;
      const inbox = createServer(socket => {
        let data = "";
        socket.on("data", chunk => { data += chunk.toString(); });
        socket.on("end", () => { frames.push(data); });
      });
      try {
        if (transport === "inbox") await new Promise<void>(resolve => inbox.listen(socketPath, resolve));
        const harness = await startClient(path => {
          if (path === "/register") return { json: {
            id: "server-protocol-test-peer", role: "owner", lease_id: "open-lease",
          } };
          if (path === "/claim-messages") return { json: { messages: [{
            id: 705, from_id: "fake-sender", to_id: "server-protocol-test-peer",
            text: "acked before first push", sent_at: "2026-10-19T17:16:00.000Z", delivered: false,
          }] } };
        }, {
          CLAUDE_PEERS_RESPONSE_DELAY_MS: "200",
          ...(transport === "inbox" ? { CLAUDE_CODE_MESSAGING_SOCKET: socketPath } : {}),
        }, false, clock.preload);
        await clock.waitForDelay();
        expect(JSON.stringify(await harness.callTool("check_messages", {}))).toContain("acked before first push");
        expect(JSON.stringify(await harness.callTool("ack_message", { message_ids: [705] }))).toContain("Acknowledged 1");
        expect(frames).toHaveLength(0);
        expect(harness.rpcMessages.filter(m => m.method === "notifications/claude/channel")).toHaveLength(0);
        clock.advance(200);
        await harness.waitForRequest("/claim-messages", harness.requestsFor("/claim-messages").length + 3);
        expect(JSON.stringify(await harness.callTool("check_messages", {}))).toContain("No new messages.");
        expect(frames).toHaveLength(0);
        expect(harness.rpcMessages.filter(m => m.method === "notifications/claude/channel")).toHaveLength(0);
      } finally {
        for (const harness of [...activeHarnesses]) await harness.stop();
        if (inbox.listening) await new Promise<void>(resolve => inbox.close(() => resolve()));
        clock.close();
      }
    });
  }

  for (const disabled of [false, true]) {
    test(`ack fences an in-flight poll and manual sender lookups (channel disabled=${disabled})`, async () => {
      const clock = new DeliveryClock();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let lookups = 0;
      try {
        const harness = await startClient(async path => {
          if (path === "/register") return { json: {
            id: "server-protocol-test-peer", role: "owner", lease_id: "lookup-lease",
          } };
          if (path === "/claim-messages") return { json: { messages: [{
            id: 706, from_id: "fake-sender", to_id: "server-protocol-test-peer",
            text: "acked during lookup", sent_at: "2026-10-19T17:16:00.000Z", delivered: false,
          }] } };
          if (path === "/list-peers") { lookups++; await gate; return { json: [] }; }
        }, {
          CLAUDE_PEERS_DISABLE_CHANNEL: disabled ? "1" : "0",
          CLAUDE_PEERS_DOORBELL_DIR: clock.dir,
        }, false, clock.preload);
        await waitUntil(() => lookups === 1, "poll sender lookup");
        const checking = harness.callTool("check_messages", {});
        await waitUntil(() => lookups === 2, "manual sender lookup");
        await harness.callTool("ack_message", { message_ids: [706] });
        release();
        expect(JSON.stringify(await checking)).toContain("No new messages.");
        await harness.waitForRequest("/claim-messages", harness.requestsFor("/claim-messages").length + 3);
        expect(JSON.stringify(await harness.callTool("check_messages", {}))).toContain("No new messages.");
        expect(harness.rpcMessages.filter(m => m.method === "notifications/claude/channel")).toHaveLength(0);
        expect(existsSync(`${clock.dir}/server-protocol-test-peer.log`)).toBe(false);
      } finally {
        release();
        for (const harness of [...activeHarnesses]) await harness.stop();
        clock.close();
      }
    });
  }

  test("standby retries without claiming or unregistering and takes ownership when granted", async () => {
    const leaseId = "standby-takeover-lease";
    let grantOwnership = false;

    const harness = await startClient((path) => {
      if (path === "/register") {
        if (!grantOwnership) {
          return {
            json: {
              id: "server-protocol-test-peer",
              role: "standby",
              lease_id: null,
              lease_expires_at: new Date(Date.now() + 50).toISOString(),
            },
          };
        }
        return {
          json: {
            id: "server-protocol-test-peer",
            role: "owner",
            lease_id: leaseId,
            lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
          },
        };
      }
    });

    await harness.waitForRequest("/register", 2, 700);
    expect(harness.requestsFor("/claim-messages").length).toBe(0);
    expect(harness.requestsFor("/unregister").length).toBe(0);

    grantOwnership = true;
    await harness.waitForRequest("/register", 3, 700);
    await harness.waitForRequest("/claim-messages", 1, 700);

    const registrations = harness.requestsFor("/register").map((request) => request.body);
    const instanceIds = registrations.map((body) => body.instance_id);
    expect(instanceIds.every((instanceId) => typeof instanceId === "string" && instanceId.length > 0)).toBe(true);
    expect(new Set(instanceIds).size).toBe(1);

    const instanceId = instanceIds[0] as string;
    expectLease(harness.requestsFor("/claim-messages")[0]!.body, instanceId, leaseId);

    await harness.stop();
    await harness.waitForRequest("/unregister");
    expectLease(harness.requestsFor("/unregister")[0]!.body, instanceId, leaseId);
  });

  test("manual checks retain broker recoverability until ack_message is called", async () => {
    const leaseId = "manual-check-lease";
    let claimServed = false;
    const harness = await startClient(
      (path, body) => {
        if (path === "/register") {
          return {
            json: {
              id: "server-protocol-test-peer",
              role: "owner",
              lease_id: leaseId,
              lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
            },
          };
        }
        if (path === "/claim-messages") {
          if (claimServed) return { json: { messages: [] } };
          claimServed = true;
          return {
            json: {
              messages: [
                {
                  id: 702,
                  from_id: "manual-sender",
                  to_id: "server-protocol-test-peer",
                  text: "manual receipt payload",
                  sent_at: "2026-09-01T12:01:00.000Z",
                  delivered: false,
                },
              ],
            },
          };
        }
        if (path === "/ack-messages") {
          return {
            json: {
              ok: true,
              acked: Array.isArray(body.message_ids) ? body.message_ids.length : 0,
            },
          };
        }
      },
      { CLAUDE_PEERS_DISABLE_CHANNEL: "1" },
    );

    await harness.waitForRequest("/register");
    await harness.callTool("check_messages", {});
    expect(harness.requestsFor("/ack-messages")).toHaveLength(0);

    await harness.callTool("ack_message", { message_ids: [702] });
    await harness.waitForRequest("/ack-messages");
    expect(harness.requestsFor("/ack-messages")[0]!.body.message_ids).toEqual([702]);
  });

  // The delivery notification names a single quoted id, so sessions call
  // ack_message with {message_id: "703"}. That used to error, nothing was
  // acked, and the broker redelivered the same message forever.
  test("ack_message accepts the singular message_id the notification asks for", async () => {
    const leaseId = "singular-ack-lease";
    let claimServed = false;
    const harness = await startClient(
      (path, body) => {
        if (path === "/register") {
          return {
            json: {
              id: "server-protocol-test-peer",
              role: "owner",
              lease_id: leaseId,
              lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
            },
          };
        }
        if (path === "/claim-messages") {
          if (claimServed) return { json: { messages: [] } };
          claimServed = true;
          return {
            json: {
              messages: [
                {
                  id: 703,
                  from_id: "singular-sender",
                  to_id: "server-protocol-test-peer",
                  text: "singular ack payload",
                  sent_at: "2026-09-01T12:02:00.000Z",
                  delivered: false,
                },
              ],
            },
          };
        }
        if (path === "/ack-messages") {
          return {
            json: {
              ok: true,
              acked: Array.isArray(body.message_ids) ? body.message_ids.length : 0,
            },
          };
        }
      },
      { CLAUDE_PEERS_DISABLE_CHANNEL: "1" },
    );

    await harness.waitForRequest("/register");
    await harness.callTool("check_messages", {});

    // Exactly the shape the notification text invites: singular, and a string.
    // Before the fix this errored and no /ack-messages call was ever made.
    await harness.callTool("ack_message", { message_id: "703" });
    await harness.waitForRequest("/ack-messages");
    expect(harness.requestsFor("/ack-messages")[0]!.body.message_ids).toEqual([703]);

    await harness.stop();
  });

  test("a standby whose parent dies during retry sleep cannot take ownership", async () => {
    let registrationCount = 0;
    const harness = await startClient(
      (path) => {
        if (path === "/register") {
          registrationCount += 1;
          if (registrationCount > 1) {
            return {
              json: {
                id: "server-protocol-test-peer",
                role: "owner",
                lease_id: "orphan-takeover-lease",
                lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
              },
            };
          }
          return {
            json: {
              id: "server-protocol-test-peer",
              role: "standby",
              lease_id: null,
              lease_expires_at: new Date(Date.now() + 500).toISOString(),
            },
          };
        }
      },
      {
        CLAUDE_PEERS_REGISTER_RETRY_MS: "250",
      },
      true,
    );

    await harness.waitForRequest("/register");
    await harness.killParentOnly();
    await Bun.sleep(400);
    expect(harness.requestsFor("/register")).toHaveLength(1);
    expect(harness.requestsFor("/claim-messages")).toHaveLength(0);
    expect(harness.requestsFor("/unregister")).toHaveLength(0);
  });

  test("falls back to legacy polling when a broker omits role and lease", async () => {
    const harness = await startClient((path) => {
      if (path === "/register") {
        return { json: { id: "server-protocol-test-peer" } };
      }
    });

    await harness.waitForRequest("/register");
    await harness.waitForRequest("/poll-messages", 1, 1_250);

    const registration = harness.requestsFor("/register")[0]!.body;
    expect(registration.payload_version).toBe(2);
    expect(typeof registration.instance_id).toBe("string");
    expect((registration.instance_id as string).length).toBeGreaterThan(0);
    expect(harness.requestsFor("/claim-messages").length).toBe(0);
  });
});
