import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

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
  updateTaskFile,
  type EngineDeps,
} from "../src/engine.js";
import type { RpcClient, SpawnOptions, SubagentInfo } from "../src/rpc.js";

interface SpawnCall {
  type: string;
  prompt: string;
  options?: SpawnOptions;
}

function completed(id: string, type: string, result = ""): SubagentInfo {
  return {
    id, type, result, description: "", status: "completed",
    depth: 1, startedAt: 1, durationMs: 12, toolUses: 3,
  };
}

class FakeRpc {
  readonly calls: SpawnCall[] = [];
  readonly stopped: string[] = [];
  readonly results = new Map<string, string>();
  readonly scripts = new Map<string, SubagentInfo[]>();
  onWait?: (id: string, signal?: AbortSignal) => Promise<void>;
  protocolChecks = 0;

  async ensureProtocol() {
    this.protocolChecks++;
    return { version: 2, features: [] };
  }

  async spawn(type: string, prompt: string, options?: SpawnOptions) {
    this.calls.push({ type, prompt, options });
    return { id: `agent-${this.calls.length}` };
  }

  async waitForCompletion(
    id: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SubagentInfo> {
    assert.equal(opts?.timeoutMs, 4 * 60 * 60 * 1000);
    await this.onWait?.(id, opts?.signal);
    const call = this.calls[Number(id.slice("agent-".length)) - 1];
    return this.scripts.get(id)?.shift() ?? completed(id, call.type, this.results.get(id));
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

function config(): ResolvedConfig {
  return {
    board: ".tasks/",
    fixBudget: 2,
    defaultFlow: "small",
    securityAudit: { trigger: "label", label: "security-sensitive" },
    roles: {
      planner: role("planner"),
      architect: role("architect"),
      coder: role("coder"),
      qa: role("qa"),
      reviewer: role("reviewer"),
      "security-auditor": role("security-auditor"),
    },
  };
}

const filename = "T-001-登录接口.md";
const pass = "- verdict：通过\n- 证据：tests passed\n- 打回原因：";
const reject = "- verdict：打回\n- 证据：coverage incomplete\n- 打回原因：missing test";

async function fixture(
  context: TestContext,
  { status = "待实现", command = "true" }: { status?: string; command?: string } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-engine-"));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const boardDir = join(cwd, ".tasks");
  await mkdir(boardDir);
  const path = join(boardDir, filename);
  await writeFile(path, [
    "# T-001：登录接口",
    "",
    `- 状态：${status}`,
    "- 负责人：coder",
    "- 依赖：无",
    `- 测试命令：${command}`,
    "",
    "## 需求",
    "Implement login.",
    "",
    "## 验收标准",
    "- [ ] Login succeeds.",
    "",
    "## 实现记录",
    "",
    "## 验收结论",
    "",
  ].join("\n"));
  const rpc = new FakeRpc();
  const deps: EngineDeps = { rpc: rpc as unknown as RpcClient, cwd, boardDir, config: config() };
  const run = (signal?: AbortSignal) => runSmallFlow(deps, { taskFile: filename, signal });
  return { deps, boardDir, path, rpc, run, text: () => readFile(path, "utf8") };
}

test("the lock identifies its owner and can be reacquired after release", async (context) => {
  const { boardDir } = await fixture(context);
  const lock = await acquireRunLock(boardDir, "T-001");
  assert.match(lock.runId, new RegExp(`^run-${lock.startedAt}-[0-9a-f]{6}$`));
  await assert.rejects(acquireRunLock(boardDir, "T-002"), {
    message: `another run is active: ${lock.runId} for task T-001`,
  });
  assert.deepEqual(await readRunLock(boardDir), lock);
  await releaseRunLock(boardDir, "wrong-run-id");
  assert.deepEqual(await readRunLock(boardDir), lock);
  await releaseRunLock(boardDir, lock.runId);
  assert.equal(await readRunLock(boardDir), undefined);
  const next = await acquireRunLock(boardDir, "T-002");
  assert.equal(next.taskId, "T-002");
  await releaseRunLock(boardDir, next.runId);
});

test("a malformed lock is not an absent lock", async (context) => {
  const { boardDir } = await fixture(context);
  await writeFile(lockPath(boardDir), '{"runId":3}');
  await assert.rejects(readRunLock(boardDir));
  await assert.rejects(acquireRunLock(boardDir, "T-001"), {
    message: "another run is active: unknown run (lock file unreadable)",
  });
});

test("task lookup ignores directories, sorts suffixes, and prefers an exact name", async (context) => {
  const { boardDir } = await fixture(context);
  await mkdir(join(boardDir, "T-001-0.md"));
  assert.equal(await findTaskFile(boardDir, "T-001"), filename);
  await writeFile(join(boardDir, "T-001-a.md"), "");
  assert.equal(await findTaskFile(boardDir, "T-001"), "T-001-a.md");
  await writeFile(join(boardDir, "T-001.md"), "");
  assert.equal(await findTaskFile(boardDir, "T-001"), "T-001.md");
  assert.equal(await findTaskFile(boardDir, "T-999"), undefined);
});

test("updateTaskFile accepts each supported path form", async (context) => {
  const { boardDir, path, text } = await fixture(context);
  for (const input of [filename, `.tasks/${filename}`, `./.tasks/${filename}`, path]) {
    await context.test(input, async () => {
      await updateTaskFile(boardDir, input, () => input);
      assert.equal(await text(), input);
    });
  }
});

test("updateTaskFile cannot write outside the board", async (context) => {
  const { boardDir, deps } = await fixture(context);
  const outside = join(deps.cwd, "outside.md");
  await writeFile(outside, "original");
  await symlink(outside, join(boardDir, "link.md"));
  const update = (input: string) => updateTaskFile(boardDir, input, () => "changed");
  for (const input of ["../outside.md", "link.md", ".tasks/link.md"]) {
    await assert.rejects(update(input), /must be inside the board directory/);
  }
  await assert.rejects(update("outside.md"), { code: "ENOENT" });
  assert.equal(await readFile(outside, "utf8"), "original");
});

test("updateTaskFile reports the first ENOENT when neither path exists", async (context) => {
  const { boardDir } = await fixture(context);
  const input = ".tasks/missing.md";
  await assert.rejects(updateTaskFile(boardDir, input, () => "changed"), {
    code: "ENOENT", path: join(boardDir, input),
  });
});

test("a passing gate and QA complete the task", async (context) => {
  const { deps, path, boardDir, rpc, text } = await fixture(context);
  Object.assign(deps.config.roles.qa, { model: "qa-model", maxTurns: 8, thinking: "low" });
  rpc.results.set("agent-1", "implemented X");
  rpc.results.set("agent-2", pass);
  rpc.onWait = async (id) => {
    assert.equal((await readRunLock(boardDir))?.currentAgentId, id);
  };
  const result = await runSmallFlow(deps, { taskFile: path });
  assert.deepEqual(result, {
    taskId: "T-001", runId: result.runId, status: "通过", rounds: 1,
    fixRoundsUsed: 0, escalated: false, gatePassed: true, qaEvidence: "tests passed",
  });
  assert.equal(rpc.protocolChecks, 1);
  assert.deepEqual(rpc.calls.map((call) => call.type), ["coder", "qa"]);
  assert.deepEqual(rpc.calls[0].options, { description: "pi-team coder: T-001" });
  assert.deepEqual(rpc.calls[1].options, {
    description: "pi-team qa: T-001", model: "qa-model", maxTurns: 8, thinkingLevel: "low",
  });
  assert.match(rpc.calls[0].prompt, /Task T-001: 登录接口/);
  assert.match(rpc.calls[1].prompt, /## 实现记录\ncoder agent-1 .*:\nimplemented X/);
  const file = await text();
  assert.match(file, /^- 状态：通过$/m);
  assert.match(file, /## 实现记录\ncoder agent-1 \(12ms, 3 tool uses\):\nimplemented X/);
  assert.match(file, /## 验收结论\n- verdict：通过\n- 证据：tests passed/);
  assert.equal(await readRunLock(boardDir), undefined);
});

test("a QA rejection reaches the next coder prompt", async (context) => {
  const { rpc, run } = await fixture(context);
  rpc.results.set("agent-2", reject);
  rpc.results.set("agent-4", pass);
  const result = await run();
  assert.equal(result.status, "通过");
  assert.equal(result.rounds, 2);
  assert.equal(result.fixRoundsUsed, 1);
  assert.deepEqual(rpc.calls.map((call) => call.type), ["coder", "qa", "coder", "qa"]);
  assert.match(rpc.calls[2].prompt, /## 打回原因\nmissing test\nAddress every 打回原因 above\./);
});

test("repeated QA rejection exhausts the fix budget", async (context) => {
  const { rpc, run, text, boardDir } = await fixture(context);
  for (const id of ["agent-2", "agent-4", "agent-6"]) rpc.results.set(id, reject);
  const result = await run();
  assert.equal(result.status, "打回");
  assert.equal(result.escalated, true);
  assert.equal(result.fixRoundsUsed, 2);
  assert.equal(result.rounds, 3);
  assert.equal(rpc.calls.filter((call) => call.type === "coder").length, 3);
  const file = await text();
  assert.match(file, /^- 状态：打回$/m);
  assert.match(file, /fix budget exhausted after 2 fix rounds; escalate to a human\./);
  assert.match(file, /- 打回原因：missing test/);
  assert.equal(await readRunLock(boardDir), undefined);
});

test("real gate failures consume the budget without spawning QA", async (context) => {
  const { rpc, run, text } = await fixture(context, { command: "false" });
  const result = await run();
  assert.equal(result.gatePassed, false);
  assert.equal(result.escalated, true);
  assert.equal(result.status, "打回");
  assert.equal(result.fixRoundsUsed, 2);
  assert.equal(result.rounds, 3);
  assert.deepEqual(rpc.calls.map((call) => call.type), ["coder", "coder", "coder"]);
  assert.match(rpc.calls[1].prompt, /## 打回原因\ngate failed: false\n\(no output\)/);
  assert.match(await text(), /^- 状态：打回$/m);
});

test("the gate uses the current command and shares its budget with QA", async (context) => {
  const { deps, rpc, run, path, text, boardDir } = await fixture(context);
  rpc.onWait = async (id) => {
    if (id === "agent-1") {
      await writeFile(path, (await text()).replace("测试命令：true", "测试命令：changed"));
    }
  };
  let gates = 0;
  deps.gate = async (command, cwd) => {
    assert.equal(command, "changed");
    assert.equal(cwd, deps.cwd);
    assert.equal((await readRunLock(boardDir))?.currentAgentId, undefined);
    const passed = ++gates > 1;
    return { passed, skipped: false, timedOut: false, output: "gate output", code: passed ? 0 : 1 };
  };
  rpc.results.set("agent-3", reject);
  rpc.results.set("agent-5", "unparseable reply");
  const result = await run();
  assert.equal(result.fixRoundsUsed, 2);
  assert.equal(result.rounds, 3);
  assert.equal(result.escalated, true);
  assert.equal(result.qaEvidence, "unparseable reply");
  assert.match(await text(), /- 打回原因：QA returned no parseable verdict/);
});

test("stop marks the active task interrupted and is idempotent", async (context) => {
  const { boardDir, deps, rpc, text } = await fixture(context);
  const lock = await acquireRunLock(boardDir, "T-001");
  await updateRunLock(boardDir, { currentAgentId: "agent-7" });
  assert.deepEqual(await stopRun(deps), { stopped: true, runId: lock.runId });
  assert.deepEqual(rpc.stopped, ["agent-7"]);
  const file = await text();
  assert.match(file, /^- 状态：已中断$/m);
  assert.match(file, /## 实现记录\nstopped by \/team stop/);
  assert.equal(await readRunLock(boardDir), undefined);
  assert.deepEqual(await stopRun(deps), { stopped: false });
});

for (const name of ["coder", "qa"] as const) {
  test(`${name} isolation fails before spawning and releases the lock`, async (context) => {
    const { deps, rpc, run, boardDir } = await fixture(context);
    deps.config.roles[name].isolation = "worktree";
    await assert.rejects(run(), new RegExp(`role ${name} requests worktree isolation`));
    assert.equal(rpc.calls.length, 0);
    const lock = await acquireRunLock(boardDir, "T-001");
    await releaseRunLock(boardDir, lock.runId);
  });
}

test("a non-runnable task is untouched", async (context) => {
  const { run, boardDir, text } = await fixture(context, { status: "通过" });
  const before = await text();
  await assert.rejects(run(), { message: "task T-001 is not runnable (status: 通过)" });
  assert.equal(await text(), before);
  assert.equal(await readRunLock(boardDir), undefined);
});

test("coder failure interrupts the task without consuming a fix round", async (context) => {
  const { rpc, run, text, boardDir } = await fixture(context);
  rpc.scripts.set("agent-1", [{
    ...completed("agent-1", "coder"), status: "failed", error: "crashed",
  }]);
  const result = await run();
  assert.equal(result.status, "已中断");
  assert.equal(result.rounds, 1);
  assert.equal(result.fixRoundsUsed, 0);
  assert.equal(result.escalated, false);
  assert.equal(result.gatePassed, false);
  assert.equal(result.qaEvidence, "");
  const file = await text();
  assert.match(file, /^- 状态：已中断$/m);
  assert.match(file, /## 实现记录\ncoder agent failed: crashed/);
  assert.equal(await readRunLock(boardDir), undefined);
});

test("aborting a QA wait stops the recorded agent and preserves the coder record", async (context) => {
  const { rpc, run, text, boardDir } = await fixture(context);
  const controller = new AbortController();
  const error = new Error("waitForCompletion aborted");
  rpc.results.set("agent-1", "implemented X");
  rpc.onWait = async (id, signal) => {
    if (id === "agent-2") {
      assert.equal(signal, controller.signal);
      controller.abort();
      throw error;
    }
  };
  await assert.rejects(run(controller.signal), (caught: unknown) => caught === error);
  assert.deepEqual(rpc.stopped, ["agent-2"]);
  const file = await text();
  assert.match(file, /^- 状态：已中断$/m);
  assert.match(file, /implemented X\nrun aborted by user/);
  assert.equal(await readRunLock(boardDir), undefined);
});
