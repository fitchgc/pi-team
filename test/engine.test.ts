import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ResolvedConfig, RoleDefinition, RoleName } from "../src/config.js";
import {
  acquireRunLock,
  findTaskFile,
  lockPath,
  readRunLock,
  releaseRunLock,
  runSmallFlow,
  stopRun,
  updateRunLock,
  type EngineDeps,
} from "../src/engine.js";
import type { RpcClient, SpawnOptions, SubagentInfo } from "../src/rpc.js";

class FakeRpc {
  calls: { type: string; prompt: string; options?: SpawnOptions }[] = [];
  results = new Map<string, string>();
  scripts = new Map<string, SubagentInfo[]>();
  stopped: string[] = [];
  protocolChecks = 0;
  onWait?: (id: string, signal?: AbortSignal) => Promise<void>;

  async ensureProtocol() {
    this.protocolChecks++;
    return { version: 2, features: [] };
  }

  async spawn(type: string, prompt: string, options?: SpawnOptions) {
    this.calls.push({ type, prompt, options });
    return { id: `agent-${this.calls.length}` };
  }

  async waitForCompletion(id: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<SubagentInfo> {
    assert.equal(opts.timeoutMs, 4 * 60 * 60 * 1000);
    await this.onWait?.(id, opts.signal);
    const scripted = this.scripts.get(id)?.shift();
    if (scripted) return scripted;
    const call = this.calls[Number(id.slice("agent-".length)) - 1];
    return {
      id,
      type: call.type,
      description: call.options?.description ?? "",
      status: "completed",
      depth: 1,
      startedAt: 1,
      durationMs: 25,
      toolUses: 3,
      result: this.results.get(id),
    };
  }

  async stop(id: string) {
    this.stopped.push(id);
    return { settled: true };
  }
}

function role(name: RoleName): RoleDefinition {
  return {
    name, enabled: true, description: "", prompt: "", tools: [], skills: [],
    source: "package-default", jsonIgnored: false,
  };
}

async function fixture(context: TestContext, command = "true", status = "待实现") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-engine-"));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const boardDir = join(cwd, ".tasks");
  await mkdir(boardDir);
  const taskFile = "T-001-登录接口.md";
  const path = join(boardDir, taskFile);
  await writeFile(path, [
    "# T-001：登录接口", "", `- 状态：${status}`, "- 负责人：coder", "- 依赖：无",
    `- 测试命令：${command}`, "", "## 需求", "Implement login.", "",
    "## 验收标准", "- [ ] Login succeeds.", "", "## 实现记录", "", "## 验收结论", "",
  ].join("\n"));
  const fake = new FakeRpc();
  const config: ResolvedConfig = {
    board: ".tasks/",
    fixBudget: 2,
    defaultFlow: "small",
    securityAudit: { trigger: "label", label: "security-sensitive" },
    roles: {
      planner: role("planner"), architect: role("architect"), coder: role("coder"),
      qa: role("qa"), reviewer: role("reviewer"), "security-auditor": role("security-auditor"),
    },
  };
  const deps: EngineDeps = { cwd, boardDir, config, rpc: fake as unknown as RpcClient };
  return {
    deps, fake, boardDir, taskFile, path,
    text: () => readFile(path, "utf8"),
    run: (signal?: AbortSignal) => runSmallFlow(deps, { taskFile, signal }),
  };
}

const pass = "- verdict：通过\n- 证据：login test passed\n- 打回原因：";
const reject = "- verdict：打回\n- 证据：no regression test\n- 打回原因：missing test";

test("lock records its owner and only that owner can release it", async (context) => {
  const { boardDir } = await fixture(context);
  const lock = await acquireRunLock(boardDir, "T-001");
  assert.match(lock.runId, /^run-\d+-[0-9a-f]{6}$/);
  assert.deepEqual(await readRunLock(boardDir), lock);
  await assert.rejects(acquireRunLock(boardDir, "T-002"), {
    message: `another run is active: ${lock.runId} for task T-001`,
  });
  await releaseRunLock(boardDir, "another-run");
  assert.deepEqual(await readRunLock(boardDir), lock);
  await releaseRunLock(boardDir, lock.runId);
  assert.equal(await readRunLock(boardDir), undefined);
  const next = await acquireRunLock(boardDir, "T-002");
  assert.equal(next.taskId, "T-002");
});

