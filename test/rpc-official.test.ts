import assert from "node:assert/strict";
import { test } from "node:test";
import { OfficialRpcClient } from "../src/rpc-official.js";
import type { EventBus } from "../src/rpc.js";

type Handler = (data: unknown) => void;
type Request = { version: number; method: string; requestId: string; params?: unknown };

class FakeOfficialBus implements EventBus {
  private readonly handlers = new Map<string, Handler[]>();
  readonly requests: Request[] = [];
  readonly replies = new Map<string, unknown>();

  on(event: string, handler: Handler): () => void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return () => {
      const remaining = this.handlers.get(event)?.filter(listener => listener !== handler);
      if (remaining?.length) this.handlers.set(event, remaining);
      else this.handlers.delete(event);
    };
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
    if (event !== "subagents:rpc:v1:request") return;
    const request = payload as Request;
    assert.equal(request.version, 1);
    assert.match(request.requestId, /^[^\r\n]+$/);
    this.requests.push(request);
    if (!this.replies.has(request.method)) return;
    this.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1, requestId: request.requestId, success: true, data: this.replies.get(request.method),
    });
  }

  emitComplete(runId: string, state: string): void {
    this.emit("subagent:async-complete", { runId, state });
  }
}

const statusReply = (results: unknown[]) => ({ text: "", details: { mode: "single", results } });

function fixture() {
  const bus = new FakeOfficialBus();
  const client = new OfficialRpcClient(bus, { timeoutMs: 2500 });
  bus.replies.set("spawn", { details: { asyncId: "r" } });
  return { bus, client };
}

test("handshake rejects v2, retries, and caches truthy v1 capabilities", async () => {
  const { bus, client } = fixture();
  bus.replies.set("ping", { version: 2 });
  await assert.rejects(client.ensureProtocol(), /version 2, expected 1/);
  bus.replies.set("ping", { version: 1, capabilities: { cost: { version: 1 }, stop: false } });
  const [first, second] = await Promise.all([client.ensureProtocol(), client.ensureProtocol()]);
  assert.deepEqual(first, { version: 1, features: ["cost"] });
  assert.equal(first, second);
  assert.equal(client.hasFeature("cost"), true);
  assert.equal(bus.requests.length, 2);
});

test("spawn validates before sending, maps options, and requires details.asyncId", async () => {
  const { bus, client } = fixture();
  await assert.rejects(client.spawn("coder", "work", { model: "short" }), /full provider\/modelId/);
  assert.equal(bus.requests.length, 0);
  assert.deepEqual(await client.spawn("coder", "work", {
    model: "org/model", thinkingLevel: "high", description: "ticket", cwd: "/repo", isolation: "worktree",
  }), { id: "r" });
  assert.deepEqual(bus.requests[0]?.params, {
    agent: "coder", task: "work", async: true, model: "org/model:high", label: "ticket", cwd: "/repo", worktree: true,
  });
  bus.replies.set("spawn", { details: {} });
  await assert.rejects(client.spawn("coder", "work"), /malformed spawn reply/);
});

test("completion reads the targeted result and preserves spawn metadata", async () => {
  const { bus, client } = fixture();
  await client.spawn("coder", "work", { description: "ticket" });
  const pending = client.waitForCompletion("r");
  bus.emitComplete("other", "complete");
  assert.ok(!bus.requests.some(request => request.method === "status"));
  bus.replies.set("status", statusReply([{ status: "completed", finalOutput: "done" }]));
  bus.emitComplete("r", "complete");
  const info = await pending;
  assert.equal(info.status, "completed");
  assert.equal(info.result, "done");
  assert.equal(info.type, "coder");
  assert.equal(info.description, "ticket");
  assert.ok(info.startedAt > 0 && info.durationMs >= 0 && info.depth === 1 && info.toolUses === 0);
  assert.deepEqual(bus.requests.find(request => request.method === "status")?.params, { runId: "r" });
});

test("failed child without an explicit status preserves its error", async () => {
  const { bus, client } = fixture();
  const pending = client.waitForCompletion("r");
  bus.replies.set("status", statusReply([{ exitCode: 1, error: "out of turns" }]));
  bus.emitComplete("r", "failed");
  const info = await pending;
  assert.equal(info.status, "failed");
  assert.equal(info.error, "out of turns");
});

test("poll finds a result even when no event arrives", async () => {
  const { bus, client } = fixture();
  bus.replies.set("status", statusReply([{ exitCode: 0, finalOutput: "found" }]));
  const info = await client.waitForCompletion("r");
  assert.equal(info.status, "completed");
  assert.equal(info.result, "found");
});

test("an early completed status is confirmed before returning empty output", async () => {
  const { bus, client } = fixture();
  bus.replies.set("status", statusReply([{ status: "completed", finalOutput: "" }]));
  const pending = client.waitForCompletion("r");
  bus.emitComplete("r", "complete");
  bus.replies.set("status", statusReply([{ status: "completed", finalOutput: "persisted" }]));
  assert.equal((await pending).result, "persisted");
  assert.equal(bus.requests.filter(request => request.method === "status").length, 2);
});

test("abort rejects even with a status read outstanding", async () => {
  const { bus, client } = fixture();
  const controller = new AbortController();
  const pending = client.waitForCompletion("r", { signal: controller.signal });
  bus.emitComplete("r", "complete");
  controller.abort();
  await assert.rejects(pending, { name: "RpcError", message: "waiting for subagent aborted: r" });
});

test("stop is only a receipt; steer is targeted; list and consume issue no requests", async () => {
  const { bus, client } = fixture();
  bus.replies.set("stop", { state: "stopping" });
  assert.deepEqual(await client.stop("r"), { settled: false });
  bus.replies.set("steer", { text: "", details: {} });
  await client.steer("r", "continue");
  assert.deepEqual(bus.requests.map(request => request.params), [
    { runId: "r" }, { action: "steer", runId: "r", message: "continue" },
  ]);
  await assert.rejects(client.list(), /list is not supported on the official backend/);
  await client.consume("r");
  client.consumeSync("r");
  assert.equal(bus.requests.length, 2);
});

test("cost prefers matched usage, then a positive delta, and tolerates unavailable reports", async () => {
  const { bus, client } = fixture();
  const report = (cost: number, children: unknown[]) => ({ version: 1, children, childTotal: { cost } });
  bus.replies.set("cost", report(2, [
    { runId: "r", usage: { cost: 1, input: 10, output: 20 } },
  ]));
  assert.deepEqual(await client.cost("r"), { costUsd: 1, inputTokens: 10, outputTokens: 20 });
  bus.replies.set("cost", report(3, []));
  assert.deepEqual(await client.cost("other"), { costUsd: 1, inputTokens: 0, outputTokens: 0 });
  assert.equal(await client.cost("other"), undefined);
  bus.replies.set("cost", null);
  assert.equal(await client.cost("r"), undefined);
  assert.ok(bus.requests.every(request => !("params" in request)));
});
