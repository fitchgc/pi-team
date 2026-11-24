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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgent(value: unknown): value is SubagentInfo {
  if (!isRecord(value)) return false;

  const strings = ["id", "type", "description", "status"];
  const numbers = ["depth", "startedAt", "durationMs", "toolUses"];
  const optionalStrings = ["parentAgentId", "workflowId", "result", "error", "structuredJson", "sessionFile"];
  const optionalNumbers = ["completedAt", "durationMs"];
  const flags = ["settling", "notificationPending"];
  const tokens = value.tokens;

  return strings.every(key => typeof value[key] === "string")
    && numbers.every(key => typeof value[key] === "number")
    && optionalStrings.every(key => value[key] === undefined || typeof value[key] === "string")
    && optionalNumbers.every(key => value[key] === undefined || typeof value[key] === "number")
    && flags.every(key => value[key] === undefined || typeof value[key] === "boolean")
    && (tokens === undefined || (isRecord(tokens)
      && typeof tokens.input === "number"
      && typeof tokens.output === "number"
      && typeof tokens.total === "number"));
}

type RequestName = "ping" | "spawn" | "stop" | "consume" | "steer" | "get" | "list";

export class RpcClient {
  private readonly bus: EventBus;
  private readonly timeoutMs: number;
  private cachedProtocol: ProtocolInfo | undefined;
  private pendingProtocol: Promise<ProtocolInfo> | undefined;

  constructor(bus: EventBus, opts?: { timeoutMs?: number }) {
    this.bus = bus;
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
  }

  get protocol(): ProtocolInfo | undefined {
    return this.cachedProtocol;
  }

  hasFeature(name: string): boolean {
    return this.cachedProtocol?.features.includes(name) ?? false;
  }

