import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ResolvedConfig } from "./config.js";
import { runGate, type GateResult } from "./gate.js";
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
}

export function lockPath(boardDir: string): string {
  return join(boardDir, ".team-run.lock");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRunLock(value: unknown): value is RunLock {
  return typeof value === "object" && value !== null
    && "runId" in value && typeof value.runId === "string"
    && "taskId" in value && typeof value.taskId === "string"
    && "startedAt" in value && typeof value.startedAt === "number"
    && Number.isFinite(value.startedAt)
    && (!("currentAgentId" in value) || typeof value.currentAgentId === "string");
}

export async function readRunLock(boardDir: string): Promise<RunLock | undefined> {
  let text: string;
  try {
    text = await readFile(lockPath(boardDir), "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const lock: unknown = JSON.parse(text);
  if (!isRunLock(lock)) throw new Error("invalid run lock");
  return lock;
}

export async function acquireRunLock(boardDir: string, taskId: string): Promise<RunLock> {
  await mkdir(boardDir, { recursive: true });
  const startedAt = Date.now();
  const lock = {
    runId: `run-${startedAt}-${randomBytes(3).toString("hex")}`,
    taskId,
    startedAt,
  };
  try {
    await writeFile(lockPath(boardDir), JSON.stringify(lock), { flag: "wx" });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    const owner = await readRunLock(boardDir).catch(() => undefined);
    if (!owner) throw new Error("another run is active: unknown run (lock file unreadable)");
    throw new Error(`another run is active: ${owner.runId} for task ${owner.taskId}`);
  }
  return lock;
}

async function patchLock(boardDir: string, patch: Partial<RunLock>, owner?: string): Promise<void> {
  const lock = await readRunLock(boardDir);
  if (!lock) throw new Error("no active run");
  if (owner !== undefined && lock.runId !== owner) throw new Error("run lock owner changed");
  await writeFile(lockPath(boardDir), JSON.stringify({ ...lock, ...patch }), { flag: "r+" });
}

export async function updateRunLock(boardDir: string, patch: Partial<RunLock>): Promise<void> {
  const lock = await readRunLock(boardDir);
  if (!lock) throw new Error("no active run");
  await writeFile(lockPath(boardDir), JSON.stringify({ ...lock, ...patch }));
}

export async function releaseRunLock(boardDir: string, runId: string): Promise<void> {
  if ((await readRunLock(boardDir))?.runId !== runId) return;
  try {
    await unlink(lockPath(boardDir));
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

export async function findTaskFile(boardDir: string, taskId: string): Promise<string | undefined> {
  const entries = await readdir(boardDir, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const exact = `${taskId}.md`;
  if (names.includes(exact)) return exact;
  return names.sort().find((name) => name.startsWith(`${taskId}-`) && name.endsWith(".md"));
}

function checkInside(boardDir: string, path: string): void {
  const name = relative(boardDir, path);
  if (!name || name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name)) {
    throw new Error(`task file must live inside the board directory: ${path}`);
  }
}

async function taskPath(boardDir: string, filename: string): Promise<string> {
  const path = resolve(boardDir, filename);
  checkInside(boardDir, path);
  const [board, file] = await Promise.all([realpath(boardDir), realpath(path)]);
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
  await writeFile(path, text);
  return text;
}

export interface EngineDeps {
  rpc: RpcClient;
  cwd: string;
  boardDir: string;
  config: ResolvedConfig;
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

function appendRecord(text: string, entry: string): string {
  const existing = getSection(text, "实现记录");
  return updateSection(text, "实现记录", existing ? `${existing}\n${entry}` : entry);
}

function interrupt(text: string, entry: string): string {
  return updateStatus(appendRecord(text, entry), "已中断");
}

function agentPrompt(role: "coder" | "qa", filename: string, text: string, fixing: boolean): string {
  const task = parseTaskFile(filename, text);
  const lines = [
    `Task ${task.id}: ${task.title}`,
    "",
    "## 需求",
    getSection(text, "需求") || "(no requirements section)",
    "## 验收标准",
    getSection(text, "验收标准") || "(no acceptance criteria)",
  ];
  if (role === "qa") {
    lines.push(
      "## 实现记录",
      getSection(text, "实现记录") ?? "",
      "Review the implementation read-only. Do not modify any file.",
      "Run the task's test command when one is configured.",
      "Reply with exactly these three lines (no other text):",
      "- verdict：通过 or 打回",
      "- 证据：<what you checked>",
      "- 打回原因：<why it fails, empty when 通过>",
    );
  } else {
    if (fixing) {
      const conclusion = getSection(text, "验收结论") ?? "";
      // Gate output can span several lines after the rejection heading.
      const reasons = /^- 打回原因[ \t]*[:：][ \t]*([\s\S]*)/m.exec(conclusion)?.[1] ?? "";
      lines.push("", "## 打回原因", reasons, "Address every 打回原因 above.");
    }
    lines.push(
      "Implement the task in the project working directory. Run the tests you need.",
      "Report what you changed, key decisions, and test results in your final message.",
      "Do not edit the task file itself; the dispatcher records your result.",
    );
  }
  return lines.join("\n");
}

const agentTimeoutMs = 4 * 60 * 60 * 1000;

export async function runSmallFlow(
  deps: EngineDeps,
  opts: { taskFile: string; signal?: AbortSignal },
): Promise<RunSummary> {
  const { boardDir, config, rpc } = deps;
  const { taskFile, signal } = opts;
  const readTask = async () => readFile(await taskPath(boardDir, taskFile), "utf8");
  const task = parseTaskFile(taskFile, await readTask());
  if (!["待实现", "打回", "已中断"].includes(task.status ?? "")) {
    throw new Error(`task ${task.id} is not runnable (status: ${task.status})`);
  }

  const lock = await acquireRunLock(boardDir, task.id);
  try {
    const summary: RunSummary = {
      runId: lock.runId,
      taskId: task.id,
      status: "已中断",
      rounds: 0,
      fixRoundsUsed: 0,
      escalated: false,
      gatePassed: false,
      qaEvidence: "",
    };
    const checkActive = async () => {
      signal?.throwIfAborted();
      if ((await readRunLock(boardDir))?.runId !== lock.runId) {
        throw new Error("run stopped");
      }
      signal?.throwIfAborted();
    };
    const edit = async (mutate: (text: string) => string) => {
      await checkActive();
      const text = await updateTaskFile(boardDir, taskFile, mutate);
      signal?.throwIfAborted();
      return text;
    };
    const runAgent = async (name: "coder" | "qa", text: string) => {
      await checkActive();
      const role = config.roles[name];
      const prompt = agentPrompt(name, taskFile, text, summary.fixRoundsUsed > 0);
      const { id } = await rpc.spawn(name, prompt, {
        description: `pi-team ${name}: ${task.id}`,
        ...(role.model !== undefined && { model: role.model }),
        ...(role.maxTurns !== undefined && { maxTurns: role.maxTurns }),
        ...(role.thinking !== undefined && { thinkingLevel: role.thinking }),
      });
      if (name === "coder") summary.rounds++;
      try {
        await patchLock(boardDir, { currentAgentId: id }, lock.runId);
      } catch (error) {
        await rpc.stop(id).catch(() => undefined);
        throw error;
      }
      signal?.throwIfAborted();
      const info = await rpc.waitForCompletion(id, { timeoutMs: agentTimeoutMs, signal });
      await checkActive();
      await updateRunLock(boardDir, { currentAgentId: undefined });
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
    await edit((text) => updateStatus(text, "实现中"));
    await rpc.ensureProtocol();

    for (;;) {
      summary.gatePassed = false;
      summary.qaEvidence = "";
      const coder = await runAgent("coder", await readTask());
      if (coder.info.status !== "completed") {
        await edit((text) => interrupt(text, `coder agent ${coder.info.status}: ${coder.info.error || "(no error)"}`));
        return summary;
      }
      const record = `coder ${coder.id} (${coder.info.durationMs}ms, ${coder.info.toolUses} tool uses):\n`
        + (coder.info.result || "(no result text)");
      await edit((text) => updateStatus(updateSection(text, "实现记录", record), "待验收"));

      const { testCommand } = parseTaskFile(taskFile, await readTask());
      await checkActive();
      const gate = await (deps.gate ?? runGate)(testCommand, deps.cwd);
      await checkActive();
      summary.gatePassed = gate.passed;
      let conclusion: NonNullable<ReturnType<typeof parseVerdict>>;
      if (gate.passed) {
        const qa = await runAgent("qa", await readTask());
        if (qa.info.status !== "completed") {
          await edit((text) => interrupt(text, `qa agent ${qa.info.status}: ${qa.info.error || "(no error)"}`));
          return summary;
        }
        conclusion = parseVerdict(qa.info.result ?? "") ?? {
          verdict: "打回",
          evidence: qa.info.result || "(no result text)",
          reasons: "QA returned no parseable verdict",
        };
      } else {
        conclusion = {
          verdict: "打回",
          evidence: gate.output,
          reasons: `gate failed: ${testCommand}\n${gate.output}`,
        };
      }

      summary.qaEvidence = conclusion.evidence;
      if (conclusion.verdict === "通过") {
        await edit((text) => updateStatus(updateConclusion(text, { ...conclusion, reasons: "" }), "通过"));
        return { ...summary, status: "通过" };
      }
      if (summary.fixRoundsUsed < config.fixBudget) {
        await edit((text) => updateStatus(updateConclusion(text, conclusion), "实现中"));
        summary.fixRoundsUsed++;
        continue;
      }
      const entry = `fix budget exhausted after ${summary.fixRoundsUsed} fix rounds; escalate to a human.`;
      await edit((text) => updateStatus(appendRecord(updateConclusion(text, conclusion), entry), "打回"));
      return { ...summary, status: "打回", escalated: true };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = signal?.aborted || (error instanceof Error && error.name === "AbortError")
      || /abort/i.test(message);
    const owner = await readRunLock(boardDir).catch(() => undefined);
    if (owner?.runId === lock.runId) {
      if (aborted && owner.currentAgentId) {
        await rpc.stop(owner.currentAgentId).catch(() => undefined);
      }
      const entry = aborted ? "run aborted by user" : `run failed: ${message}`;
      await updateTaskFile(boardDir, taskFile, (text) => interrupt(text, entry)).catch(() => undefined);
    }
    throw error;
  } finally {
    await releaseRunLock(boardDir, lock.runId);
  }
}

export async function stopRun(
  deps: EngineDeps,
  opts: { taskFile?: string } = {},
): Promise<{ stopped: boolean; runId?: string }> {
  const { boardDir, rpc } = deps;
  const lock = await readRunLock(boardDir);
  if (!lock) return { stopped: false };
  try {
    if (lock.currentAgentId) await rpc.stop(lock.currentAgentId).catch(() => undefined);
    const filename = opts.taskFile ?? await findTaskFile(boardDir, lock.taskId);
    if (filename && (await readRunLock(boardDir))?.runId === lock.runId) {
      await updateTaskFile(boardDir, filename, (text) => interrupt(text, "stopped by /team stop"));
    }
  } catch {
    // A missing or unwritable task file must not prevent releasing the lock.
  } finally {
    await releaseRunLock(boardDir, lock.runId);
  }
  return { stopped: true, runId: lock.runId };
}
