import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ResolvedConfig, RoleDefinition, RoleName } from "../src/config.js";
import { dispatchTask } from "../src/dispatch.js";
import { runConfiguredFlow, type EngineDeps } from "../src/engine.js";
import type { AgentCost, RpcClientLike, SubagentInfo } from "../src/rpc.js";

const taskFile = "T-001-cost.md";
const pass = "- verdict：通过\n- 证据：测试通过";

function config(subagents: ResolvedConfig["subagents"]): ResolvedConfig {
  const role = (name: RoleName): RoleDefinition => ({
    name, enabled: true, description: "", prompt: "", tools: [], skills: [],
    source: "package-default", jsonIgnored: false,
  });
  return {
    subagents, board: ".tasks/", defaultFlow: "small", fixBudget: 1,
    securityAudit: { trigger: "never", label: "security-sensitive" },
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
  readonly roles: string[] = [];
  constructor(readonly backend: RpcClientLike["backend"] = "herbertgao") {}
  async ensureProtocol() { return { version: this.backend === "official" ? 1 : 2, features: [] }; }
  async spawn(type: string) { return { id: String(this.roles.push(type)) }; }
  async waitForCompletion(id: string) {
    const type = this.roles[Number(id) - 1] ?? "";
    return completed(id, type, type === "qa" ? pass : "done");
  }
  async stop() { return { settled: false }; }
}

const coder = { costUsd: 0.008, inputTokens: 20, outputTokens: 5 };
const qa = { costUsd: 0.0043, inputTokens: 10, outputTokens: 3 };
class CostRpc extends FakeRpc {
  constructor(private readonly qaCost?: AgentCost) { super("official"); }
  async cost(id: string) { return id === "1" ? coder : this.qaCost; }
}

async function fixture(context: TestContext, rpc: FakeRpc): Promise<EngineDeps> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-cost-"));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const boardDir = join(cwd, ".tasks");
  await mkdir(boardDir);
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi", "team.json"), JSON.stringify({ subagents: rpc.backend }));
  await writeFile(join(boardDir, taskFile), "# T-001：成本\n- 状态：待实现\n");
  return { cwd, boardDir, config: config(rpc.backend), rpc: rpc as unknown as RpcClientLike };
}

test("small flow reports coder and QA cost in completion order", async context => {
  const deps = await fixture(context, new CostRpc(qa));
  const summary = await runConfiguredFlow(deps, { taskFile });
  assert.equal(summary.status, "通过");
  assert.deepEqual(summary.cost, {
    totalUsd: coder.costUsd + qa.costUsd, partial: false,
    agents: [
      { role: "coder", agentId: "1", ...coder },
      { role: "qa", agentId: "2", ...qa },
    ],
  });
});

test("small flow omits cost when the backend has no cost method", async context => {
  const deps = await fixture(context, new FakeRpc());
  const summary = await runConfiguredFlow(deps, { taskFile });
  assert.equal(summary.status, "通过");
  assert.equal(summary.cost, undefined);
});

test("small flow marks cost partial when QA cost is unavailable", async context => {
  const deps = await fixture(context, new CostRpc());
  const summary = await runConfiguredFlow(deps, { taskFile });
  assert.equal(summary.status, "通过");
  assert.deepEqual(summary.cost, {
    totalUsd: coder.costUsd, partial: true,
    agents: [{ role: "coder", agentId: "1", ...coder }],
  });
});

test("official parallel dispatch fails before spawning", async context => {
  const rpc = new FakeRpc("official");
  const deps = await fixture(context, rpc);
  deps.config.defaultFlow = "big";
  await assert.rejects(dispatchTask(deps, { task: "Two independent changes", parallel: true }, new AbortController().signal), /parallel.*official/i);
  assert.deepEqual(rpc.roles, []);
});
