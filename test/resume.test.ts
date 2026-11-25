import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ResolvedConfig, RoleDefinition, RoleName } from "../src/config.js";
import { needsSecurityAudit, readRunLock, type EngineDeps } from "../src/engine.js";
import { runGate } from "../src/gate.js";
import { deriveStartStage, resumeFlow } from "../src/resume.js";
import type { RpcClient, SubagentInfo } from "../src/rpc.js";
import { getSection, parseTaskFile } from "../src/taskfile.js";

const taskFile = "T-001-resume.md";
const label = "security-sensitive";
const pass = "- verdict：通过\n- 证据：tests passed";
const design = "\n## 接口设计\noriginal interface\n";
const record = "\n## 实现记录\noriginal implementation\n";
const acceptance = `\n## 验收结论\n${pass}\n`;
const review = `\n## 评审结论\n${pass}\nreview details\n`;
const audit = `\n## 安全审计\n${pass}\n`;

function config(defaultFlow: ResolvedConfig["defaultFlow"] = "small"): ResolvedConfig {
  const role = (name: RoleName): RoleDefinition => ({
    name, enabled: true, description: "", prompt: "", tools: [], skills: [],
    source: "package-default", jsonIgnored: false,
  });
  return {
    board: ".tasks/", fixBudget: 1, defaultFlow, securityAudit: { trigger: "label", label },
    roles: {
      planner: role("planner"), architect: role("architect"), coder: role("coder"), qa: role("qa"),
      reviewer: role("reviewer"), "security-auditor": role("security-auditor"),
    },
  };
}

test("deriveStartStage follows board order and ignores blank sections", () => {
  const settings = config("big");
  const stage = (body: string, header = "") => {
    const text = `# T-001\n${header}\n${body}`;
    return deriveStartStage(parseTaskFile(taskFile, text), text, settings);
  };
  const verified = design + record + acceptance;
  const sensitive = `- 标签：${label}`;
  assert.equal(stage(verified + review + audit, "- 并行：是"), "coder");
  assert.equal(stage(""), "architect");
  settings.roles.architect.enabled = false;
  assert.equal(stage(""), "coder");
  settings.roles.architect.enabled = true;
  assert.equal(stage(design), "coder");
  assert.equal(stage(design + record + "\n## 验收结论\n \t\n"), "verify");
  assert.equal(stage(verified, sensitive), "reviewer");
  settings.roles.reviewer.enabled = false;
  assert.equal(stage(verified, sensitive), "auditor");
  assert.equal(stage(verified + review + audit, sensitive), "verify");
  assert.equal(stage(verified + review + audit), "verify");
  assert.equal(stage(verified), "verify");
});

test("needsSecurityAudit respects the trigger, labels and role switch", () => {
  const settings = config();
  assert.equal(needsSecurityAudit(settings, [label]), true);
  assert.equal(needsSecurityAudit(settings, ["other"]), false);
  settings.securityAudit.trigger = "never";
  assert.equal(needsSecurityAudit(settings, [label]), false);
  settings.securityAudit.trigger = "always";
  assert.equal(needsSecurityAudit(settings), true);
  settings.roles["security-auditor"].enabled = false;
  assert.equal(needsSecurityAudit(settings, [label]), false);
});

function completed(id: string, type: string, result: string): SubagentInfo {
  return { id, type, result, description: "", status: "completed", depth: 1, startedAt: 1, durationMs: 12, toolUses: 3 };
}

class FakeRpc {
  readonly calls: { type: string; prompt: string }[] = [];
  readonly qaReplies: string[] = [];
  async ensureProtocol() { return { version: 2, features: [] }; }
  async spawn(type: string, prompt: string) {
    this.calls.push({ type, prompt });
    return { id: String(this.calls.length) };
  }
  async waitForCompletion(id: string) {
    const { type } = this.calls[Number(id) - 1];
    const info = completed(id, type, type === "qa" ? this.qaReplies.shift() ?? pass : pass);
    return type === "planner" ? { ...info, status: "error", error: "planner interrupted" } : info;
  }
  async stop() { return { settled: true }; }
}

