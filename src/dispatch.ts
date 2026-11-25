import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runConfiguredFlow, type EngineDeps, type RunSummary } from "./engine.js";
import { allocateTaskId, buildTaskContent, parseTaskFile } from "./taskfile.js";

export interface DispatchInput {
  task: string;
  title?: string;
  acceptance?: string;
  parallel?: boolean;
  labels?: string[];
}

export async function dispatchTask(
  deps: EngineDeps, input: DispatchInput, signal?: AbortSignal,
): Promise<RunSummary> {
  const { boardDir } = deps;
  const taskId = await allocateTaskId(boardDir);
  const { fileName, content } = buildTaskContent(taskId, input);
  if (parseTaskFile(fileName, content).testCommand) {
    throw new Error("Dispatch input contains a board 测试命令 directive. Indent the line to quote it as task text.");
  }
  await mkdir(boardDir, { recursive: true });
  await writeFile(join(boardDir, fileName), content, { encoding: "utf8", flag: "wx" });
  return await runConfiguredFlow(deps, { taskFile: fileName, signal });
}
