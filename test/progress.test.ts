import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ResolvedConfig, RoleDefinition, RoleName } from "../src/config.js";
import { runConfiguredFlow, type EngineDeps, type RunSummary } from "../src/engine.js";
import { formatProgressLines, type ProgressStage, type RunProgress } from "../src/progress.js";
import { resumeFlow } from "../src/resume.js";
import type { RpcClientLike, SubagentInfo } from "../src/rpc.js";

const taskFile = "T-001-progress.md";
const pass = "- verdict：通过\n- 证据：测试通过";

function config(defaultFlow: ResolvedConfig["defaultFlow"]): ResolvedConfig {
  const role = (name: RoleName): RoleDefinition => ({
    name, enabled: true, description: "", prompt: "", tools: [], skills: [],
    source: "package-default", jsonIgnored: false,
  });
  return {
    subagents: "herbertgao", board: ".tasks/", defaultFlow, fixBudget: 1,
    securityAudit: { trigger: "label", label: "security-sensitive" },
    roles: {
      planner: role("planner"), architect: role("architect"), coder: role("coder"), qa: role("qa"),
      reviewer: role("reviewer"), "security-auditor": role("security-auditor"),
    },
  };
}

function completed(id: string, type: string, result: string): SubagentInfo {
  return { id, type, result, description: "", status: "completed", depth: 1, startedAt: 1, durationMs: 12, toolUses: 3 };
}

class FakeRpc {
  readonly qaReplies: string[] = [];
  private readonly roles: string[] = [];
  async ensureProtocol() { return { version: 2, features: [] }; }
  async spawn(type: string) {
    return { id: String(this.roles.push(type)) };
  }
  async waitForCompletion(id: string) {
    const type = this.roles[Number(id) - 1];
    return completed(id, type, type === "qa" ? this.qaReplies.shift() ?? pass : pass);
  }
  async stop() { return { settled: true }; }
}

async function fixture(context: TestContext, flow: ResolvedConfig["defaultFlow"],
  interrupted = false) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-progress-"));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const boardDir = join(cwd, ".tasks");
  await mkdir(boardDir);
  const status = interrupted ? "已中断" : "待实现";
  const body = interrupted ? "\n## 实现记录\n实现已完成\n" : "";
  await writeFile(join(boardDir, taskFile), `# T-001：进度\n- 状态：${status}\n${body}`);
  const rpc = new FakeRpc();
  const events: RunProgress[] = [];
  const deps: EngineDeps = {
    cwd, boardDir, config: config(flow), rpc: rpc as unknown as RpcClientLike,
    onProgress: progress => events.push(progress),
  };
  return { deps, events, rpc };
}

type Step = readonly [stage: ProgressStage, rounds: number, fixRoundsUsed: number];

function assertProgress(events: RunProgress[], summary: RunSummary, steps: readonly Step[]) {
  assert.equal(summary.status, "通过");
  assert.deepEqual(events, steps.map(([stage, rounds, fixRoundsUsed]) => ({
    runId: summary.runId, taskId: summary.taskId, stage, rounds, fixRoundsUsed, fixBudget: 1,
    ...(stage !== "gate" && { activeRole: stage }),
  })));
}

test("small flow reports coder, gate and QA", async context => {
  const { deps, events } = await fixture(context, "small");
  const summary = await runConfiguredFlow(deps, { taskFile });
  assertProgress(events, summary, [["coder", 1, 0], ["gate", 1, 0], ["qa", 1, 0]]);
});

test("big flow reports architect through reviewer", async context => {
  const { deps, events } = await fixture(context, "big");
  const summary = await runConfiguredFlow(deps, { taskFile });
  assertProgress(events, summary, [
    ["architect", 0, 0], ["coder", 1, 0], ["gate", 1, 0], ["qa", 1, 0], ["reviewer", 1, 0],
  ]);
});

test("QA rejection updates the counters on the next coder spawn", async context => {
  const { deps, events, rpc } = await fixture(context, "small");
  rpc.qaReplies.push("- verdict：打回\n- 证据：测试失败\n- 打回原因：修复测试");
  const summary = await runConfiguredFlow(deps, { taskFile });
  assertProgress(events, summary, [
    ["coder", 1, 0], ["gate", 1, 0], ["qa", 1, 0],
    ["coder", 2, 1], ["gate", 2, 1], ["qa", 2, 1],
  ]);
});

test("small flow resumed at verification reports the gate first", async context => {
  const { deps, events } = await fixture(context, "small", true);
  const summary = await resumeFlow(deps, { taskFile });
  assertProgress(events, summary, [["gate", 0, 0], ["qa", 0, 0]]);
});

test("formatProgressLines renders the active role and the local gate", () => {
  const base = { taskId: "T-001", runId: "run-1", rounds: 2, fixRoundsUsed: 1, fixBudget: 3 };
  assert.deepEqual(formatProgressLines({ ...base, stage: "coder", activeRole: "coder" }), [
    "pi-team T-001 — coder", "agent: coder · fix 1/3 · round 2",
  ]);
  assert.deepEqual(formatProgressLines({ ...base, stage: "gate" }), [
    "pi-team T-001 — gate", "agent: — · fix 1/3 · round 2",
  ]);
});