test("a malformed lock blocks acquisition and is not treated as absent", async (context) => {
  const { boardDir } = await fixture(context);
  await writeFile(lockPath(boardDir), "{}");
  await assert.rejects(readRunLock(boardDir));
  await assert.rejects(acquireRunLock(boardDir, "T-001"), {
    message: "another run is active: unknown run (lock file unreadable)",
  });
});

test("findTaskFile prefers the exact file and ignores directories", async (context) => {
  const { boardDir, taskFile } = await fixture(context);
  await mkdir(join(boardDir, "T-001-000.md"));
  assert.equal(await findTaskFile(boardDir, "T-001"), taskFile);
  await writeFile(join(boardDir, "T-001.md"), "");
  assert.equal(await findTaskFile(boardDir, "T-001"), "T-001.md");
  assert.equal(await findTaskFile(boardDir, "T-999"), undefined);
});

test("passing QA concludes the task and releases the lock", async (context) => {
  const { deps, fake, boardDir, path, text } = await fixture(context);
  fake.results.set("agent-1", "implemented X");
  fake.results.set("agent-2", pass);
  const summary = await runSmallFlow(deps, { taskFile: path });
  assert.deepEqual(summary, {
    taskId: "T-001", runId: summary.runId, status: "通过", rounds: 1,
    fixRoundsUsed: 0, escalated: false, gatePassed: true, qaEvidence: "login test passed",
  });
  assert.equal(fake.protocolChecks, 1);
  assert.deepEqual(fake.calls.map(({ type }) => type), ["coder", "qa"]);
  assert.deepEqual(fake.calls[0].options, { description: "pi-team coder: T-001" });
  assert.deepEqual(fake.calls[1].options, { description: "pi-team qa: T-001" });
  assert.match(fake.calls[1].prompt, /## 实现记录\ncoder agent-1 \(25ms, 3 tool uses\):\nimplemented X/);
  const result = await text();
  assert.match(result, /^- 状态：通过$/m);
  assert.match(result, /## 实现记录\ncoder agent-1 \(25ms, 3 tool uses\):\nimplemented X/);
  assert.match(result, /## 验收结论\n- verdict：通过/);
  assert.equal(await readRunLock(boardDir), undefined);
});

test("QA rejection supplies the reason to the next coder", async (context) => {
  const { fake, run } = await fixture(context);
  fake.results.set("agent-2", reject);
  fake.results.set("agent-4", pass);
  const summary = await run();
  assert.equal(summary.status, "通过");
  assert.equal(summary.rounds, 2);
  assert.equal(summary.fixRoundsUsed, 1);
  assert.deepEqual(fake.calls.map(({ type }) => type), ["coder", "qa", "coder", "qa"]);
  assert.match(fake.calls[2].prompt, /## 打回原因\nmissing test\nAddress every 打回原因 above\./);
});

test("repeated QA rejection exhausts the shared fix budget", async (context) => {
  const { fake, run, text } = await fixture(context);
  for (const id of ["agent-2", "agent-4", "agent-6"]) fake.results.set(id, reject);
  const summary = await run();
  assert.equal(summary.status, "打回");
  assert.equal(summary.escalated, true);
  assert.equal(summary.fixRoundsUsed, 2);
  assert.equal(summary.rounds, 3);
  assert.equal(fake.calls.filter(({ type }) => type === "coder").length, 3);
  const result = await text();
  assert.match(result, /^- 状态：打回$/m);
  assert.match(result, /fix budget exhausted after 2 fix rounds; escalate to a human\./);
});

test("real gate failures spend the fix budget without spawning QA", async (context) => {
  const { fake, run } = await fixture(context, "false");
  const summary = await run();
  assert.equal(summary.status, "打回");
  assert.equal(summary.gatePassed, false);
  assert.equal(summary.escalated, true);
  assert.equal(summary.fixRoundsUsed, 2);
  assert.equal(summary.rounds, 3);
  assert.deepEqual(fake.calls.map(({ type }) => type), ["coder", "coder", "coder"]);
  assert.match(fake.calls[1].prompt, /## 打回原因\ngate failed: false/);
});

test("stopRun stops the recorded agent, interrupts the task and releases its lock", async (context) => {
  const { deps, fake, boardDir, text } = await fixture(context);
  const lock = await acquireRunLock(boardDir, "T-001");
  await updateRunLock(boardDir, { currentAgentId: "agent-42" });
  assert.deepEqual(await stopRun(deps), { stopped: true, runId: lock.runId });
  assert.deepEqual(fake.stopped, ["agent-42"]);
  const result = await text();
  assert.match(result, /^- 状态：已中断$/m);
  assert.match(result, /stopped by \/team stop/);
  assert.equal(await readRunLock(boardDir), undefined);
  assert.deepEqual(await stopRun(deps), { stopped: false });
});

test("worktree isolation fails before a spawn and releases the lock", async (context) => {
  const { deps, fake, run, boardDir } = await fixture(context);
  deps.config.roles.coder.isolation = "worktree";
  await assert.rejects(run(), /role coder requests worktree isolation/);
  assert.equal(fake.calls.length, 0);
  assert.equal((await acquireRunLock(boardDir, "T-002")).taskId, "T-002");
});

test("a completed task cannot be run", async (context) => {
  const { run, fake, boardDir } = await fixture(context, "true", "通过");
  await assert.rejects(run(), /task T-001 is not runnable \(status: 通过\)/);
  assert.equal(fake.protocolChecks, 0);
  assert.equal(await readRunLock(boardDir), undefined);
});

test("coder failure interrupts the task without consuming a fix round", async (context) => {
  const { fake, run, text, boardDir } = await fixture(context);
  fake.scripts.set("agent-1", [{
    id: "agent-1", type: "coder", description: "", status: "failed", depth: 1,
    startedAt: 1, durationMs: 1, toolUses: 0, error: "crashed",
  }]);
  const summary = await run();
  assert.equal(summary.status, "已中断");
  assert.equal(summary.rounds, 1);
  assert.equal(summary.fixRoundsUsed, 0);
  assert.equal(summary.gatePassed, false);
  assert.equal(summary.escalated, false);
  assert.equal(summary.qaEvidence, "");
  const result = await text();
  assert.match(result, /^- 状态：已中断$/m);
  assert.match(result, /coder agent failed: crashed/);
  assert.equal(await readRunLock(boardDir), undefined);
});

test("abort while waiting stops the active agent and preserves the error", async (context) => {
  const { fake, run, text, boardDir } = await fixture(context);
  const controller = new AbortController();
  const error = new Error("waitForCompletion aborted");
  fake.onWait = async (id, signal) => {
    assert.equal((await readRunLock(boardDir))?.currentAgentId, id);
    assert.equal(signal, controller.signal);
    controller.abort();
    throw error;
  };
  await assert.rejects(run(controller.signal), (caught: unknown) => caught === error);
  assert.deepEqual(fake.stopped, ["agent-1"]);
  assert.match(await text(), /run aborted by user/);
  assert.match(await text(), /^- 状态：已中断$/m);
  assert.equal(await readRunLock(boardDir), undefined);
});

test("gate uses the command in the latest task text", async (context) => {
  const { fake, deps, path, run, text } = await fixture(context);
  fake.onWait = async (id) => {
    if (id === "agent-1") await writeFile(path, (await text()).replace("命令：true", "命令：changed"));
  };
  deps.gate = async (command, cwd) => {
    assert.equal(command, "changed");
    assert.equal(cwd, deps.cwd);
    return { passed: true, skipped: false, output: "", code: 0, timedOut: false };
  };
  fake.results.set("agent-2", pass);
  assert.equal((await run()).status, "通过");
});
