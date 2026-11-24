import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcClient, RpcError, type EventBus, type SubagentInfo } from "../src/rpc.js";

type Handler = (data: unknown) => void;
type Request = Record<string, unknown> & { requestId: string };

class MockBus implements EventBus {
  private readonly handlers = new Map<string, Set<Handler>>();
  readonly emissions: Array<{ event: string; payload: unknown }> = [];

  on(event: string, handler: Handler): () => void {
    const listeners = this.handlers.get(event) ?? new Set<Handler>();
    listeners.add(handler);
    this.handlers.set(event, listeners);
    return () => {
      listeners.delete(handler);
      if (listeners.size === 0 && this.handlers.get(event) === listeners) {
        this.handlers.delete(event);
      }
    };
  }

  emit(event: string, payload: unknown): void {
    this.emissions.push({ event, payload });
    for (const handler of Array.from(this.handlers.get(event) ?? [])) handler(payload);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  requests(name: string): Request[] {
    return this.emissions
      .filter(entry => entry.event === `subagents:rpc:${name}`)
      .map(entry => asRequest(entry.payload));
  }
}

function asRequest(payload: unknown): Request {
  assert.ok(typeof payload === "object" && payload !== null && "requestId" in payload);
  assert.equal(typeof payload.requestId, "string");
  return payload as Request;
}

function agent(id: string, status = "running"): SubagentInfo {
  return {
    id,
    type: "worker",
    description: "Test worker",
    status,
    depth: 0,
    startedAt: 1,
    durationMs: 0,
    toolUses: 0,
  };
}

class FakeSubagents {
  readonly agents = new Map<string, SubagentInfo>();
  readonly spawns: Request[] = [];
  readonly consumed: string[] = [];
  pingData: unknown = { version: 2, features: ["consume", "steer", "get", "list"] };

