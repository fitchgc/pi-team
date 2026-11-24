import assert from "node:assert/strict";
import test from "node:test";
import {
  RpcClient,
  RpcError,
  type EventBus,
  type SubagentInfo,
} from "../src/rpc.js";

type Handler = (data: unknown) => void;

class MockBus implements EventBus {
  private readonly handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: (data: any) => void): () => void {
    let listeners = this.handlers.get(event);
    if (!listeners) {
      listeners = new Set();
      this.handlers.set(event, listeners);
    }
    const wrapped: Handler = handler;
    listeners.add(wrapped);
    return () => {
      listeners?.delete(wrapped);
      if (listeners?.size === 0) this.handlers.delete(event);
    };
  }

  emit(event: string, payload: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      handler(payload);
    }
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  totalListenerCount(): number {
    let total = 0;
    for (const listeners of this.handlers.values()) total += listeners.size;
    return total;
  }
}

interface RpcRequest extends Record<string, unknown> {
  requestId: string;
}

class FakeSubagents {
  readonly requests = new Map<string, Record<string, unknown>[]>();
  readonly agents = new Map<string, SubagentInfo>();
  readonly consumed: string[] = [];
  protocolVersion = 2;
  protocolFeatures: string[] | undefined = ["consume", "steer", "get", "list"];
  omitConsumeHandler = false;
  private nextId = 1;

  constructor(readonly bus: MockBus) {
    this.on("ping", (request) => ({
      version: this.protocolVersion,
      ...(this.protocolFeatures === undefined ? {} : { features: this.protocolFeatures }),
    }));
    this.on("spawn", (request) => {
      const id = `agent-${this.nextId++}`;
      const info = this.agent(id, "running");
      this.agents.set(id, info);
      return { id };
    });
    this.on("stop", () => ({ settled: true }));
    if (!this.omitConsumeHandler) {
      this.on("consume", (request) => {
        this.consumed.push(String(request.agentId));
        return undefined;
      });
    }
    this.on("steer", () => undefined);
    this.on("get", (request) => {
      const info = this.agents.get(String(request.agentId));
      if (!info) return { error: "Agent not found" };
      return info;
    });
    this.on("list", () => ({ agents: [...this.agents.values()] }));
  }

  private on(
    name: string,
    respond: (request: RpcRequest) => unknown,
  ): void {
    this.bus.on(`subagents:rpc:${name}`, (value: unknown) => {
      if (name === "consume" && this.omitConsumeHandler) return;
      if (typeof value !== "object" || value === null || !("requestId" in value)) return;
      const request = value as RpcRequest;
      this.requests.set(name, [...(this.requests.get(name) ?? []), request]);
      const result = respond(request);
      if (name === "get" && isErrorResult(result)) {
        this.bus.emit(`subagents:rpc:${name}:reply:${request.requestId}`, {
          success: false,
          error: result.error,
        });
        return;
      }
      this.bus.emit(`subagents:rpc:${name}:reply:${request.requestId}`, {
        success: true,
        ...(name === "get" ? { data: { agent: result } } : result === undefined ? {} : { data: result }),
      });
    });
  }

  agent(id: string, status: string, result?: string, error?: string): SubagentInfo {
    return {
      id,
      type: "worker",
      description: "test agent",
      status,
      depth: 0,
      startedAt: 1,
      durationMs: 1,
      toolUses: 0,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    };
  }

  setAgent(info: SubagentInfo): void {
    this.agents.set(info.id, info);
  }

  complete(info: SubagentInfo): void {
    this.agents.set(info.id, info);
    this.bus.emit("subagents:completed", info);
  }

  fail(info: SubagentInfo): void {
    this.agents.set(info.id, info);
    this.bus.emit("subagents:failed", info);
  }
}

function isErrorResult(value: unknown): value is { error: string } {
  return typeof value === "object"
    && value !== null
    && "error" in value
    && typeof value.error === "string";
}

test("ensureProtocol returns and caches protocol data, rejects unsupported versions, and defaults features", async () => {
  const bus = new MockBus();
  const fake = new FakeSubagents(bus);
  const client = new RpcClient(bus, { timeoutMs: 50 });

  assert.deepEqual(await client.ensureProtocol(), { version: 2, features: ["consume", "steer", "get", "list"] });
  assert.equal(fake.requests.get("ping")?.length, 1);
  assert.equal(client.hasFeature("consume"), true);
  await client.ensureProtocol();
  assert.equal(fake.requests.get("ping")?.length, 1);

  const oldBus = new MockBus();
  const oldFake = new FakeSubagents(oldBus);
  oldFake.protocolVersion = 1;
  await assert.rejects(new RpcClient(oldBus, { timeoutMs: 50 }).ensureProtocol(), {
    name: "RpcError",
    message: "unsupported pi-subagents protocol version 1, expected 2",
  });

  const noFeaturesBus = new MockBus();
  const noFeaturesFake = new FakeSubagents(noFeaturesBus);
  noFeaturesFake.protocolFeatures = undefined;
  assert.deepEqual(await new RpcClient(noFeaturesBus, { timeoutMs: 50 }).ensureProtocol(), {
    version: 2,
    features: [],
  });
});

