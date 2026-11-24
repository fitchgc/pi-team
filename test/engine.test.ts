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
  runBigFlow,
  runConfiguredFlow,
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

const reviewPass = "- verdict：通过\n- 证据：interface matches the design";
const reviewReject = "- verdict: 打回\n- 打回的原因：\n  src/login.ts:12 leaks credentials";

test("configured big flow shares design and runs gate, QA, then review", async (context) => {
  const { deps, rpc, text, boardDir } = await fixture(context);
  deps.config.defaultFlow = "big";
  deps.git = async () => assert.fail("unmarked big flow must skip git");
  const stages: string[] = [];
  rpc.onWait = async (id) => {
    assert.equal((await readRunLock(boardDir))?.currentAgentId, id);
    stages.push(rpc.calls[rpc.calls.length - 1].type);
  };
  deps.gate = async (command, cwd) => {
    assert.equal(command, "true");
    assert.equal(cwd, deps.cwd);
    stages.push("gate");
    return { passed: true, skipped: false, code: 0, timedOut: false, output: "ok" };
  };
  rpc.results.set("agent-1", "Use LoginResult");
  rpc.results.set("agent-2", "implemented login");
  rpc.results.set("agent-3", pass);
  rpc.results.set("agent-4", reviewPass);
  const result = await runConfiguredFlow(deps, { taskFile: filename });
  assert.deepEqual(stages, ["architect", "coder", "gate", "qa", "reviewer"]);
  assert.deepEqual(result, {
    taskId: "T-001", runId: result.runId, status: "通过", rounds: 1,
    fixRoundsUsed: 0, escalated: false, gatePassed: true, qaEvidence: "tests passed",
  });
  assert.equal(rpc.calls[1].options?.isolation, undefined);
  assert.equal(rpc.protocolChecks, 1);
  assert.match(rpc.calls[0].prompt, /Implement login\./);
  for (const call of rpc.calls.slice(1)) assert.match(call.prompt, /## 接口设计\nUse LoginResult/);
  assert.match(rpc.calls[3].prompt, /implemented login/);
  assert.match(rpc.calls[3].prompt, /## 验收结论\n- verdict：通过\n- 证据：tests passed/);
  const file = await text();
  assert.match(file, /^- 状态：通过$/m);
  assert.match(file, /## 接口设计\nUse LoginResult/);
  assert.match(file, /## 评审结论\n- verdict：通过\n- 证据：interface matches the design/);
  assert.equal(await readRunLock(boardDir), undefined);
});

test("review rejection sends feedback to the coder and repeats verification", async (context) => {
  const { deps, rpc, text } = await fixture(context);
  rpc.results.set("agent-3", pass);
  rpc.results.set("agent-4", reviewReject);
  rpc.results.set("agent-6", pass);
  rpc.results.set("agent-7", reviewPass);
  const result = await runBigFlow(deps, { taskFile: filename });
  assert.deepEqual(rpc.calls.map(call => call.type), [
    "architect", "coder", "qa", "reviewer", "coder", "qa", "reviewer",
  ]);
  assert.match(rpc.calls[4].prompt, /src\/login\.ts:12 leaks credentials/);
  assert.equal(result.status, "通过");
  assert.equal(result.rounds, 2);
  assert.equal(result.fixRoundsUsed, 1);
  assert.equal(result.escalated, false);
  assert.match(await text(), /## 评审结论\n- verdict：通过/);
});

test("QA and review spend the same fix budget and escalate on the final rejection", async (context) => {
  const { deps, rpc, text, boardDir } = await fixture(context);
  rpc.results.set("agent-3", reject);
  rpc.results.set("agent-5", pass);
  rpc.results.set("agent-6", reviewReject);
  rpc.results.set("agent-8", pass);
  rpc.results.set("agent-9", reviewReject);
  const result = await runBigFlow(deps, { taskFile: filename });
  assert.deepEqual(rpc.calls.map(call => call.type), [
    "architect", "coder", "qa", "coder", "qa", "reviewer", "coder", "qa", "reviewer",
  ]);
  assert.match(rpc.calls[3].prompt, /## 打回原因\nmissing test/);
  assert.deepEqual(result, {
    taskId: "T-001", runId: result.runId, status: "打回", rounds: 3,
    fixRoundsUsed: 2, escalated: true, gatePassed: true, qaEvidence: "tests passed",
  });
  const file = await text();
  assert.match(file, /^- 状态：打回$/m);
  assert.match(file, /fix budget exhausted after 2 fix rounds; escalate to a human\./);
  assert.match(file, /## 验收结论\n- verdict：通过/);
  assert.ok(file.includes(`## 评审结论\n${reviewReject}`));
  assert.equal(await readRunLock(boardDir), undefined);
});

test("configured small flow only spawns coder and QA", async (context) => {
  const { deps, rpc } = await fixture(context);
  rpc.results.set("agent-2", pass);
  assert.equal((await runConfiguredFlow(deps, { taskFile: filename })).status, "通过");
  assert.deepEqual(rpc.calls.map(call => call.type), ["coder", "qa"]);
});

for (const disabled of ["architect", "reviewer"] as const) {
  test(`big flow completes with ${disabled} disabled`, async (context) => {
    const { deps, rpc, text } = await fixture(context);
    deps.config.roles[disabled].enabled = false;
    const expected = ["architect", "coder", "qa", "reviewer"].filter(name => name !== disabled);
    rpc.results.set(`agent-${expected.indexOf("qa") + 1}`, pass);
    if (disabled === "architect") rpc.results.set("agent-3", reviewPass);
    const result = await runBigFlow(deps, { taskFile: filename });
    assert.equal(result.status, "通过");
    assert.equal(result.rounds, 1);
    assert.deepEqual(rpc.calls.map(call => call.type), expected);
    if (disabled === "architect") assert.match(await text(), /## 接口设计\narchitect disabled; skipped/);
    else assert.doesNotMatch(await text(), /## 评审结论/);
  });
}

async function parallelFixture(context: TestContext, dependencies = ["", ""]) {
  const setup = await fixture(context);
  const { deps, path, rpc, boardDir } = setup;
  await writeFile(path, (await setup.text()).replace("- 负责人", "- 并行：是\n- 负责人"));
  const calls: string[] = [];
  const deleted: string[] = [];
  const gitResult = (stdout = "", code = 0) => ({ stdout, stderr: "", code, timedOut: false });
  deps.git = async (args, cwd) => {
    assert.equal(cwd, deps.cwd);
    const command = args.join(" ");
    calls.push(command);
    if (command === "rev-parse --is-inside-work-tree") return gitResult("true");
    if (command === "rev-parse HEAD") return gitResult("abc");
    if (command === "config user.name") return gitResult("fitchgc");
    if (command === "config user.email") return gitResult("zhl010101@gmail.com");
    if (command.endsWith("MERGE_HEAD")) return gitResult("", 1);
    if (args[1] === "--list") return gitResult(`  ${args[2].slice(0, -1)}\n`);
    if (args[1] === "-d") deleted.push(args[2]);
    if (args[0] === "diff") return gitResult(args[1] === "--name-only" ? "login.ts" : `patch ${args[1]}`);
    return gitResult();
  };
  const plan = async () => {
    for (const [index, blockers] of dependencies.entries()) {
      const id = `T-001-${index + 1}`;
      await writeFile(join(boardDir, `${id}-login.md`), [
        `# ${id}`, "- 父任务：T-001", `- 依赖：${blockers}`, "## 需求", `Implement ${id}`,
        "## 验收标准", "Tests pass",
      ].join("\n"));
    }
  };
  rpc.onWait = async id => {
    const call = rpc.calls[Number(id.slice(6)) - 1];
    if (call.type === "planner") await plan();
    if (call.type === "qa" || call.type === "reviewer") rpc.results.set(id, pass);
  };
  rpc.results.set("agent-1", "LoginResult interface");
  deps.gate = async () => {
    calls.push("gate");
    return { passed: true, skipped: false, output: "ok", code: 0, timedOut: false };
  };
  return { ...setup, calls, deleted, gitResult, runBig: () => runBigFlow(deps, { taskFile: filename }) };
}

test("parallel coders share a wave, then merge before verification", { timeout: 5000 }, async context => {
  const { deps, rpc, boardDir, calls, deleted, text, runBig } = await parallelFixture(context);
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const onWait = rpc.onWait!;
  rpc.onWait = async id => {
    await onWait(id);
    if (!["agent-3", "agent-4"].includes(id)) return;
    if (++arrived === 2) {
      assert.deepEqual((await readRunLock(boardDir))?.currentAgentIds?.sort(), ["agent-3", "agent-4"]);
      release();
    }
    await barrier;
  };
  const summary = await runBig();
  assert.equal(summary.status, "通过");
  assert.equal(summary.rounds, 2);
  assert.deepEqual(rpc.calls.map(call => call.type), ["architect", "planner", "coder", "coder", "qa", "reviewer"]);
  assert.match(rpc.calls[1].prompt, /local-to-tickets/);
  for (const [index, call] of rpc.calls.slice(2, 4).entries()) {
    assert.match(call.prompt, /LoginResult interface/);
    assert.ok(call.prompt.includes(`Implement T-001-${index + 1}`));
    assert.equal(call.options?.isolation, "worktree");
    assert.equal(call.options?.cwd, deps.cwd);
  }
  assert.deepEqual(deleted, ["pi-agent-agent-3", "pi-agent-agent-4"]);
  assert.equal(calls.at(-1), "gate");
  assert.match(await text(), /^- 状态：通过$/m);
  assert.equal(await readRunLock(boardDir), undefined);
});

test("conflict retains the second branch and reports both diffs", async context => {
  const { deps, calls, deleted, boardDir, text, gitResult, runBig } = await parallelFixture(context);
  const normal = deps.git!;
  deps.git = async (args, cwd) => args[0] === "merge" && args.at(-1) === "pi-agent-agent-4"
    ? gitResult("CONFLICT", 1) : normal(args, cwd);
  const summary = await runBig();
  assert.equal(summary.status, "打回");
  assert.equal(summary.escalated, true);
  assert.deepEqual(deleted, ["pi-agent-agent-3"]);
  assert.ok(calls.includes("merge --abort"));
  assert.ok(!calls.includes("gate"));
  const board = await text();
  assert.match(board, /^- 状态：打回$/m);
  assert.match(board, /merge conflict: T-001-2 .* vs T-001-1/);
  for (const expected of ["login.ts", "patch pi-agent-agent-4...HEAD", "patch HEAD...pi-agent-agent-4"]) {
    assert.ok(board.includes(expected));
  }
  assert.equal(await readRunLock(boardDir), undefined);
});

test("no branch records no changes", async context => {
  const { deps, deleted, text, gitResult, runBig } = await parallelFixture(context, [""]);
  const normal = deps.git!;
  deps.git = async (args, cwd) => args[1] === "--list" ? gitResult() : normal(args, cwd);
  assert.equal((await runBig()).status, "通过");
  assert.deepEqual(deleted, []);
  assert.match(await text(), /T-001-1: no changes, nothing to merge/);
});

for (const invalid of ["non-git", "no HEAD", "isolation", "no identity"] as const) {
  test(`parallel preflight rejects ${invalid} before spawning`, async context => {
    const { deps, rpc, gitResult, runBig } = await parallelFixture(context);
    if (invalid === "isolation") deps.config.roles.coder.isolation = "off";
    else if (invalid === "no identity") deps.git = async args => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return gitResult("true");
      if (args[0] === "rev-parse" && args[1] === "HEAD") return gitResult("abc");
      return gitResult("", 1);
    };
    else deps.git = async args => invalid === "no HEAD" && args[1] !== "HEAD" ? gitResult("true") : gitResult("", 1);
    await assert.rejects(runBig(), invalid === "isolation" ? /coder isolation/ : invalid === "no identity" ? /user\.name/ : invalid === "no HEAD" ? /HEAD/ : /git worktree/);
    assert.equal(rpc.calls.length, 0);
  });
}

test("dependent coder starts after its blocker merges", async context => {
  const { rpc, deleted, runBig } = await parallelFixture(context, ["", "T-001-1"]);
  const spawn = rpc.spawn.bind(rpc);
  rpc.spawn = async (type, prompt, opts) => {
    if (type === "coder" && prompt.includes("Implement T-001-2")) assert.deepEqual(deleted, ["pi-agent-agent-3"]);
    return spawn(type, prompt, opts);
  };
  assert.equal((await runBig()).status, "通过");
});

for (const [name, blockers, message] of [
  ["empty", [], /no subtask files/], ["cycle beside a ready ticket", ["", "T-001-3", "T-001-2"], /cyclic/],
] as const) {
  test(`invalid plan: ${name}`, async context => {
    const { rpc, runBig } = await parallelFixture(context, [...blockers]);
    await assert.rejects(runBig(), message);
    assert.deepEqual(rpc.calls.map(call => call.type), ["architect", "planner"]);
  });
}

test("wave failure stops other active coders and releases the lock", { timeout: 5000 }, async context => {
  const { rpc, boardDir, runBig } = await parallelFixture(context);
  const normal = rpc.onWait!;
  let ready!: () => void;
  const both = new Promise<void>(resolve => { ready = resolve; });
  rpc.onWait = async (id, signal) => {
    if (id === "agent-3") {
      await both;
      throw new Error("wave wait failed");
    }
    if (id === "agent-4") {
      ready();
      await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
      signal!.throwIfAborted();
    }
    await normal(id, signal);
  };
  await assert.rejects(runBig(), /wave wait failed/);
  assert.deepEqual(rpc.stopped.sort(), ["agent-3", "agent-4"]);
  assert.equal(await readRunLock(boardDir), undefined);
});

test("parallel rejection spends one main-checkout fix round", async context => {
  const { deps, rpc, runBig, text } = await parallelFixture(context, [""]);
  const normal = deps.gate!;
  let attempts = 0;
  deps.gate = async (...args) => ++attempts === 1
    ? { passed: false, skipped: false, output: "broken login", code: 1, timedOut: false } : normal(...args);
  const summary = await runBig();
  assert.equal(summary.status, "通过");
  assert.equal(summary.fixRoundsUsed, 1);
  const coders = rpc.calls.filter(call => call.type === "coder");
  assert.deepEqual(coders.map(call => call.options?.isolation), ["worktree", undefined]);
  assert.match(coders[1].prompt, /broken login/);
  assert.match(await text(), /T-001-1: merged/);
});
