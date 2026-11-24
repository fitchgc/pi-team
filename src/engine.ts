import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseAgentFile, type ResolvedConfig } from "./config.js";
import { runGate, type GateResult } from "./gate.js";
import { realGit, mergeTicket, type Git } from "./git.js";
import { ticketFiles, ticketWaves } from "./tickets.js";
import type { RpcClient } from "./rpc.js";
import {
  getSection,
  parseTaskFile,
  parseVerdict,
  updateConclusion,
  updateSection,
  updateStatus,
} from "./taskfile.js";

export interface RunLock {
  runId: string;
  taskId: string;
  startedAt: number;
  currentAgentId?: string;
  currentAgentIds?: string[];
  taskFile?: string;
}

export interface EngineDeps {
  rpc: RpcClient;
  cwd: string;
  boardDir: string;
  config: ResolvedConfig;
  git?: Git;
  agentDir?: string;
  gate?: (testCommand: string | undefined, cwd: string, timeoutMs?: number) => Promise<GateResult>;
}

export interface RunSummary {
  taskId: string;
  runId: string;
  status: "通过" | "打回" | "已中断";
  rounds: number;
  fixRoundsUsed: number;
  escalated: boolean;
  gatePassed: boolean;
  qaEvidence: string;
}

const agentTimeoutMs = 4 * 60 * 60 * 1000;
const boardOperations = new Map<string, Promise<void>>();

