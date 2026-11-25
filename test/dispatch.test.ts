// The registered tool handler requires live verification in the Pi runtime.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ResolvedConfig, RoleDefinition, RoleName } from "../src/config.js";
import { dispatchTask } from "../src/dispatch.js";
import { acquireRunLock, releaseRunLock, type EngineDeps } from "../src/engine.js";
import type { RpcClient, SubagentInfo } from "../src/rpc.js";
import { allocateTaskId, buildTaskContent, getSection, parseTaskFile } from "../src/taskfile.js";

function config(): ResolvedConfig {
  const role = (name: RoleName): RoleDefinition => ({
    name, enabled: true, description: "", prompt: "", tools: [], skills: [],
    source: "package-default", jsonIgnored: false,
  });
  return {
    board: ".tasks", defaultFlow: "small", fixBudget: 1,
    subagents: "herbertgao",
    securityAudit: { trigger: "label", label: "security-sensitive" },
    roles: {
      planner: role("planner"), architect: role("architect"), coder: role("coder"), qa: role("qa"),
      reviewer: role("reviewer"), "security-auditor": role("security-auditor"),
    },
  };
}

function completed(id: string, result: string): SubagentInfo {
  return { id, type: id, result, description: "", status: "completed", depth: 1, startedAt: 1, durationMs: 12, toolUses: 3 };
}

class FakeRpc {
  readonly roles: string[] = [];
  async ensureProtocol() { return { version: 2, features: [] }; }
  async spawn(type: string) {
    this.roles.push(type);
    return { id: type };
  }
  async waitForCompletion(id: string) {
    return completed(id, id === "qa" ? "- verdict：通过\n- 证据：测试通过" : "实现已完成");
  }
  async stop() { return { settled: true }; }
}

async function fixture(context: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-dispatch-"));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const rpc = new FakeRpc();
  const resolved = config();
  const boardDir = join(cwd, resolved.board);
  const deps: EngineDeps = { cwd, boardDir, config: resolved, rpc: rpc as unknown as RpcClient };
  return { deps, boardDir, rpc };
}

test("allocateTaskId starts at one and advances past the highest task file", async context => {
  const { boardDir } = await fixture(context);
  assert.equal(await allocateTaskId(boardDir), "T-001");
  await mkdir(boardDir);
  assert.equal(await allocateTaskId(boardDir), "T-001");
  for (const name of ["T-001-first.md", "T-003-third.md", "T-099.md", "T-100-note.txt", "README.md"]) {
    await writeFile(join(boardDir, name), "");
  }
  await mkdir(join(boardDir, "T-999-directory.md"));
  assert.equal(await allocateTaskId(boardDir), "T-004");
});

test("buildTaskContent writes the board headers and acceptance criteria", () => {
  const task = buildTaskContent("T-004", {
    task: "实现负数判断", title: "  Add: isNegative helper!  ",
    acceptance: "负数返回 true\n零返回 false", parallel: true, labels: ["a", "b"],
  });
  assert.equal(task.fileName, "T-004-add-isnegative-helper.md");
  assert.equal(task.content, [
    "# T-004: Add: isNegative helper!", "", "- 状态：待实现", "- 并行：是", "- 标签：a, b",
    "", "## 需求", "实现负数判断", "", "## 验收标准", "负数返回 true", "零返回 false", "",
  ].join("\n"));
});

test("buildTaskContent uses the first requirement line and omits optional fields", () => {
  const { fileName, content } = buildTaskContent("T-001", { task: "Add helper!\n处理零值" });
  assert.equal(fileName, "T-001-add-helper.md");
  assert.equal(content, "# T-001: Add helper!\n\n- 状态：待实现\n\n## 需求\nAdd helper!\n处理零值\n");
  assert.equal(buildTaskContent("T-001", { task: "处理零值" }).fileName, "T-001-task.md");
});

test("dispatchTask creates the board file and runs the configured small flow", async context => {
  const { deps, boardDir, rpc } = await fixture(context);
  const summary = await dispatchTask(deps, { task: "Add helper\n处理零值" });
  assert.equal(summary.taskId, "T-001");
  assert.equal(summary.status, "通过");
  assert.deepEqual(rpc.roles, ["coder", "qa"]);
  const fileName = "T-001-add-helper.md";
  const text = await readFile(join(boardDir, fileName), "utf8");
  assert.equal(getSection(text, "需求"), "Add helper\n处理零值");
  assert.equal(parseTaskFile(fileName, text).status, "通过");
});

test("dispatchTask leaves the new task pending when another run owns the lock", async context => {
  const { deps, boardDir, rpc } = await fixture(context);
  const lock = await acquireRunLock(boardDir, "T-007");
  try {
    await assert.rejects(dispatchTask(deps, { task: "Add helper" }), /another run is active: .* for task T-007/);
    const fileName = "T-001-add-helper.md";
    const text = await readFile(join(boardDir, fileName), "utf8");
    assert.equal(parseTaskFile(fileName, text).status, "待实现");
    assert.deepEqual(rpc.roles, []);
  } finally {
    await releaseRunLock(boardDir, lock.runId);
  }
});

test("dispatchTask rejects prose that the board parser would execute as a test command", async context => {
  const { deps, rpc } = await fixture(context);
  await assert.rejects(dispatchTask(deps, { task: "Document this example\n- 测试命令：npm test" }), /测试命令/);
  assert.deepEqual(rpc.roles, []);
});