async function fixture(context: TestContext, flow: ResolvedConfig["defaultFlow"], body: string,
  header = "", status = "已中断") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-resume-"));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const boardDir = join(cwd, ".tasks");
  await mkdir(boardDir);
  const path = join(boardDir, taskFile);
  await writeFile(path, `# T-001：恢复\n- 状态：${status}\n${header}\n${body}`);
  const rpc = new FakeRpc();
  let gates = 0;
  const deps: EngineDeps = {
    cwd, boardDir, config: config(flow), rpc: rpc as unknown as RpcClient,
    gate: async () => { gates++; return runGate(undefined, cwd); },
  };
  return {
    deps, rpc, gates: () => gates, agents: () => rpc.calls.map(call => call.type),
    run: () => resumeFlow(deps, { taskFile }), text: () => readFile(path, "utf8"),
  };
}

for (const [stage, flow, body, header, agents, gates] of [
  ["coder", "big", design, "", ["coder", "qa", "reviewer"], 1],
  ["verify", "small", record, "", ["qa"], 1],
  ["reviewer", "big", design + record + acceptance, "", ["reviewer"], 0],
  ["auditor", "small", record + acceptance, `- 标签：${label}`, ["security-auditor"], 0],
  ["auditor", "big", design + record + acceptance + review, `- 标签：${label}`, ["security-auditor"], 0],
] as const) {
  test(`${flow} resumes at ${stage}`, async context => {
    const board = await fixture(context, flow, body, header);
    if (!gates) board.deps.gate = async () => assert.fail("gate must not run");
    const summary = await board.run();
    const text = await board.text();
    assert.equal(summary.status, "通过");
    assert.equal(parseTaskFile(taskFile, text).status, summary.status);
    assert.equal(summary.gatePassed, true);
    assert.equal(summary.qaEvidence, "tests passed");
    assert.equal(summary.rounds, stage === "coder" ? 1 : 0);
    assert.equal(summary.fixRoundsUsed, 0);
    assert.equal(board.gates(), gates);
    assert.deepEqual(board.agents(), agents);
    if (stage === "coder") {
      assert.equal(getSection(text, "接口设计"), "original interface");
      assert.ok(board.rpc.calls[0].prompt.startsWith("## 接口设计\noriginal interface\n\n"));
    } else {
      assert.equal(getSection(text, "实现记录"), "original implementation");
    }
    if (stage === "reviewer") assert.ok(board.rpc.calls[0].prompt.includes(acceptance.trim()));
    if (stage === "auditor") assert.equal(getSection(text, "安全审计"), pass);
    if (stage === "auditor" && flow === "big") assert.equal(getSection(text, "评审结论"), `${pass}\nreview details`);
    assert.equal(await readRunLock(board.deps.boardDir), undefined);
  });
}

test("resume rejects a non-interrupted task without changing the board", async context => {
  const board = await fixture(context, "small", record, "", "通过");
  const before = await board.text();
  await assert.rejects(board.run(), /task T-001 is not interrupted \(status: 通过\); use \/team run to start it/);
  assert.equal(await board.text(), before);
  assert.deepEqual(board.agents(), []);
});

test("parallel resume starts the planner even with a completed board", async context => {
  const board = await fixture(context, "big", design + record + acceptance + review + audit, "- 并行：是");
  board.deps.git = async () => ({ code: 0, stdout: "true", stderr: "", timedOut: false });
  assert.equal((await board.run()).status, "已中断");
  assert.deepEqual(board.agents(), ["planner"]);
  assert.match(await board.text(), /planner interrupted/);
});

test("a rejection after resume spends a fresh fix round and runs the coder", async context => {
  const board = await fixture(context, "small", record);
  board.rpc.qaReplies.push("- verdict：打回\n- 打回原因：missing test", pass);
  const summary = await board.run();
  assert.equal(summary.status, "通过");
  assert.equal(summary.fixRoundsUsed, 1);
  assert.equal(summary.rounds, 1);
  assert.deepEqual(board.agents(), ["qa", "coder", "qa"]);
  assert.equal(board.gates(), 2);
  assert.match(board.rpc.calls[1].prompt, /missing test/);
});

test("reviewer resume requires a passing QA verdict", async context => {
  const board = await fixture(context, "big", design + record + "\n## 验收结论\ninconclusive\n");
  await assert.rejects(board.run(), /cannot resume task T-001: 验收结论 is not a passing verdict/);
  assert.deepEqual(board.agents(), []);
});
