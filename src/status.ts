import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ResolvedConfig } from "./config.js";
import { findTaskFile, readRunLock } from "./engine.js";
import { getSection, parseTaskFile, type TaskFile } from "./taskfile.js";

const stageNames = ["architect", "coder", "qa", "reviewer", "security-auditor"] as const;

export interface RunStatus {
  runId: string;
  taskId: string;
  taskTitle?: string;
  startedAt: number;
  taskStatus?: string;
  stages: Record<(typeof stageNames)[number], boolean>;
  activeAgents: Array<{ id: string; role: string }>;
  fixBudgetTotal: number;
  fixBudgetRemaining: number;
}

export async function getRunStatus(
  { boardDir, config }: { boardDir: string; config: ResolvedConfig },
): Promise<RunStatus | undefined> {
  const lock = await readRunLock(boardDir);
  if (!lock) return undefined;

  let task: TaskFile | undefined;
  try {
    const filename = await findTaskFile(boardDir, lock.taskId);
    if (filename !== undefined) {
      const text = await readFile(join(boardDir, filename), "utf8");
      task = parseTaskFile(filename, text);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const text = task?.raw ?? "";
  const activeAgents = lock.currentAgentId !== undefined
    ? [{ id: lock.currentAgentId, role: lock.currentRoles?.[0] ?? "unknown" }]
    : (lock.currentAgentIds ?? []).map((id, index) => ({
      id, role: lock.currentRoles?.[index] ?? "coder",
    }));
  return {
    runId: lock.runId,
    taskId: lock.taskId,
    ...(task && { taskTitle: task.title }),
    ...(task?.status !== undefined && { taskStatus: task.status }),
    startedAt: lock.startedAt,
    stages: {
      architect: Boolean(getSection(text, "接口设计")),
      coder: Boolean(getSection(text, "实现记录")),
      qa: Boolean(getSection(text, "验收结论")),
      reviewer: Boolean(getSection(text, "评审结论")),
      "security-auditor": Boolean(getSection(text, "安全审计")),
    },
    activeAgents,
    fixBudgetTotal: config.fixBudget,
    fixBudgetRemaining: Math.max(0, config.fixBudget - (lock.fixRoundsUsed ?? 0)),
  };
}

export function formatRunStatus(status: RunStatus, now = Date.now()): string {
  const started = new Date(status.startedAt).toLocaleString("zh-CN", { hour12: false });
  const minutes = Math.floor((now - status.startedAt) / 60000);
  const elapsed = minutes === 0 ? "<1m ago" : `${minutes}m ago`;
  const stages = stageNames.map(name => `${name} ${status.stages[name] ? "done" : "pending"}`);
  const active = status.activeAgents.map(({ id, role }) => `${role} (${id})`);
  return [
    `pi-team run ${status.runId}`,
    `task: ${status.taskId}${status.taskTitle === undefined ? "" : ` ${status.taskTitle}`}`,
    `started: ${started} (${elapsed})`,
    `status: ${status.taskStatus ?? "unknown"}`,
    `stages: ${stages.join(", ")}`,
    `active: ${active.join(", ") || "none (between stages)"}`,
    `fix budget: ${status.fixBudgetRemaining} of ${status.fixBudgetTotal} remaining`,
  ].join("\n");
}
