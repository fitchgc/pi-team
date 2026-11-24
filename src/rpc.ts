import { randomUUID } from "node:crypto";

export interface EventBus {
  on(event: string, handler: (data: any) => void): () => void;
  emit(event: string, payload: unknown): void;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SpawnOptions {
  description?: string;
  name?: string;
  model?: string | null;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  bypassQueue?: boolean;
  isolation?: "worktree";
  cwd?: string;
}

export interface SubagentInfo {
  id: string;
  type: string;
  description: string;
  status: string;
  depth: number;
  parentAgentId?: string;
  workflowId?: string;
  startedAt: number;
  completedAt?: number;
  durationMs: number;
  toolUses: number;
  result?: string;
  error?: string;
  structuredJson?: string;
  sessionFile?: string;
  tokens?: { input: number; output: number; total: number };
  settling?: boolean;
  notificationPending?: boolean;
}

export interface ProtocolInfo {
  version: number;
  features: string[];
}

export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcError";
  }
}

interface RpcEnvelope {
  success: boolean;
  data?: unknown;
  error?: string;
}

const requestPrefix = "subagents:rpc:";
const defaultTimeoutMs = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSubagentInfo(value: unknown): value is SubagentInfo {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.status === "string";
}

export class RpcClient {
  private readonly bus: EventBus;
  private readonly timeoutMs: number;
  private cachedProtocol: ProtocolInfo | undefined;

  constructor(bus: EventBus, opts?: { timeoutMs?: number }) {
    this.bus = bus;
    this.timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs;
  }

  get protocol(): ProtocolInfo | undefined {
    return this.cachedProtocol;
  }

  hasFeature(name: string): boolean {
    return this.cachedProtocol?.features.includes(name) ?? false;
  }

  private request<T>(
    name: string,
    payload: Record<string, unknown>,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const channel = `${requestPrefix}${name}`;
    const requestId = randomUUID();
    const replyChannel = `${channel}:reply:${requestId}`;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        action();
      };

      unsubscribe = this.bus.on(replyChannel, (reply: unknown) => {
        if (!isRecord(reply) || typeof reply.success !== "boolean") {
          finish(() => reject(new RpcError(`malformed RPC reply on ${replyChannel}`)));
          return;
        }
        const envelope = reply as unknown as RpcEnvelope;
        if (!envelope.success) {
          finish(() => reject(new RpcError(typeof envelope.error === "string" ? envelope.error : "")));
          return;
        }
        finish(() => resolve(envelope.data as T));
      });

      const timer = setTimeout(() => {
        finish(() => reject(new RpcError(`subagents RPC timed out: ${channel}`)));
      }, timeoutMs);

      try {
        this.bus.emit(channel, { ...payload, requestId });
      } catch (error: unknown) {
        finish(() => reject(error instanceof Error ? error : new RpcError(String(error))));
      }
    });
  }

  async ensureProtocol(): Promise<ProtocolInfo> {
    if (this.cachedProtocol) return this.cachedProtocol;

    const reply = await this.request<unknown>("ping", {});
    if (!isRecord(reply) || typeof reply.version !== "number") {
      throw new RpcError("malformed ping reply");
    }
    if (reply.version !== 2) {
      throw new RpcError(`unsupported pi-subagents protocol version ${reply.version}, expected 2`);
    }
    const features = Array.isArray(reply.features)
      ? reply.features.filter((feature): feature is string => typeof feature === "string")
      : [];
    this.cachedProtocol = { version: reply.version, features };
    return this.cachedProtocol;
  }

  async spawn(type: string, prompt: string, options?: SpawnOptions): Promise<{ id: string }> {
    const data = await this.request<unknown>("spawn", {
      type,
      prompt,
      ...(options === undefined ? {} : { options }),
    });
    if (!isRecord(data) || typeof data.id !== "string") {
      throw new RpcError("malformed spawn reply");
    }
    return { id: data.id };
  }

  async stop(agentId: string, settleTimeoutMs?: number): Promise<{ settled: boolean }> {
    const data = await this.request<unknown>("stop", {
      agentId,
      ...(settleTimeoutMs === undefined ? {} : { settleTimeoutMs }),
    });
    if (!isRecord(data) || typeof data.settled !== "boolean") {
      throw new RpcError("malformed stop reply");
    }
    return { settled: data.settled };
  }

  async consume(agentId: string): Promise<void> {
    // Older builds have no consume handler and never reply: a timeout (or any
    // error here) is not an error — the completion notification is simply delivered.
    try {
      await this.request<unknown>("consume", { agentId });
    } catch {
      return;
    }
  }

  consumeSync(agentId: string): void {
    try {
      this.bus.emit(`${requestPrefix}consume`, {
        requestId: randomUUID(),
        agentId,
      });
    } catch {
      return;
    }
  }

  async steer(agentId: string, message: string): Promise<void> {
    await this.request<unknown>("steer", { agentId, message });
  }

  async get(agentId: string): Promise<SubagentInfo> {
    const data = await this.request<unknown>("get", { agentId });
    if (!isRecord(data) || !isSubagentInfo(data.agent)) {
      throw new RpcError("malformed get reply");
    }
    return data.agent;
  }

  async list(): Promise<SubagentInfo[]> {
    const data = await this.request<unknown>("list", {});
    if (!isRecord(data) || !Array.isArray(data.agents) || !data.agents.every(isSubagentInfo)) {
      throw new RpcError("malformed list reply");
    }
    return data.agents;
  }

  waitForCompletion(
    agentId: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SubagentInfo> {
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const signal = opts?.signal;

    if (signal?.aborted) {
      return Promise.reject(new RpcError("waitForCompletion aborted"));
    }

    return new Promise<SubagentInfo>((resolve, reject) => {
      let settled = false;
      const unsubscribers: Array<() => void> = [];
      const cleanup = (): void => {
        clearTimeout(timer);
        for (const unsubscribe of unsubscribers) unsubscribe();
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const onAbort = (): void => {
        finish(() => reject(new RpcError("waitForCompletion aborted")));
      };
      const handleEvent = (event: unknown): void => {
        if (!isSubagentInfo(event) || event.id !== agentId) return;
        this.consumeSync(agentId);
        if (event.result !== undefined) {
          finish(() => resolve(event));
          return;
        }
        void this.get(agentId).then(
          (info) => finish(() => resolve({ ...event, result: info.result })),
          () => finish(() => resolve(event)),
        );
      };

      unsubscribers.push(this.bus.on("subagents:completed", handleEvent));
      unsubscribers.push(this.bus.on("subagents:failed", handleEvent));
      const timer = setTimeout(() => {
        finish(() => reject(new RpcError("waitForCompletion timed out")));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });

      void this.get(agentId).then(
        (info) => {
          if (info.status !== "running" && info.status !== "queued") {
            this.consumeSync(agentId);
            finish(() => resolve(info));
          }
        },
        () => undefined,
      );
    });
  }
}