  constructor(bus: MockBus) {
    const handle = (name: string, respond: (request: Request) => unknown) => {
      const channel = `subagents:rpc:${name}`;
      bus.on(channel, payload => {
        const request = asRequest(payload);
        bus.emit(`${channel}:reply:${request.requestId}`, respond(request));
      });
    };

    handle("ping", () => ({ success: true, data: this.pingData }));
    handle("spawn", request => {
      this.spawns.push(request);
      const id = `agent-${this.spawns.length}`;
      this.agents.set(id, agent(id));
      return { success: true, data: { id } };
    });
    handle("stop", request => {
      const info = this.agents.get(String(request.agentId));
      if (!info) return { success: false, error: "Agent not found" };
      info.status = "stopped";
      return { success: true, data: { settled: true } };
    });
    handle("consume", request => {
      this.consumed.push(String(request.agentId));
      return { success: true };
    });
    handle("steer", request => {
      const info = this.agents.get(String(request.agentId));
      return info?.status === "running"
        ? { success: true }
        : { success: false, error: "Agent is not running" };
    });
    handle("get", request => {
      const info = this.agents.get(String(request.agentId));
      return info
        ? { success: true, data: { agent: { ...info } } }
        : { success: false, error: "Agent not found" };
    });
    handle("list", () => ({ success: true, data: { agents: [...this.agents.values()] } }));
  }
}

function fixture() {
  const bus = new MockBus();
  const fake = new FakeSubagents(bus);
  const client = new RpcClient(bus);
  return { bus, fake, client };
}

function reply(bus: MockBus, name: string, request: Request, envelope: unknown): void {
  bus.emit(`subagents:rpc:${name}:reply:${request.requestId}`, envelope);
}

function assertLifecycleCleanup(bus: MockBus): void {
  assert.equal(bus.listenerCount("subagents:completed"), 0);
  assert.equal(bus.listenerCount("subagents:failed"), 0);
}

test("ensureProtocol caches the handshake and exposes advertised features", async () => {
  const { bus, client, fake } = fixture();
  assert.equal(client.protocol, undefined);
  assert.equal(client.hasFeature("consume"), false);
  const info = await client.ensureProtocol();
  assert.deepEqual(info, fake.pingData);
  assert.equal(client.protocol, info);
  assert.equal(client.hasFeature("consume"), true);
  assert.equal(client.hasFeature("other"), false);
  assert.equal(await client.ensureProtocol(), info);
  assert.equal(bus.requests("ping").length, 1);
});

test("a rejected handshake can be retried against a v2 build without features", async () => {
  const { fake, client } = fixture();
  fake.pingData = { version: 1 };
  await assert.rejects(client.ensureProtocol(), {
    name: "RpcError",
    message: "unsupported pi-subagents protocol version 1, expected 2",
  });
  assert.equal(client.protocol, undefined);
  fake.pingData = { version: 2 };
  assert.deepEqual(await client.ensureProtocol(), { version: 2, features: [] });
});

test("spawn passes through type, prompt and options", async () => {
  const { fake, client } = fixture();
  const options = { model: "provider/model", isolation: "worktree", inheritContext: false } as const;
  assert.deepEqual(await client.spawn("worker", "review", options), { id: "agent-1" });
  const [request] = fake.spawns;
  assert.ok(request);
  assert.deepEqual(request, { requestId: request.requestId, type: "worker", prompt: "review", options });
});

test("overlapping spawns accept only their own replies, including out-of-order failures", async () => {
  const bus = new MockBus();
  const client = new RpcClient(bus);
  const first = client.spawn("worker", "first");
  const second = client.spawn("worker", "second");
  const third = client.spawn("worker", "third");
  const [firstRequest, secondRequest, thirdRequest] = bus.requests("spawn");
  assert.ok(firstRequest && secondRequest && thirdRequest);
  assert.equal(new Set([firstRequest.requestId, secondRequest.requestId, thirdRequest.requestId]).size, 3);

  reply(bus, "spawn", thirdRequest, { success: false, error: "Queue full" });
  reply(bus, "spawn", secondRequest, { success: true, data: { id: "second-id" } });
  reply(bus, "spawn", firstRequest, { success: true, data: { id: "first-id" } });
  await assert.rejects(third, { name: "RpcError", message: "Queue full" });
  assert.deepEqual(await Promise.all([first, second]), [{ id: "first-id" }, { id: "second-id" }]);
  for (const request of bus.requests("spawn")) {
    assert.equal(bus.listenerCount(`subagents:rpc:spawn:reply:${request.requestId}`), 0);
  }
});

test("request timeout removes the listener from the exact reply channel", async () => {
  const bus = new MockBus();
  const client = new RpcClient(bus, { timeoutMs: 30 });
  const pending = client.spawn("worker", "review");
  const [request] = bus.requests("spawn");
  assert.ok(request);
  const channel = `subagents:rpc:spawn:reply:${request.requestId}`;
  assert.equal(bus.listenerCount(channel), 1);
  await assert.rejects(pending, (error: unknown) =>
    error instanceof RpcError && error.message === "subagents RPC timed out: subagents:rpc:spawn");
  assert.equal(bus.listenerCount(channel), 0);
});

test("malformed envelopes and invalid spawn or stop data reject", async () => {
  const bus = new MockBus();
  const client = new RpcClient(bus);
  for (const envelope of [null, { success: 1 }, { success: false }, { success: true, data: { id: 1 } }]) {
    const pending = client.spawn("worker", "review");
    const requests = bus.requests("spawn");
    const request = requests[requests.length - 1];
    assert.ok(request);
    reply(bus, "spawn", request, envelope);
    const message = envelope?.success === true
      ? "malformed spawn reply"
      : "malformed RPC reply on subagents:rpc:spawn";
    await assert.rejects(pending, { name: "RpcError", message });
    assert.equal(bus.listenerCount(`subagents:rpc:spawn:reply:${request.requestId}`), 0);
  }
  const pending = client.stop("worker");
  const [request] = bus.requests("stop");
  assert.ok(request);
  reply(bus, "stop", request, { success: true, data: { settled: 1 } });
  await assert.rejects(pending, { name: "RpcError", message: "malformed stop reply" });
});

test("stop includes the settle timeout only when supplied", async () => {
  const { fake, client, bus } = fixture();
  fake.agents.set("worker", agent("worker"));
  assert.deepEqual(await client.stop("worker"), { settled: true });
  assert.deepEqual(await client.stop("worker", 0), { settled: true });
  const [first, second] = bus.requests("stop");
  assert.ok(first && second);
  assert.deepEqual(first, { requestId: first.requestId, agentId: "worker" });
  assert.deepEqual(second, { requestId: second.requestId, agentId: "worker", settleTimeoutMs: 0 });
});

test("consume tolerates a missing handler and server errors", async () => {
  const bus = new MockBus();
  const client = new RpcClient(bus, { timeoutMs: 30 });
  assert.equal(await client.consume("worker"), undefined);
  const [request] = bus.requests("consume");
  assert.ok(request);
  assert.equal(bus.listenerCount(`subagents:rpc:consume:reply:${request.requestId}`), 0);

  bus.on("subagents:rpc:consume", payload => {
    reply(bus, "consume", asRequest(payload), { success: false, error: "Agent not found" });
  });
  assert.equal(await client.consume("worker"), undefined);
});

test("consumeSync dispatches immediately without a reply listener and tolerates bus errors", () => {
  const { bus, client, fake } = fixture();
  bus.on("subagents:rpc:consume", () => { throw new Error("listener failed"); });
  assert.doesNotThrow(() => client.consumeSync("worker"));
  assert.deepEqual(fake.consumed, ["worker"]);
  const [request] = bus.requests("consume");
  assert.ok(request);
  assert.equal(bus.listenerCount(`subagents:rpc:consume:reply:${request.requestId}`), 0);
});

test("steer, get and list round-trip and preserve server errors", async () => {
  const { fake, client, bus } = fixture();
  const running = agent("worker");
  fake.agents.set(running.id, running);
  assert.equal(await client.steer(running.id, "summarize"), undefined);
  const [request] = bus.requests("steer");
  assert.ok(request);
  assert.deepEqual(request, { requestId: request.requestId, agentId: running.id, message: "summarize" });
  assert.deepEqual(await client.get(running.id), running);
  assert.deepEqual(await client.list(), [running]);
  await assert.rejects(client.get("missing"), { name: "RpcError", message: "Agent not found" });
  await client.stop(running.id);
  await assert.rejects(client.steer(running.id, "continue"), { name: "RpcError", message: "Agent is not running" });
});

test("completion consumes during dispatch and ignores other agents", async () => {
  const { bus, client, fake } = fixture();
  const pending = client.waitForCompletion("worker");
  bus.emit("subagents:completed", { ...agent("other", "completed"), result: "irrelevant" });
  assert.deepEqual(fake.consumed, []);

  const completed = { ...agent("worker", "completed"), result: "" };
  bus.on("subagents:completed", () => assert.deepEqual(fake.consumed, ["worker"]));
  bus.emit("subagents:completed", completed);
  assert.deepEqual(await pending, completed);
  assert.equal(bus.requests("get").length, 1);
  assert.equal(bus.listenerCount("subagents:completed"), 1);
  assert.equal(bus.listenerCount("subagents:failed"), 0);
});

test("a terminal initial lookup resolves and consumes without an event", async () => {
  const { bus, client, fake } = fixture();
  const stopped = agent("worker", "stopped");
  fake.agents.set(stopped.id, stopped);
  assert.deepEqual(await client.waitForCompletion(stopped.id), stopped);
  assert.deepEqual(fake.consumed, [stopped.id]);
  assertLifecycleCleanup(bus);
});

test("a failed event resolves with its error when both lookups fail", async () => {
  const { bus, client, fake } = fixture();
  const pending = client.waitForCompletion("worker");
  await new Promise<void>(resolve => setImmediate(resolve));
  const failed = { ...agent("worker", "failed"), error: "out of turns" };
  bus.emit("subagents:failed", failed);
  assert.deepEqual(fake.consumed, ["worker"]);
  assert.deepEqual(await pending, failed);
  assert.equal(bus.requests("get").length, 2);
  assertLifecycleCleanup(bus);
});

test("an event without a result wins over a pending initial lookup and fetches only the result", async () => {
  const bus = new MockBus();
  const client = new RpcClient(bus);
  const pending = client.waitForCompletion("worker");
  const completed = { ...agent("worker", "completed"), durationMs: 42 };
  bus.emit("subagents:completed", completed);
  bus.emit("subagents:failed", { ...agent("worker", "failed"), error: "duplicate" });
  assert.deepEqual(bus.requests("consume").map(request => request.agentId), ["worker"]);
  const [initial, fallback] = bus.requests("get");
  assert.ok(initial && fallback);
  reply(bus, "get", initial, { success: true, data: { agent: agent("worker", "stopped") } });
  reply(bus, "get", fallback, {
    success: true,
    data: { agent: { ...agent("worker", "completed"), result: "report" } },
  });
  assert.deepEqual(await pending, { ...completed, result: "report" });
  assertLifecycleCleanup(bus);
});

test("wait timeout removes lifecycle and outstanding lookup listeners", async () => {
  const bus = new MockBus();
  const client = new RpcClient(bus);
  const pending = client.waitForCompletion("worker", { timeoutMs: 30 });
  assert.equal(bus.listenerCount("subagents:completed"), 1);
  assert.equal(bus.listenerCount("subagents:failed"), 1);
  await assert.rejects(pending, (error: unknown) => error instanceof RpcError && /timed out/.test(error.message));
  assertLifecycleCleanup(bus);
  const [lookup] = bus.requests("get");
  assert.ok(lookup);
  assert.equal(bus.listenerCount(`subagents:rpc:get:reply:${lookup.requestId}`), 0);
});

test("an already-aborted wait issues no lookup and leaves no listeners", async () => {
  const bus = new MockBus();
  const client = new RpcClient(bus);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.waitForCompletion("worker", { signal: controller.signal }),
    (error: unknown) => error instanceof RpcError && /aborted/.test(error.message));
  assert.deepEqual(bus.emissions, []);
  assertLifecycleCleanup(bus);
});

test("abort during result lookup removes both lookup listeners and lifecycle listeners", async () => {
  const bus = new MockBus();
  const client = new RpcClient(bus);
  const controller = new AbortController();
  const pending = client.waitForCompletion("worker", { signal: controller.signal });
  bus.emit("subagents:completed", agent("worker", "completed"));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof RpcError && /aborted/.test(error.message));
  assertLifecycleCleanup(bus);
  const lookups = bus.requests("get");
  assert.equal(lookups.length, 2);
  for (const lookup of lookups) {
    assert.equal(bus.listenerCount(`subagents:rpc:get:reply:${lookup.requestId}`), 0);
  }
});
