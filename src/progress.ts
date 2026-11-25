export type ProgressStage = "architect" | "planner" | "coder" | "gate" | "qa" | "reviewer" | "security-auditor";

export interface RunProgress {
  runId: string;
  taskId: string;
  stage: ProgressStage;
  activeRole?: string;
  rounds: number;
  fixRoundsUsed: number;
  fixBudget: number;
}

export type ProgressCallback = (progress: RunProgress) => void;

export function formatProgressLines(progress: RunProgress): string[] {
  const { taskId, stage, activeRole, rounds, fixRoundsUsed, fixBudget } = progress;
  return [
    `pi-team ${taskId} — ${stage}`,
    `agent: ${activeRole ?? "—"} · fix ${fixRoundsUsed}/${fixBudget} · round ${rounds}`,
  ];
}