// A local /team stop can interleave with a resumed RPC wait between two filesystem awaits.
async function withBoard<T>(boardDir: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(boardDir);
  const previous = boardOperations.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => {}, () => {});
  boardOperations.set(key, tail);
  try {
    return await result;
  } finally {
    if (boardOperations.get(key) === tail) {
      boardOperations.delete(key);
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function lockPath(boardDir: string): string {
  return join(boardDir, ".team-run.lock");
}

function isRunLock(value: unknown): value is RunLock {
  return typeof value === "object" && value !== null
    && "runId" in value && typeof value.runId === "string" && value.runId.length > 0
    && "taskId" in value && typeof value.taskId === "string" && value.taskId.length > 0
    && "startedAt" in value && typeof value.startedAt === "number" && Number.isFinite(value.startedAt)
    && (!("taskFile" in value) || typeof value.taskFile === "string")
    && (!("currentAgentIds" in value) || (Array.isArray(value.currentAgentIds)
      && value.currentAgentIds.every(id => typeof id === "string" && id.length > 0)))
    && (!("currentAgentId" in value) || typeof value.currentAgentId === "string");
}

async function loadLock(boardDir: string): Promise<RunLock | undefined> {
  let text: string;
  try {
    text = await readFile(lockPath(boardDir), "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!isRunLock(value)) throw new Error("malformed run lock");
  return value;
}

export function readRunLock(boardDir: string): Promise<RunLock | undefined> {
  return withBoard(boardDir, () => loadLock(boardDir));
}

export function acquireRunLock(boardDir: string, taskId: string): Promise<RunLock> {
  return withBoard(boardDir, async () => {
    await mkdir(boardDir, { recursive: true });
    const startedAt = Date.now();
    const lock: RunLock = {
      runId: `run-${startedAt}-${randomBytes(3).toString("hex")}`,
      taskId,
      startedAt,
    };
    try {
      await writeFile(lockPath(boardDir), JSON.stringify(lock), { flag: "wx" });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = await loadLock(boardDir).catch(() => undefined);
      throw new Error(existing
        ? `another run is active: ${existing.runId} for task ${existing.taskId}`
        : "another run is active: unknown run (lock file unreadable)");
    }
    return lock;
  });
}

async function requireLock(boardDir: string, runId?: string): Promise<RunLock> {
  const lock = await loadLock(boardDir);
  if (!lock) throw new Error("no active run lock");
  if (runId !== undefined && lock.runId !== runId) {
    throw new Error(`run ${runId} no longer owns the lock`);
  }
  return lock;
}

function patchLock(boardDir: string, patch: Partial<RunLock>, runId?: string): Promise<void> {
  return withBoard(boardDir, async () => {
    const lock = await requireLock(boardDir, runId);
    await writeFile(lockPath(boardDir), JSON.stringify({ ...lock, ...patch }));
  });
}

export function updateRunLock(boardDir: string, patch: Partial<RunLock>): Promise<void> {
  return withBoard(boardDir, async () => {
    const lock = await requireLock(boardDir);
    await writeFile(lockPath(boardDir), JSON.stringify({ ...lock, ...patch }));
  });
}

async function removeOwnedLock(boardDir: string, runId: string): Promise<void> {
  if ((await loadLock(boardDir))?.runId !== runId) return;
  try {
    await unlink(lockPath(boardDir));
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

export function releaseRunLock(boardDir: string, runId: string): Promise<void> {
  return withBoard(boardDir, () => removeOwnedLock(boardDir, runId));
}

export async function findTaskFile(boardDir: string, taskId: string): Promise<string | undefined> {
  const entries = await readdir(boardDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const exact = `${taskId}.md`;
  if (files.includes(exact)) return exact;
  return files.sort().find((name) => name.startsWith(`${taskId}-`) && name.endsWith(".md"));
}

function checkInside(boardDir: string, path: string): void {
  const name = relative(boardDir, path);
  if (!name || name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name)) {
    throw new Error(`task file must be inside the board directory: ${path}`);
  }
}

async function taskPath(boardDir: string, filename: string): Promise<string> {
  const root = resolve(boardDir);
  const path = resolve(root, filename);
  checkInside(root, path);
  const board = await realpath(root);
  const file = await realpath(path).catch(async (firstError: unknown) => {
    const fallback = resolve(root, "..", filename);
    if (fallback === path) throw firstError;
    try {
      checkInside(root, fallback);
      return await realpath(fallback);
    } catch {
      throw firstError;
    }
  });
  checkInside(board, file);
  return file;
}

export async function updateTaskFile(
  boardDir: string,
  filename: string,
  mutate: (text: string) => string,
): Promise<string> {
  const path = await taskPath(boardDir, filename);
  const text = mutate(await readFile(path, "utf8"));
  await writeFile(path, text, "utf8");
  return text;
}

function appendRecord(text: string, entry: string): string {
  const existing = getSection(text, "实现记录");
  return updateSection(text, "实现记录", existing ? `${existing}\n${entry}` : entry);
}

function interrupted(text: string, entry: string): string {
  return updateStatus(appendRecord(text, entry), "已中断");
}

function taskBrief(filename: string, text: string): string {
  const task = parseTaskFile(filename, text);
  return [
    `Task ${task.id}: ${task.title}`,
    "",
    "## 需求",
    getSection(text, "需求") || "(no requirements section)",
    "## 验收标准",
    getSection(text, "验收标准") || "(no acceptance criteria)",
  ].join("\n");
}

function coderPrompt(
  filename: string, text: string, fixing: boolean, fixSection: "验收结论" | "评审结论" = "验收结论",
): string {
  const lines = [taskBrief(filename, text)];
  if (fixing) {
    const conclusion = getSection(text, fixSection) ?? "";
    // Gate output can span multiple lines after the 打回原因 field.
    const reasons = fixSection === "评审结论" ? conclusion
      : conclusion.match(/^- 打回原因[ \t]*[:：][ \t]*([\s\S]*)/m)?.[1] ?? "";
    lines.push("", "## 打回原因", reasons, "Address every 打回原因 above.");
  }
  lines.push(
    "Implement the task in the project working directory. Run the tests you need.",
    "Report what you changed, key decisions, and test results in your final message.",
    "Do not edit the task file itself; the dispatcher records your result.",
  );
  return lines.join("\n");
}

function qaPrompt(filename: string, text: string): string {
  return [
    taskBrief(filename, text),
    "## 实现记录",
    getSection(text, "实现记录") ?? "",
    "Review the implementation read-only. Do not modify any file.",
    "Run the task's test command when one is configured.",
    "Reply with exactly these three lines (no other text):",
    "- verdict：通过 or 打回",
    "- 证据：<what you checked>",
    "- 打回原因：<why it fails, empty when 通过>",
  ].join("\n");
}

function isAbort(error: unknown): boolean {
  return hasCode(error, "ABORT_ERR") || (error instanceof Error
    && (error.name === "AbortError" || /abort/i.test(error.message)));
}

export async function runSmallFlow(
  deps: EngineDeps,
  opts: { taskFile: string; signal?: AbortSignal },
): Promise<RunSummary> {
  const { boardDir, rpc, config } = deps;
  const { taskFile, signal } = opts;
  const readTask = async () => readFile(await taskPath(boardDir, taskFile), "utf8");
  const task = parseTaskFile(taskFile, await readTask());
  if (!["待实现", "打回", "已中断"].includes(task.status ?? "")) {
    throw new Error(`task ${task.id} is not runnable (status: ${task.status})`);
  }

  const { runId } = await acquireRunLock(boardDir, task.id);
  try {
    let rounds = 0;
    let fixRoundsUsed = 0;
    let gatePassed = false;
    let qaEvidence = "";

    const summary = (status: RunSummary["status"], escalated = false): RunSummary => ({
      taskId: task.id, runId, status, rounds, fixRoundsUsed, escalated, gatePassed, qaEvidence,
    });

    const edit = async (mutate: (text: string) => string): Promise<string> => {
      const text = await withBoard(boardDir, async () => {
        await requireLock(boardDir, runId);
        signal?.throwIfAborted();
        return updateTaskFile(boardDir, taskFile, mutate);
      });
      signal?.throwIfAborted();
      return text;
    };

    const agent = async (name: "coder" | "qa", prompt: string) => {
      const role = config.roles[name];
      const lock = await readRunLock(boardDir);
      if (lock?.runId !== runId) throw new Error(`run ${runId} no longer owns the lock`);
      signal?.throwIfAborted();
      const { id } = await rpc.spawn(name, prompt, {
        description: `pi-team ${name}: ${task.id}`,
        ...(role.model !== undefined && { model: role.model }),
        ...(role.maxTurns !== undefined && { maxTurns: role.maxTurns }),
        ...(role.thinking !== undefined && { thinkingLevel: role.thinking }),
      });
      if (name === "coder") rounds++;
      try {
        await patchLock(boardDir, { currentAgentId: id }, runId);
      } catch (error) {
        await rpc.stop(id).catch(() => {});
        throw error;
      }
      signal?.throwIfAborted();
      const info = await rpc.waitForCompletion(id, { timeoutMs: agentTimeoutMs, signal });
      signal?.throwIfAborted();
      await withBoard(boardDir, async () => {
        const current = await requireLock(boardDir, runId);
        delete current.currentAgentId;
        await writeFile(lockPath(boardDir), JSON.stringify(current));
      });
      return { id, info };
    };

    signal?.throwIfAborted();
    for (const name of ["coder", "qa"] as const) {
      const role = config.roles[name];
      if (!role?.enabled) throw new Error(`role ${name} is disabled`);
      if (role.isolation !== undefined) {
        throw new Error(`role ${name} requests worktree isolation, which is not available in v0.1`);
      }
    }

    let text = await edit((fresh) => updateStatus(fresh, "实现中"));
    await rpc.ensureProtocol();
    const gate = deps.gate ?? runGate;

    for (;;) {
      if (fixRoundsUsed > 0) text = await readTask();
      gatePassed = false;
      qaEvidence = "";
      const coder = await agent("coder", coderPrompt(taskFile, text, fixRoundsUsed > 0));
      if (coder.info.status !== "completed") {
        const failure = `coder agent ${coder.info.status}: ${coder.info.error || "(no error)"}`;
        await edit((fresh) => interrupted(fresh, failure));
        return summary("已中断");
      }

      const record = [
        `coder ${coder.id} (${coder.info.durationMs}ms, ${coder.info.toolUses} tool uses):`,
        coder.info.result || "(no result text)",
      ].join("\n");
      await edit((fresh) => updateStatus(updateSection(fresh, "实现记录", record), "待验收"));
      const { testCommand } = parseTaskFile(taskFile, await readTask());
      signal?.throwIfAborted();
      const result = await gate(testCommand, deps.cwd);
      signal?.throwIfAborted();
      gatePassed = result.passed;

      let conclusion: NonNullable<ReturnType<typeof parseVerdict>>;
      if (!gatePassed) {
        conclusion = {
          verdict: "打回",
          evidence: result.output,
          reasons: `gate failed: ${testCommand}\n${result.output}`,
        };
      } else {
        const qa = await agent("qa", qaPrompt(taskFile, await readTask()));
        if (qa.info.status !== "completed") {
          const failure = `qa agent ${qa.info.status}: ${qa.info.error || "(no error)"}`;
          await edit((fresh) => interrupted(fresh, failure));
          return summary("已中断");
        }
        const reply = qa.info.result ?? "";
        conclusion = parseVerdict(reply) ?? {
          verdict: "打回",
          evidence: reply || "(no result text)",
          reasons: "QA returned no parseable verdict",
        };
      }

      qaEvidence = conclusion.evidence;
      const conclude = (fresh: string) => updateConclusion(fresh, conclusion);
      if (conclusion.verdict === "通过") {
        await edit((fresh) => updateStatus(conclude(fresh), "通过"));
        return summary("通过");
      }
      if (fixRoundsUsed >= config.fixBudget) {
        const escalation = `fix budget exhausted after ${fixRoundsUsed} fix rounds; escalate to a human.`;
        await edit((fresh) => updateStatus(appendRecord(conclude(fresh), escalation), "打回"));
        return summary("打回", true);
      }
      fixRoundsUsed++;
      await edit((fresh) => updateStatus(conclude(fresh), "实现中"));
    }
  } catch (error) {
    const aborted = signal?.aborted || isAbort(error);
    const message = aborted
      ? "run aborted by user"
      : `run failed: ${error instanceof Error ? error.message : String(error)}`;
    await withBoard(boardDir, async () => {
      const lock = await loadLock(boardDir);
      if (lock?.runId !== runId) return;
      if (lock.currentAgentId) await rpc.stop(lock.currentAgentId).catch(() => {});
      await updateTaskFile(boardDir, taskFile, (text) => interrupted(text, message));
    }).catch(() => {});
    throw error;
  } finally {
    await releaseRunLock(boardDir, runId);
  }
}

function reviewerPrompt(text: string): string {
  return [
    text,
    "Review the current implementation against the interface design and QA evidence above.",
    "Do not modify any files. Return a verdict line (- verdict：通过 or - verdict：打回),",
    "followed by your evidence and actionable reasons for any rejection.",
  ].join("\n");
}

export async function runBigFlow(
  deps: EngineDeps,
  opts: { taskFile: string; signal?: AbortSignal },
): Promise<RunSummary> {
  const { boardDir, rpc, config } = deps;
  const { taskFile, signal } = opts;
  const readTask = async () => readFile(await taskPath(boardDir, taskFile), "utf8");
  const task = parseTaskFile(taskFile, await readTask());
  if (!["待实现", "打回", "已中断"].includes(task.status ?? "")) {
    throw new Error(`task ${task.id} is not runnable (status: ${task.status})`);
  }

  const { runId } = await acquireRunLock(boardDir, task.id);
  try {
    let rounds = 0;
    let fixRoundsUsed = 0;
    let gatePassed = false;
    let qaEvidence = "";

    const summary = (status: RunSummary["status"], escalated = false): RunSummary => ({
      taskId: task.id, runId, status, rounds, fixRoundsUsed, escalated, gatePassed, qaEvidence,
    });

    const edit = async (mutate: (text: string) => string): Promise<string> => {
      const text = await withBoard(boardDir, async () => {
        await requireLock(boardDir, runId);
        signal?.throwIfAborted();
        return updateTaskFile(boardDir, taskFile, mutate);
      });
      signal?.throwIfAborted();
      return text;
    };

    const agent = async (
      name: "architect" | "planner" | "coder" | "qa" | "reviewer", prompt: string,
      ticketId?: string, waitSignal = signal,
    ) => {
      const role = config.roles[name];
      const lock = await readRunLock(boardDir);
      if (lock?.runId !== runId) throw new Error(`run ${runId} no longer owns the lock`);
      signal?.throwIfAborted();
      waitSignal?.throwIfAborted();
      let type: string = name;
      if (name === "coder" && !ticketId && task.parallel && role.isolation === "worktree") {
        type = "pi-team-coder-main";
        const alias = await readFile(join(deps.cwd, ".pi", "agents", `${type}.md`), "utf8").catch(() => "");
        if (!alias || parseAgentFile(alias).frontmatter.isolation !== undefined) {
          throw new Error("main-checkout coder unavailable; run /team init to generate pi-team-coder-main.md");
        }
      }
      const { id } = await rpc.spawn(type, prompt, {
        ...(ticketId && { cwd: deps.cwd, isolation: "worktree" as const }),
        description: `pi-team ${name}: ${ticketId ?? task.id}`,
        ...(role.model !== undefined && { model: role.model }),
        ...(role.maxTurns !== undefined && { maxTurns: role.maxTurns }),
        ...(role.thinking !== undefined && { thinkingLevel: role.thinking }),
      });
      if (name === "coder") rounds++;
      try {
        if (ticketId) {
          await withBoard(boardDir, async () => {
            const current = await requireLock(boardDir, runId);
            waitSignal?.throwIfAborted();
            (current.currentAgentIds ??= []).push(id);
            await writeFile(lockPath(boardDir), JSON.stringify(current));
          });
        } else {
          await patchLock(boardDir, { currentAgentId: id }, runId);
        }
      } catch (error) {
        await rpc.stop(id).catch(() => {});
        throw error;
      }
      signal?.throwIfAborted();
      const info = await rpc.waitForCompletion(id, { timeoutMs: agentTimeoutMs, signal: waitSignal, ...(ticketId && { settled: true }) });
      signal?.throwIfAborted();
      await withBoard(boardDir, async () => {
        const current = await requireLock(boardDir, runId);
        if (ticketId) {
          current.currentAgentIds = current.currentAgentIds?.filter(active => active !== id);
          if (!current.currentAgentIds?.length) delete current.currentAgentIds;
        } else {
          delete current.currentAgentId;
        }
        await writeFile(lockPath(boardDir), JSON.stringify(current));
      });
      if (info.status !== "completed") {
        const failure = `${name} agent ${info.status}: ${info.error || "(no error)"}`;
        if (ticketId) throw new Error(`${ticketId}: ${failure}`);
        await edit((fresh) => interrupted(fresh, failure));
        return undefined;
      }
      return { id, info };
    };

    signal?.throwIfAborted();
    const git = (args: string[]) => (deps.git ?? realGit)(args, deps.cwd);
    if (task.parallel) {
      const isolation = config.roles.coder.isolation;
      if (isolation !== undefined && isolation !== "worktree") {
        throw new Error(`parallel coder isolation must be worktree; got ${isolation}`);
      }
      if (!config.roles.planner.enabled || config.roles.planner.isolation !== undefined) {
        throw new Error("parallel planning requires an enabled planner in the main checkout");
      }
      for (const dir of [join(deps.cwd, ".pi"), deps.agentDir]) {
        if (!dir) continue;
        const settings = await readFile(join(dir, "subagents.json"), "utf8").catch((error: unknown) => {
          if (!hasCode(error, "ENOENT")) throw error;
          return "{}";
        });
        const enabled: unknown = JSON.parse(settings)?.worktreeIsolation;
        if (enabled === false) throw new Error("parallel coding requires worktreeIsolation in subagents.json");
        if (enabled === true) break;
      }
      const repo = await git(["rev-parse", "--is-inside-work-tree"]);
      if (repo.code !== 0 || repo.stdout.trim() !== "true") throw new Error("parallel coding requires a git worktree");
      if ((await git(["rev-parse", "HEAD"])).code !== 0) throw new Error("parallel coding requires a git repo with HEAD");
      const author = await git(["config", "user.name"]);
      const email = await git(["config", "user.email"]);
      if (author.code !== 0 || !author.stdout.trim() || email.code !== 0 || !email.stdout.trim()) {
        throw new Error("parallel coding requires git user.name and user.email (the worktree settle commits); set them with git config user.name \"...\" and git config user.email \"...\"");
      }
      await patchLock(boardDir, { taskFile }, runId);
    }
    for (const name of ["coder", "qa", "architect", "reviewer"] as const) {
      const role = config.roles[name];
      if (!role?.enabled) {
        if (name === "coder" || name === "qa") throw new Error(`role ${name} is disabled`);
        continue;
      }
      if (role.isolation !== undefined && !(task.parallel && name === "coder")) {
        throw new Error(`role ${name} requests worktree isolation, which is not available in v0.1`);
      }
    }

    let text = await edit((fresh) => updateStatus(fresh, "实现中"));
    await rpc.ensureProtocol();
    const gate = deps.gate ?? runGate;

    let designPrompt = "";
    if (config.roles.architect.enabled) {
      const architect = await agent("architect", [
        taskBrief(taskFile, text),
        "Design the shared interfaces and module boundaries. Do not modify any files.",
        "Return the design for the implementer in your final message.",
      ].join("\n"));
      if (!architect) return summary("已中断");
      const design = (architect.info.result || "(no result text)").replace(/^## /gm, "### ");
      text = await edit((fresh) => updateSection(fresh, "接口设计", design));
      designPrompt = `## 接口设计\n${design}\n\n`;
    } else {
      text = await edit((fresh) => updateSection(fresh, "接口设计", "architect disabled; skipped"));
    }

    if (task.parallel) {
      const before = await ticketFiles(boardDir, task.id);
      const planner = await agent("planner", [
        taskBrief(taskFile, text), designPrompt,
        `Use local-to-tickets along the design's module boundaries. The tracker is ${resolve(boardDir)}.`,
        `Write or rewrite every ticket for this run as ${task.id}-<n>-<slug>.md. Its ID is ${task.id}-<n>.`,
        `Include header lines '- 父任务：${task.id}' and '- 依赖：' (comma-separated blocking IDs or empty).`,
        "Include ## 需求 and ## 验收标准. Write only subtask files. Leave the parent and code untouched.",
      ].join("\n"));
      if (!planner) return summary("已中断");
      const waves = await ticketWaves(boardDir, task.id, before);
      for (const wave of waves) {
        const cancel = new AbortController();
        const waveSignal = signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal;
        const jobs = wave.map(async ticket => {
          const coder = await agent("coder", [designPrompt, `Subtask file: ${ticket.filename}`, ticket.text,
            "Implement only this ticket in your worktree and run its tests. Leave board files untouched.",
          ].join("\n"), ticket.id, waveSignal);
          if (!coder) throw new Error(`subtask ${ticket.id} interrupted`);
          return { ticket, coder };
        });
        let results: Awaited<(typeof jobs)[number]>[];
        try {
          results = await Promise.all(jobs);
        } catch (error) {
          cancel.abort();
          await withBoard(boardDir, async () => {
            const lock = await loadLock(boardDir);
            if (lock?.runId !== runId) return;
            await stopAgents(rpc, lock);
            delete lock.currentAgentIds;
            await writeFile(lockPath(boardDir), JSON.stringify(lock));
          });
          await Promise.allSettled(jobs);
          throw error;
        }
        const touched = new Map<string, string[]>();
        for (const { ticket, coder } of results) {
          const escalated = await withBoard(boardDir, async () => {
            await requireLock(boardDir, runId);
            signal?.throwIfAborted();
            const merge = await mergeTicket(git, ticket.id, coder.id, touched);
            await updateTaskFile(boardDir, taskFile, fresh => {
              const record = appendRecord(fresh, `${merge.record}\n    ${(coder.info.result || "").replace(/\n/g, "\n    ")}`);
              return merge.escalated ? updateStatus(record, "打回") : record;
            });
            return merge.escalated;
          });
          if (escalated) return summary("打回", true);
        }
      }
      text = await edit(fresh => updateStatus(fresh, "待验收"));
    }

    let fixSection: "验收结论" | "评审结论" = "验收结论";
    for (;;) {
      if (fixRoundsUsed > 0) text = await readTask();
      gatePassed = false;
      qaEvidence = "";
      if (!task.parallel || fixRoundsUsed > 0) {
        const prompt = coderPrompt(taskFile, text, fixRoundsUsed > 0, fixSection);
        const coder = await agent("coder", designPrompt + prompt);
        if (!coder) return summary("已中断");

        const record = [
          `coder ${coder.id} (${coder.info.durationMs}ms, ${coder.info.toolUses} tool uses):`,
          coder.info.result || "(no result text)",
        ].join("\n");
        await edit((fresh) => updateStatus(
          task.parallel ? appendRecord(fresh, record) : updateSection(fresh, "实现记录", record), "待验收",
        ));
      }
      const { testCommand } = parseTaskFile(taskFile, await readTask());
      signal?.throwIfAborted();
      const result = await gate(testCommand, deps.cwd);
      signal?.throwIfAborted();
      gatePassed = result.passed;

      let conclusion: NonNullable<ReturnType<typeof parseVerdict>>;
      if (!gatePassed) {
        conclusion = {
          verdict: "打回",
          evidence: result.output,
          reasons: `gate failed: ${testCommand}\n${result.output}`,
        };
      } else {
        const qa = await agent("qa", designPrompt + qaPrompt(taskFile, await readTask()));
        if (!qa) return summary("已中断");
        const reply = qa.info.result ?? "";
        conclusion = parseVerdict(reply) ?? {
          verdict: "打回",
          evidence: reply || "(no result text)",
          reasons: "QA returned no parseable verdict",
        };
      }

      qaEvidence = conclusion.evidence;
      let conclude = (fresh: string) => updateConclusion(fresh, conclusion);
      let passed = conclusion.verdict === "通过";
      fixSection = "验收结论";
      if (passed && config.roles.reviewer.enabled) {
        text = await edit(conclude);
        const reviewer = await agent("reviewer", reviewerPrompt(text));
        if (!reviewer) return summary("已中断");
        const reply = (reviewer.info.result || "(no result text)").replace(/^## /gm, "### ");
        const verdict = parseVerdict(reply);
        passed = verdict?.verdict === "通过";
        const report = verdict ? reply : [
          "- verdict：打回", "- 打回原因：reviewer returned no parseable verdict", reply,
        ].join("\n");
        conclude = (fresh) => updateSection(fresh, "评审结论", report);
        fixSection = "评审结论";
      }
      if (passed) {
        await edit((fresh) => updateStatus(conclude(fresh), "通过"));
        return summary("通过");
      }
      if (fixRoundsUsed >= config.fixBudget) {
        const escalation = `fix budget exhausted after ${fixRoundsUsed} fix rounds; escalate to a human.`;
        await edit((fresh) => updateStatus(appendRecord(conclude(fresh), escalation), "打回"));
        return summary("打回", true);
      }
      fixRoundsUsed++;
      await edit((fresh) => updateStatus(conclude(fresh), "实现中"));
    }
  } catch (error) {
    const aborted = signal?.aborted || isAbort(error);
    const message = aborted
      ? "run aborted by user"
      : `run failed: ${error instanceof Error ? error.message : String(error)}`;
    await withBoard(boardDir, async () => {
      const lock = await loadLock(boardDir);
      if (lock?.runId !== runId) return;
      await stopAgents(rpc, lock);
      await updateTaskFile(boardDir, taskFile, (text) => interrupted(text, message));
    }).catch(() => {});
    throw error;
  } finally {
    await releaseRunLock(boardDir, runId);
  }
}

export function runConfiguredFlow(
  deps: EngineDeps,
  opts: { taskFile: string; signal?: AbortSignal },
): Promise<RunSummary> {
  const run = deps.config.defaultFlow === "big" ? runBigFlow : runSmallFlow;
  return run(deps, opts);
}

async function stopAgents(rpc: RpcClient, lock: RunLock): Promise<void> {
  const ids = new Set(lock.currentAgentIds);
  if (lock.currentAgentId) ids.add(lock.currentAgentId);
  await Promise.all([...ids].map(id => rpc.stop(id).catch(() => {})));
}

export function stopRun(
  deps: EngineDeps,
  opts: { taskFile?: string } = {},
): Promise<{ stopped: boolean; runId?: string }> {
  const { boardDir, rpc } = deps;
  return withBoard(boardDir, async () => {
    const lock = await loadLock(boardDir);
    if (!lock) return { stopped: false };
    try {
      await stopAgents(rpc, lock);
      const filename = opts.taskFile ?? lock.taskFile ?? await findTaskFile(boardDir, lock.taskId);
      if (filename) {
        await updateTaskFile(boardDir, filename, (text) => interrupted(text, "stopped by /team stop"))
          .catch(() => {});
      }
    } finally {
      await removeOwnedLock(boardDir, lock.runId);
    }
    return { stopped: true, runId: lock.runId };
  });
}