test("spawn uses unique request IDs, forwards arguments, and rejects server errors", async () => {
  const bus = new MockBus();
  const fake = new FakeSubagents(bus);
  const client = new RpcClient(bus, { timeoutMs: 50 });
  const options = { model: "provider/modelId", maxTurns: 3 };

  const [first, second] = await Promise.all([
    client.spawn("coder", "prompt one", options),
    client.spawn("reviewer", "prompt two"),
  ]);
  assert.deepEqual(first, { id: "agent-1" });
  assert.deepEqual(second, { id: "agent-2" });
  const requests = fake.requests.get("spawn") ?? [];
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0]?.requestId, requests[1]?.requestId);
  assert.equal(requests[0]?.type, "coder");
  assert.equal(requests[0]?.prompt, "prompt one");
  assert.deepEqual(requests[0]?.options, options);

  const failedBus = new MockBus();
  failedBus.on("subagents:rpc:spawn", (value: unknown) => {
    if (typeof value === "object" && value !== null && "requestId" in value) {
      const request = value as RpcRequest;
      failedBus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, {
        success: false,
        error: "spawn denied",
      });
    }
  });
  await assert.rejects(new RpcClient(failedBus, { timeoutMs: 50 }).spawn("coder", "prompt"), {
    name: "RpcError",
    message: "spawn denied",
  });
});

test("request timeout rejects and removes the reply listener", async () => {
  const bus = new MockBus();
  const client = new RpcClient(bus, { timeoutMs: 20 });
  const spawning = client.spawn("coder", "prompt");
  await assert.rejects(spawning, (error: unknown) => error instanceof RpcError
    && error.message === "subagents RPC timed out: subagents:rpc:spawn");
  assert.equal(bus.totalListenerCount(), 0);
});

test("stop returns settled and forwards settleTimeoutMs only when supplied", async () => {
  const bus = new MockBus();
  const fake = new FakeSubagents(bus);
  const client = new RpcClient(bus, { timeoutMs: 50 });

  assert.deepEqual(await client.stop("agent-1", 123), { settled: true });
  assert.equal(fake.requests.get("stop")?.[0]?.settleTimeoutMs, 123);
  await client.stop("agent-2");
  assert.equal("settleTimeoutMs" in (fake.requests.get("stop")?.[1] ?? {}), false);
});

test("consume ignores timeout and consumeSync emits immediately without throwing", async () => {
  const bus = new MockBus();
  const client = new RpcClient(bus, { timeoutMs: 10 });
  await assert.doesNotReject(client.consume("missing"));

  const observed: string[] = [];
  bus.on("subagents:rpc:consume", () => observed.push("consume"));
  assert.doesNotThrow(() => client.consumeSync("agent-1"));
  assert.deepEqual(observed, ["consume"]);
});

test("steer, get, and list round-trip; get propagates unknown-agent errors", async () => {
  const bus = new MockBus();
  const fake = new FakeSubagents(bus);
  const client = new RpcClient(bus, { timeoutMs: 50 });
  const info = fake.agent("agent-1", "running");
  fake.setAgent(info);

  await client.steer("agent-1", "change direction");
  assert.deepEqual(await client.get("agent-1"), info);
  assert.deepEqual(await client.list(), [info]);
  await assert.rejects(client.get("unknown"), { name: "RpcError", message: "Agent not found" });
});

test("waitForCompletion consumes synchronously and resolves completed info", async () => {
  const bus = new MockBus();
  const fake = new FakeSubagents(bus);
  const client = new RpcClient(bus, { timeoutMs: 100 });
  const agent = fake.agent("agent-1", "running");
  fake.setAgent(agent);
  const wait = client.waitForCompletion(agent.id);
  const completed = fake.agent(agent.id, "completed", "done");
  fake.complete(completed);

  assert.equal((await wait).result, "done");
  assert.deepEqual(fake.consumed, [agent.id]);
});

test("waitForCompletion resolves initially terminal and failed-event records", async () => {
  const bus = new MockBus();
  const fake = new FakeSubagents(bus);
  const client = new RpcClient(bus, { timeoutMs: 100 });
  const completed = fake.agent("agent-1", "completed", "already done");
  fake.setAgent(completed);
  assert.equal((await client.waitForCompletion(completed.id)).result, "already done");
  assert.deepEqual(fake.consumed, [completed.id]);

  const running = fake.agent("agent-2", "running");
  fake.setAgent(running);
  const waiting = client.waitForCompletion(running.id);
  const failed = fake.agent(running.id, "failed", undefined, "broken");
  fake.fail(failed);
  const result = await waiting;
  assert.equal(result.status, "failed");
  assert.equal(result.error, "broken");
});

test("waitForCompletion rejects on timeout and pre-aborted signal", async () => {
  const bus = new MockBus();
  const client = new RpcClient(bus, { timeoutMs: 20 });
  const waiting = client.waitForCompletion("missing");
  await assert.rejects(waiting, { name: "RpcError", message: "waitForCompletion timed out" });
  assert.equal(bus.listenerCount("subagents:completed"), 0);
  assert.equal(bus.listenerCount("subagents:failed"), 0);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.waitForCompletion("missing", { signal: controller.signal }), {
    name: "RpcError",
    message: "waitForCompletion aborted",
  });
  assert.equal(bus.listenerCount("subagents:completed"), 0);
});
