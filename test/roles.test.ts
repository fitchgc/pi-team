import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLE_NAMES, type ResolvedConfig, type RoleDefinition, type RoleName } from "../src/config.js";
import { formatRolesTable } from "../src/roles.js";

function role(name: RoleName, overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    name,
    description: name,
    prompt: "",
    skills: [],
    tools: ["read"],
    enabled: true,
    source: "package-default",
    jsonIgnored: false,
    ...overrides,
  };
}

function config(): ResolvedConfig {
  return {
    board: ".tasks/",
    defaultFlow: "small",
    fixBudget: 2,
    subagents: "herbertgao",
    securityAudit: { trigger: "label", label: "security-sensitive" },
    roles: {
      planner: role("planner"),
      architect: role("architect"),
      coder: role("coder", {
        source: "project-json",
        model: "llmapi/gpt-6.2-astra",
        skills: ["local-tdd"],
        tools: ["read", "write"],
        maxTurns: 60,
      }),
      qa: role("qa", { model: "gpt-6.2-astra" }),
      reviewer: role("reviewer", { enabled: false, model: "llmapi/gpt-6.2-sol" }),
      "security-auditor": role("security-auditor"),
    },
  };
}

test("role table lists effective definitions in order and identifies each problem", () => {
  const effective = config();
  const text = formatRolesTable(effective);
  assert.equal(text, [
    "board: .tasks/",
    "dispatcher model: (unset)",
    "default flow: small",
    "fix budget: 2",
    "",
    "planner  package-default  (inherit)  skills:0  tools:1  turns:-",
    "architect  package-default  (inherit)  skills:0  tools:1  turns:-",
    "coder  project-json  llmapi/gpt-6.2-astra  skills:1  tools:2  turns:60",
    "qa  package-default  gpt-6.2-astra  skills:0  tools:1  turns:-",
    "reviewer  package-default  llmapi/gpt-6.2-sol  skills:0  tools:1  turns:-  DISABLED",
    "security-auditor  package-default  (inherit)  skills:0  tools:1  turns:-",
    "",
    "WARN: qa model 'gpt-6.2-astra' is not a provider/modelId; the agent will inherit the parent model",
    "WARN: reviewer is disabled",
  ].join("\n"));
  assert.equal(formatRolesTable(effective), text);
  assert.ok(!text.includes("All roles resolve."));
});

test("enabled roles with full model IDs resolve without warnings", () => {
  const effective = config();
  effective.dispatcherModel = "llmapi/dispatcher";
  for (const name of ROLE_NAMES) {
    effective.roles[name].enabled = true;
    effective.roles[name].model = `llmapi/${name}`;
  }

  const text = formatRolesTable(effective);
  assert.match(text, /^dispatcher model: llmapi\/dispatcher$/m);
  assert.ok(text.endsWith("\n\nAll roles resolve."));
  assert.ok(!text.includes("WARN:"));
  assert.ok(!text.includes("DISABLED"));
});
