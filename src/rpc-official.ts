import { randomUUID } from "node:crypto";
import {
  RpcError, type AgentCost, type EventBus, type ProtocolInfo,
  type RpcClientLike, type SpawnOptions, type SubagentInfo,
} from "./rpc.js";

type WaitOptions = NonNullable<Parameters<RpcClientLike["waitForCompletion"]>[1]>;
type Metadata = Pick<SubagentInfo, "startedAt" | "type" | "description">;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RequestTimeout extends RpcError {}

export class OfficialRpcClient implements RpcClientLike {
  readonly backend = "official" as const;
  private readonly timeoutMs: number;
  private readonly runs = new Map<string, Metadata>();
  private cachedProtocol: ProtocolInfo | undefined;
  private pendingProtocol: Promise<ProtocolInfo> | undefined;
  private lastChildTotalCost: number | undefined;

  constructor(private readonly bus: EventBus, opts?: { timeoutMs?: number }) {
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
  }

  private async request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const requestId = randomUUID();
    const channel = "subagents:rpc:v1:request";
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        onAbort = () => reject(new RpcError(`subagents RPC aborted: ${method}`));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        unsubscribe = this.bus.on(`subagents:rpc:v1:reply:${requestId}`, (reply: unknown) => {
          if (!record(reply) || typeof reply.success !== "boolean"
            || ("requestId" in reply && reply.requestId !== requestId)) {
            reject(new RpcError(`malformed RPC reply on ${channel}`));
          } else if (reply.success) {
            resolve(reply.data);
          } else {
            const error = reply.error;
            const message = typeof error === "string" ? error
              : record(error) && typeof error.message === "string" ? error.message
              : record(error) && typeof error.code === "string" ? error.code : "official RPC failed";
            reject(new RpcError(message));
          }
        });
        timer = setTimeout(() => reject(new RequestTimeout(`subagents RPC timed out: ${method}`)), this.timeoutMs);
        this.bus.emit(channel, {
          version: 1, requestId, method, ...(params !== undefined && { params }),
        });
      });
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      unsubscribe?.();
    }
  }

  hasFeature(name: string): boolean {
    return this.cachedProtocol?.features.includes(name) ?? false;
  }

  async ensureProtocol(): Promise<ProtocolInfo> {
    if (this.cachedProtocol) return this.cachedProtocol;
    if (this.pendingProtocol) return this.pendingProtocol;
    this.pendingProtocol = this.request("ping", {}).then(data => {
      const version = record(data) ? data.version : undefined;
      if (version !== 1) throw new RpcError(`unsupported pi-subagents protocol version ${version}, expected 1`);
      const capabilities = record(data) ? data.capabilities : undefined;
      const features = record(capabilities) ? Object.keys(capabilities).filter(key => capabilities[key]) : [];
      this.cachedProtocol = { version, features };
      return this.cachedProtocol;
    });
    try {
      return await this.pendingProtocol;
    } finally {
      this.pendingProtocol = undefined;
    }
  }

  async spawn(type: string, prompt: string, options: SpawnOptions = {}): Promise<{ id: string }> {
    const { model, thinkingLevel, description, cwd } = options;
    if (typeof model === "string" && !/^[^/\s]+\/\S+$/.test(model)) {
      throw new RpcError("spawn model must be a full provider/modelId");
    }
    const startedAt = Date.now();
    const data = await this.request("spawn", {
      agent: type, task: prompt, async: true,
      ...(model && { model: thinkingLevel ? `${model}:${thinkingLevel}` : model }),
      ...(cwd && { cwd }),
      ...(description && { label: description }),
      ...(options.isolation === "worktree" && { worktree: true }),
    });
    if (!record(data) || !record(data.details) || typeof data.details.asyncId !== "string") {
      throw new RpcError("malformed spawn reply");
    }
    const id = data.details.asyncId;
    this.runs.set(id, { startedAt, type, description: description ?? "" });
    return { id };
  }

  async stop(agentId: string, _settleTimeoutMs?: number): Promise<{ settled: boolean }> {
    await this.request("stop", { runId: agentId });
    return { settled: false };
  }

  async steer(agentId: string, message: string): Promise<void> {
    await this.request("steer", { action: "steer", runId: agentId, message });
  }

  async consume(_agentId: string): Promise<void> {}
  consumeSync(_agentId: string): void {}

  async list(): Promise<SubagentInfo[]> {
    throw new RpcError("list is not supported on the official backend");
  }

  private async readStatus(id: string, signal?: AbortSignal) {
    const data = await this.request("status", { runId: id }, signal);
    if (!record(data) || !record(data.details) || !Array.isArray(data.details.results)) {
      throw new RpcError("malformed status reply");
    }
    const child: unknown = data.details.results[0];
    if (data.details.results.length && !record(child)) throw new RpcError("malformed status reply");
    const metadata = this.runs.get(id) ?? {
      startedAt: Date.now(), type: "", description: "",
    };
    const base = { id, ...metadata, depth: 1, durationMs: Date.now() - metadata.startedAt, toolUses: 0 };
    if (!record(child)) return { info: { ...base, status: "running" }, retry: false };
    const error = typeof child.error === "string" ? child.error : undefined;
    const output = typeof child.finalOutput === "string" ? child.finalOutput : undefined;
    const status = child.status === undefined
      ? error !== undefined || (typeof child.exitCode === "number" && child.exitCode !== 0) ? "failed"
        : child.exitCode === 0 ? "completed" : "running"
      : child.status === "completed" ? "completed"
      : child.status === "running" || child.status === "queued" ? "running" : "failed";
    const info: SubagentInfo = {
      ...base, status,
      ...(status !== "running" && { result: output ?? "" }),
      ...(error !== undefined && { error }),
    };
    const retry = (status === "completed" && !output)
      || (output === undefined && error === undefined && child.exitCode === undefined);
    return { info, retry };
  }

  async get(agentId: string): Promise<SubagentInfo> {
    return (await this.readStatus(agentId)).info;
  }

  async waitForCompletion(agentId: string, opts?: WaitOptions): Promise<SubagentInfo> {
    const signal = opts?.signal;
    const abortError = () => new RpcError(`waiting for subagent aborted: ${agentId}`);
    if (signal?.aborted) throw abortError();
    const reads = new AbortController();
    let unsubscribe: (() => void) | undefined;
    let onAbort: (() => void) | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    try {
      const info = await new Promise<SubagentInfo>((resolve, reject) => {
        let busy = false;
        let confirming = false;
        const check = async () => {
          if (busy || reads.signal.aborted) return;
          clearTimeout(poll);
          busy = true;
          let delay = 500;
          try {
            const snapshot = await this.readStatus(agentId, reads.signal);
            if (reads.signal.aborted) return;
            if (snapshot.retry && !confirming) {
              confirming = true;
              delay = 250;
            } else if (snapshot.info.status !== "running") {
              resolve(snapshot.info);
              return;
            } else {
              confirming = false;
            }
          } catch (error) {
            if (!(error instanceof RequestTimeout)) {
              reject(error);
              return;
            }
          } finally {
            busy = false;
          }
          if (!reads.signal.aborted) poll = setTimeout(check, delay);
        };
        onAbort = () => reject(abortError());
        signal?.addEventListener("abort", onAbort, { once: true });
        deadline = setTimeout(() => reject(new RpcError(`waiting for subagent timed out: ${agentId}`)),
          opts?.timeoutMs ?? this.timeoutMs);
        unsubscribe = this.bus.on("subagent:async-complete", (event: unknown) => {
          if (record(event) && (event.runId ?? event.id) === agentId
            && (event.state === "complete" || event.state === "failed" || event.state === "stopped")) {
            if (!confirming) void check();
          }
        });
        poll = setTimeout(check, 500);
      });
      this.runs.delete(agentId);
      return info;
    } finally {
      reads.abort();
      clearTimeout(poll);
      clearTimeout(deadline);
      unsubscribe?.();
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  async cost(agentId: string): Promise<AgentCost | undefined> {
    try {
      const data = await this.request("cost");
      if (!record(data) || !Array.isArray(data.children)) return undefined;
      const total = record(data.childTotal) ? data.childTotal.cost : undefined;
      const previous = this.lastChildTotalCost;
      if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
        this.lastChildTotalCost = total;
      }
      const child: unknown = data.children.find((entry: unknown) => record(entry) && entry.runId === agentId);
      if (record(child) && record(child.usage)) {
        const { cost = 0, input = 0, output = 0 } = child.usage;
        if (typeof cost === "number" && typeof input === "number" && typeof output === "number"
          && [cost, input, output].every(value => Number.isFinite(value) && value >= 0)
          && (cost > 0 || input > 0 || output > 0)) {
          return { costUsd: cost, inputTokens: input, outputTokens: output };
        }
      }
      if (previous !== undefined && typeof total === "number" && Number.isFinite(total) && total > previous) {
        return { costUsd: total - previous, inputTokens: 0, outputTokens: 0 };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}