  private async request(
    name: RequestName,
    fields: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const channel = `subagents:rpc:${name}`;
    const requestId = randomUUID();
    const replyChannel = `${channel}:reply:${requestId}`;
    let unsubscribe: (() => void) | undefined;
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await new Promise<unknown>((resolve, reject) => {
        onAbort = () => reject(new RpcError(`subagents RPC aborted: ${channel}`));
        if (signal?.aborted) {
          onAbort();
          return;
        }

        signal?.addEventListener("abort", onAbort, { once: true });
        unsubscribe = this.bus.on(replyChannel, (reply: unknown) => {
          if (!isRecord(reply) || typeof reply.success !== "boolean") {
            reject(new RpcError(`malformed RPC reply on ${channel}`));
          } else if (reply.success) {
            resolve(reply.data);
          } else if (name === "consume") {
            resolve(undefined);
          } else if (typeof reply.error === "string") {
            reject(new RpcError(reply.error));
          } else {
            reject(new RpcError(`malformed RPC reply on ${channel}`));
          }
        });
        timer = setTimeout(() => {
          if (name === "consume") {
            resolve(undefined);
          } else {
            reject(new RpcError(`subagents RPC timed out: ${channel}`));
          }
        }, this.timeoutMs);
        this.bus.emit(channel, { ...fields, requestId });
      });
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      unsubscribe?.();
    }
  }

  async ensureProtocol(): Promise<ProtocolInfo> {
    if (this.cachedProtocol) return this.cachedProtocol;
    if (this.pendingProtocol) return this.pendingProtocol;

    this.pendingProtocol = this.request("ping").then(data => {
      if (!isRecord(data) || typeof data.version !== "number") {
        throw new RpcError("malformed ping reply");
      }
      if (data.version !== 2) {
        throw new RpcError(`unsupported pi-subagents protocol version ${data.version}, expected 2`);
      }
      const features = Array.isArray(data.features)
        ? data.features.filter((feature: unknown): feature is string => typeof feature === "string")
        : [];
      this.cachedProtocol = { version: data.version, features };
      return this.cachedProtocol;
    });
    try {
      return await this.pendingProtocol;
    } finally {
      this.pendingProtocol = undefined;
    }
  }

  async spawn(type: string, prompt: string, options?: SpawnOptions): Promise<{ id: string }> {
    const model = options?.model;
    if (typeof model === "string" && !/^[^/\s]+\/\S+$/.test(model)) {
      throw new RpcError("spawn model must be a full provider/modelId");
    }
    const fields = options === undefined ? { type, prompt } : { type, prompt, options };
    const data = await this.request("spawn", fields);
    if (!isRecord(data) || typeof data.id !== "string") {
      throw new RpcError("malformed spawn reply");
    }
    return { id: data.id };
  }

  async stop(agentId: string, settleTimeoutMs?: number): Promise<{ settled: boolean }> {
    const fields = settleTimeoutMs === undefined ? { agentId } : { agentId, settleTimeoutMs };
    const data = await this.request("stop", fields);
    if (!isRecord(data) || typeof data.settled !== "boolean") {
      throw new RpcError("malformed stop reply");
    }
    return { settled: data.settled };
  }

  async consume(agentId: string): Promise<void> {
    await this.request("consume", { agentId });
  }

  consumeSync(agentId: string): void {
    try {
      this.bus.emit("subagents:rpc:consume", { requestId: randomUUID(), agentId });
    } catch {
      // Notification suppression is best effort, including when a bus handler throws.
    }
  }

  async steer(agentId: string, message: string): Promise<void> {
    await this.request("steer", { agentId, message });
  }

  private async readAgent(agentId: string, signal?: AbortSignal): Promise<SubagentInfo> {
    const data = await this.request("get", { agentId }, signal);
    if (!isRecord(data) || !isAgent(data.agent)) throw new RpcError("malformed get reply");
    return data.agent;
  }

  get(agentId: string): Promise<SubagentInfo> {
    return this.readAgent(agentId);
  }

  async list(): Promise<SubagentInfo[]> {
    const data = await this.request("list");
    if (!isRecord(data) || !Array.isArray(data.agents) || !data.agents.every(isAgent)) {
      throw new RpcError("malformed list reply");
    }
    return data.agents;
  }

  async waitForCompletion(
    agentId: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SubagentInfo> {
    const signal = opts?.signal;
    const abortError = () => new RpcError(`waiting for subagent aborted: ${agentId}`);
    if (signal?.aborted) throw abortError();

    const reads = new AbortController();
    const subscriptions: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let claimed = false;

    try {
      return await new Promise<SubagentInfo>((resolve, reject) => {
        const onAbort = () => {
          claimed = true;
          reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        subscriptions.push(() => signal?.removeEventListener("abort", onAbort));

        const onTerminal = (info: unknown) => {
          if (claimed || !isAgent(info) || info.id !== agentId) return;
          claimed = true;
          this.consumeSync(agentId);
          if (info.result !== undefined) {
            resolve(info);
            return;
          }

          void this.readAgent(agentId, reads.signal).then(
            current => resolve(current.result === undefined ? info : { ...info, result: current.result }),
            () => resolve(info),
          );
        };
        subscriptions.push(this.bus.on("subagents:completed", onTerminal));
        subscriptions.push(this.bus.on("subagents:failed", onTerminal));
        timer = setTimeout(() => {
          claimed = true;
          reject(new RpcError(`waiting for subagent timed out: ${agentId}`));
        }, opts?.timeoutMs ?? this.timeoutMs);

        void this.readAgent(agentId, reads.signal).then(info => {
          if (claimed || info.status === "running" || info.status === "queued") return;
          claimed = true;
          this.consumeSync(agentId);
          resolve(info);
        }, () => {
          // The agent may become visible only after the first lookup.
        });
      });
    } finally {
      claimed = true;
      clearTimeout(timer);
      for (const unsubscribe of subscriptions) unsubscribe();
      reads.abort();
    }
  }
}
