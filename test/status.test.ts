import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ResolvedConfig, RoleDefinition, RoleName } from "../src/config.js";
import { acquireRunLock, readRunLock, runSmallFlow, updateRunLock } from "../src/engine.js";
import type { RpcClient, SubagentInfo } from "../src/rpc.js";
import { formatRunStatus, getRunStatus, type RunStatus } from "../src/status.js";

const taskId = "T-001";
const filename = `${taskId}-登录接口.md`;
const header = `# ${taskId}：登录接口\n- 状态：待实现\n`;

function role(name: RoleName): RoleDefinition {
  return {
    name, enabled: true, description: "", prompt: "", tools: [], skills: [],
    source: "package-default", jsonIgnored: false,
  };
}

async function fixture(context: TestContext, sections = "") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-status-"));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const config: ResolvedConfig = {
    board: ".tasks/", fixBudget: 2, defaultFlow: "small",
    subagents: "herbertgao",
    securityAudit: { trigger: "label", label: "security-sensitive" },
    roles: {
      planner: role("planner"), architect: role("architect"), coder: role("coder"),
      qa: role("qa"), reviewer: role("reviewer"), "security-auditor": role("security-auditor"),
    },
  };
  const boardDir = join(cwd, config.board);
  await mkdir(boardDir);
  const path = join(boardDir, filename);
  await writeFile(path, header + sections);
  return { cwd, boardDir, config, path };
}

test("status is undefined without a run lock", async context => {
  assert.equal(await getRunStatus(await fixture(context)), undefined);
});

test("status combines the active lock, task sections, and configured budget", async context => {
  const deps = await fixture(context, [
    "## 接口设计\n接口已定", "## 实现记录\n实现完成", "## 验收结论\n通过",
    "## 评审结论\n通过", "## 安全审计\n通过",
  ].join("\n"));
  const lock = await acquireRunLock(deps.boardDir, taskId);
  await updateRunLock(deps.boardDir, { currentAgentId: "agent-1", currentRoles: ["qa"], fixRoundsUsed: 1 });
  assert.deepEqual(await getRunStatus(deps), {
    runId: lock.runId, taskId, taskTitle: "登录接口", startedAt: lock.startedAt, taskStatus: "待实现",
    stages: { architect: true, coder: true, qa: true, reviewer: true, "security-auditor": true },
    activeAgents: [{ id: "agent-1", role: "qa" }],
    fixBudgetTotal: deps.config.fixBudget, fixBudgetRemaining: deps.config.fixBudget - 1,
  });
});

test("locks without roles use the single and parallel defaults", async context => {
  const deps = await fixture(context);
  await acquireRunLock(deps.boardDir, taskId);
  await updateRunLock(deps.boardDir, { currentAgentId: "one" });
  assert.deepEqual((await getRunStatus(deps))?.activeAgents, [{ id: "one", role: "unknown" }]);
  await updateRunLock(deps.boardDir, { currentAgentId: undefined, currentAgentIds: ["two", "three"] });
  assert.deepEqual((await getRunStatus(deps))?.activeAgents, [
    { id: "two", role: "coder" }, { id: "three", role: "coder" },
  ]);
});

test("a deleted task still reports the active run with pending stages", async context => {
  const deps = await fixture(context);
  const lock = await acquireRunLock(deps.boardDir, taskId);
  await rm(deps.path);
  const status = await getRunStatus(deps);
  assert.ok(status);
  assert.equal(status.taskTitle, undefined);
  assert.equal(status.taskStatus, undefined);
  assert.deepEqual(status.stages, {
    architect: false, coder: false, qa: false, reviewer: false, "security-auditor": false,
  });
  const lines = formatRunStatus(status, lock.startedAt + 59999).split("\n");
  assert.equal(lines[1], `task: ${taskId}`);
  assert.match(lines[2], / \(<1m ago\)$/);
  assert.equal(lines[3], "status: unknown");
  assert.equal(lines[5], "active: none (between stages)");
});

test("remaining fix budget clamps at zero", async context => {
  const deps = await fixture(context);
  await acquireRunLock(deps.boardDir, taskId);
  await updateRunLock(deps.boardDir, { fixRoundsUsed: deps.config.fixBudget + 1 });
  assert.equal((await getRunStatus(deps))?.fixBudgetRemaining, 0);
});

test("formats the complete report with elapsed whole minutes", () => {
  const startedAt = new Date(2026, 0, 2, 3, 4, 5).getTime();
  const status: RunStatus = {
    runId: "run-1", taskId, taskTitle: "登录接口", startedAt, taskStatus: "实现中",
    stages: { architect: true, coder: false, qa: true, reviewer: false, "security-auditor": false },
    activeAgents: [{ role: "coder", id: "one" }, { role: "coder", id: "two" }],
    fixBudgetRemaining: 1, fixBudgetTotal: 2,
  };
  const start = new Date(startedAt).toLocaleString("zh-CN", { hour12: false });
  assert.equal(formatRunStatus(status, startedAt + 179999), [
    "pi-team run run-1",
    "task: T-001 登录接口",
    `started: ${start} (2m ago)`,
    "status: 实现中",
    "stages: architect done, coder pending, qa done, reviewer pending, security-auditor pending",
    "active: coder (one), coder (two)",
    "fix budget: 1 of 2 remaining",
  ].join("\n"));
});

function completed(id: string, result: string): SubagentInfo {
  return {
    id, type: id, result, description: "", status: "completed",
    depth: 1, startedAt: 1, durationMs: 12, toolUses: 3,
  };
}

test("small flow persists both QA fix rounds while the run is active", async context => {
  const deps = await fixture(context);
  let rejections = 0;
  let persisted: number | undefined;
  const rpc = {
    async ensureProtocol() { return { version: 2, features: [] }; },
    async spawn(type: string) { return { id: type }; },
    async waitForCompletion(id: string) {
      if (id === "qa" && rejections < 2) {
        rejections++;
        return completed(id, "- verdict：打回\n- 证据：覆盖不足\n- 打回原因：缺少测试");
      }
      if (id === "coder" && rejections === 2) {
        persisted = (await readRunLock(deps.boardDir))?.fixRoundsUsed;
      }
      return completed(id, id === "qa" ? "- verdict：通过\n- 证据：测试通过" : "实现完成");
    },
    async stop() { return { settled: true }; },
  };
  const summary = await runSmallFlow(
    { ...deps, rpc: rpc as unknown as RpcClient },
    { taskFile: filename },
  );
  assert.equal(summary.status, "通过");
  assert.equal(rejections, 2);
  assert.equal(persisted, 2);
});
