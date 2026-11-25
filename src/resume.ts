import { readFile } from "node:fs/promises";

import type { ResolvedConfig } from "./config.js";
import { needsSecurityAudit, runConfiguredFlow, taskPath, type EngineDeps, type RunSummary } from "./engine.js";
import { getSection, parseTaskFile, type TaskFile } from "./taskfile.js";

export type ResumeStage = "architect" | "coder" | "verify" | "reviewer" | "auditor";

export function deriveStartStage(task: TaskFile, text: string, config: ResolvedConfig): ResumeStage {
  if (task.parallel) return "coder";
  if (config.roles.architect.enabled && !getSection(text, "接口设计")) return "architect";
  if (!getSection(text, "实现记录")) return "coder";
  if (!getSection(text, "验收结论")) return "verify";
  if (config.roles.reviewer.enabled && !getSection(text, "评审结论")) return "reviewer";
  if (needsSecurityAudit(config, task.labels) && !getSection(text, "安全审计")) return "auditor";
  return "verify";
}

export async function resumeFlow(
  deps: EngineDeps,
  opts: { taskFile: string; signal?: AbortSignal },
): Promise<RunSummary> {
  const text = await readFile(await taskPath(deps.boardDir, opts.taskFile), "utf8");
  const task = parseTaskFile(opts.taskFile, text);
  if (task.status !== "已中断") {
    throw new Error(`task ${task.id} is not interrupted (status: ${task.status}); use /team run to start it`);
  }

  const config: ResolvedConfig = task.parallel
    ? { ...deps.config, defaultFlow: "big" }
    : deps.config;
  const stageConfig = config.defaultFlow === "big" ? config : {
    ...config,
    roles: {
      ...config.roles,
      architect: { ...config.roles.architect, enabled: false },
      reviewer: { ...config.roles.reviewer, enabled: false },
    },
  };
  const startAt = deriveStartStage(task, text, stageConfig);
  return runConfiguredFlow({ ...deps, config }, { ...opts, startAt });
}
