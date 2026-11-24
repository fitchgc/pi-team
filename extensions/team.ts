import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "../src/config.js";
import { runConfiguredFlow, stopRun, type RunSummary } from "../src/engine.js";
import { initTeam, type InitReport } from "../src/init.js";
import { deliverReport, notify } from "../src/report.js";
import { formatRolesTable } from "../src/roles.js";
import { RpcClient } from "../src/rpc.js";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const usage = "Usage: /team init | roles | run <task-file> | stop";
const completions = [
  { value: "init", label: "init", description: "Create the project board, agents, and skills" },
  { value: "roles", label: "roles", description: "Show the effective role definitions" },
  { value: "run", label: "run", description: "Run the team on a task file" },
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
  if (summary.escalated) lines.push("escalated: fix budget exhausted — needs a human");
  return lines.join("\n");
}

export default function teamExtension(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const skillSourceDir = join(homedir(), "workspace", "custom-skills");
  const bus = {
    on: (event: string, handler: (data: unknown) => void) => pi.events.on(event, handler),
    emit: (event: string, payload: unknown) => pi.events.emit(event, payload),
  };

  pi.registerCommand("team", {
    description: "Multi-role coding team: init | roles | run <task-file> | stop",
    getArgumentCompletions,
    async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const opts = { projectDir: ctx.cwd, packageDir, agentDir };
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
            const taskFile = rest[0];
            if (!taskFile) {
              notify(ctx.mode, ctx.ui, "Usage: /team run <task-file>", "error");
              return;
            }
            const config = await resolveConfig(opts);
            const boardDir = join(ctx.cwd, config.board);
            const rpc = new RpcClient(bus);
            ctx.ui.setStatus("pi-team", `running ${taskFile}…`);
            try {
              const summary = await runConfiguredFlow(
                { rpc, cwd: ctx.cwd, boardDir, config, agentDir },
                { taskFile, signal: ctx.signal },
              );
              sendReport(pi, ctx.mode, formatRunSummary(summary));
            } finally {
              ctx.ui.setStatus("pi-team", undefined);
            }
            return;
          }
          case "stop": {
            const config = await resolveConfig(opts);
            const result = await stopRun({
              rpc: new RpcClient(bus),
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
