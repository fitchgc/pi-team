import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import { dispatchTask } from "../src/dispatch.js";
import { runConfiguredFlow, stopRun, type RunSummary } from "../src/engine.js";
import { initTeam, type InitReport } from "../src/init.js";
import { formatProgressLines, type RunProgress } from "../src/progress.js";
import { deliverReport, notify } from "../src/report.js";
import { resumeFlow } from "../src/resume.js";
import { formatRolesTable } from "../src/roles.js";
import { OfficialRpcClient } from "../src/rpc-official.js";
import { RpcClient, type EventBus, type RpcClientLike } from "../src/rpc.js";
import { formatRunStatus, getRunStatus } from "../src/status.js";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const usage = "Usage: /team init | roles | run <task-file> | resume <task-file> | status | stop";
const completions = [
  { value: "init", label: "init", description: "Create the project board, agents, and skills" },
  { value: "roles", label: "roles", description: "Show the effective role definitions" },
  { value: "run", label: "run", description: "Run the team on a task file" },
  { value: "resume", label: "resume", description: "Resume an interrupted run from the last completed stage" },
  { value: "status", label: "status", description: "Show the active run status" },
  { value: "stop", label: "stop", description: "Stop the active team run" },
];

function getArgumentCompletions(argumentPrefix: string) {
  const prefix = argumentPrefix.trimStart();
  return /\s/.test(prefix) ? null : completions.filter(item => item.value.startsWith(prefix));
}

function sendReport(pi: ExtensionAPI, mode: ExtensionCommandContext["mode"], text: string): void {
  deliverReport(mode, text, content => {
    try {
      pi.sendMessage({ customType: "pi-team", content, display: true }, { deliverAs: "nextTurn" });
    } catch {
      return;
    }
  });
}

function formatInitReport(report: InitReport): string {
  return [
    "pi-team init done",
    `team.json: ${report.teamJson}`,
    ...report.agents.map(({ role, action }) => `- ${role}.md: ${action}`),
    ...report.skills.map(({ skill, action }) => `- skill ${skill}: ${action}`),
    ...report.warnings.map(warning => `- WARN: ${warning}`),
  ].join("\n");
}

function formatRunSummary(summary: RunSummary): string {
  const gate = summary.gatePassed ? "yes" : "no";
  const lines = [
    `Task ${summary.taskId}: ${summary.status}`,
    `rounds: ${summary.rounds}, fix rounds used: ${summary.fixRoundsUsed}, gate passed: ${gate}, QA evidence: ${summary.qaEvidence}`,
  ];
  if (summary.escalated) {
    lines.push(summary.escalationReason
      ? `escalated: ${summary.escalationReason} — needs a human`
      : "escalated: needs a human");
  }
  if (summary.cost !== undefined) {
    const { agents, totalUsd, partial } = summary.cost;
    const breakdown = agents.length > 1
      ? ` (${agents.map(agent => `${agent.role} $${agent.costUsd.toFixed(4)}`).join(", ")})`
      : "";
    lines.push(`cost: $${totalUsd.toFixed(4)} total${breakdown}${partial ? " (partial)" : ""}`);
  }
  return lines.join("\n");
}

function createRpcClient(config: ResolvedConfig, bus: EventBus): RpcClientLike {
  return config.subagents === "official" ? new OfficialRpcClient(bus) : new RpcClient(bus);
}

export default function teamExtension(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const skillSourceDir = join(homedir(), "workspace", "custom-skills");
  const bus = {
    on: (event: string, handler: (data: unknown) => void) => pi.events.on(event, handler),
    emit: (event: string, payload: unknown) => pi.events.emit(event, payload),
  };

  pi.registerTool({
    name: "team_dispatch",
    label: "team_dispatch",
    description: "Dispatch a coding task to the pi-team multi-agent team (architect → coder → gate → QA → reviewer, plus security auditor when labeled). Use this when the user asks for a code change in a project initialized with pi-team (/team init), instead of implementing it yourself. The tool creates a task file on the board, runs the full team flow, and returns the run summary. It takes minutes; do not call it twice for the same request, and do not call it while another dispatch is running.",
    promptGuidelines: [
      "Only call team_dispatch in a project initialized with pi-team (a .pi/team.json exists); otherwise tell the user to run /team init first.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description: "The requirement, in the user's words. Write it as a concrete, implementable request.",
      }),
      title: Type.Optional(Type.String({
        description: "Short title for the task file, e.g. 'add isNegative helper'. Defaults to the first line of task.",
      })),
      acceptance: Type.Optional(Type.String({
        description: "Acceptance criteria, one per line. Omit when the requirement itself states what done means.",
      })),
      parallel: Type.Optional(Type.Boolean({
        description: "Set true only when the task splits into independent subtasks the planner should decompose.",
      })),
      labels: Type.Optional(Type.Array(Type.String(), {
        description: "Task labels, e.g. ['security-sensitive'] to trigger the security auditor.",
      })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<RunSummary | { error: string }>> {
      try {
        const config = await resolveConfig({ projectDir: ctx.cwd, packageDir, agentDir });
        const boardDir = join(ctx.cwd, config.board);
        const rpc = createRpcClient(config, bus);
        const updateProgress = (progress: RunProgress) => {
          ctx.ui.setStatus("pi-team", `running ${progress.taskId}… ${progress.stage}`);
          if (ctx.mode === "tui") {
            ctx.ui.setWidget("pi-team", formatProgressLines(progress), { placement: "aboveEditor" });
          }
        };
        ctx.ui.setStatus("pi-team", "dispatching task…");
        try {
          const summary = await dispatchTask(
            { rpc, cwd: ctx.cwd, boardDir, config, agentDir, onProgress: updateProgress },
            params, signal,
          );
          return { content: [{ type: "text", text: formatRunSummary(summary) }], details: summary };
        } finally {
          ctx.ui.setStatus("pi-team", undefined);
          if (ctx.mode === "tui") ctx.ui.setWidget("pi-team", undefined);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
      }
    },
  });

  pi.registerCommand("team", {
    description: "Multi-role coding team: init | roles | run <task-file> | resume <task-file> | status | stop",
    getArgumentCompletions,
    async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const [sub, taskFile] = args.trim().split(/\s+/).filter(Boolean);
      const opts = { projectDir: ctx.cwd, packageDir, agentDir };
      const updateProgress = (progress: RunProgress) => {
        ctx.ui.setStatus("pi-team", `running ${taskFile}… ${progress.stage}`);
        if (ctx.mode === "tui") {
          ctx.ui.setWidget("pi-team", formatProgressLines(progress), { placement: "aboveEditor" });
        }
      };
      try {
        switch (sub) {
          case "init": {
            const report = await initTeam({ ...opts, skillSourceDir, configDirName: CONFIG_DIR_NAME });
            sendReport(pi, ctx.mode, formatInitReport(report));
            notify(ctx.mode, ctx.ui, "pi-team init done", "info");
            return;
          }
          case "roles": {
            const config = await resolveConfig(opts);
            sendReport(pi, ctx.mode, formatRolesTable(config));
            notify(ctx.mode, ctx.ui, "pi-team roles listed", "info");
            return;
          }
          case "run": {
            if (!taskFile) {
              notify(ctx.mode, ctx.ui, "Usage: /team run <task-file>", "error");
              return;
            }
            const config = await resolveConfig(opts);
            const boardDir = join(ctx.cwd, config.board);
            const rpc = createRpcClient(config, bus);
            ctx.ui.setStatus("pi-team", `running ${taskFile}…`);
            try {
              const summary = await runConfiguredFlow(
                { rpc, cwd: ctx.cwd, boardDir, config, agentDir, onProgress: updateProgress },
                { taskFile, signal: ctx.signal },
              );
              sendReport(pi, ctx.mode, formatRunSummary(summary));
            } finally {
              ctx.ui.setStatus("pi-team", undefined);
              if (ctx.mode === "tui") ctx.ui.setWidget("pi-team", undefined);
            }
            return;
          }
          case "resume": {
            if (!taskFile) {
              notify(ctx.mode, ctx.ui, "Usage: /team resume <task-file>", "error");
              return;
            }
            const config = await resolveConfig(opts);
            const boardDir = join(ctx.cwd, config.board);
            const rpc = createRpcClient(config, bus);
            ctx.ui.setStatus("pi-team", `resuming ${taskFile}…`);
            try {
              const summary = await resumeFlow(
                { rpc, cwd: ctx.cwd, boardDir, config, agentDir, onProgress: updateProgress },
                { taskFile, signal: ctx.signal },
              );
              sendReport(pi, ctx.mode, formatRunSummary(summary));
            } finally {
              ctx.ui.setStatus("pi-team", undefined);
              if (ctx.mode === "tui") ctx.ui.setWidget("pi-team", undefined);
            }
            return;
          }
          case "status": {
            const config = await resolveConfig(opts);
            const status = await getRunStatus({ boardDir: join(ctx.cwd, config.board), config });
            if (status === undefined) {
              notify(ctx.mode, ctx.ui, "no pi-team run is active", "info");
            } else {
              sendReport(pi, ctx.mode, formatRunStatus(status));
            }
            return;
          }
          case "stop": {
            const config = await resolveConfig(opts);
            const result = await stopRun({
              rpc: createRpcClient(config, bus),
              cwd: ctx.cwd,
              boardDir: join(ctx.cwd, config.board),
              config,
            });
            notify(ctx.mode, ctx.ui, result.stopped ? `stopped run ${result.runId}` : "no pi-team run is active", "info");
            return;
          }
          default:
            notify(ctx.mode, ctx.ui, usage, "info");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(ctx.mode, ctx.ui, `pi-team ${sub} failed: ${message}`, "error");
      }
    },
  });
}
