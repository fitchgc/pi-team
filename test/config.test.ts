import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  DEFAULT_CONFIG, GENERATED_MARKER, ROLE_NAMES, defaultTeamConfigJson, isGeneratedAgentFile,
  mergeTeamConfig, parseAgentFile, parseTeamConfig, renderAgentFile, resolveConfig,
  type RoleDefinition,
} from "../src/config.js";

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-team-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const opts = {
    packageDir: join(root, "package"),
    projectDir: join(root, "project"),
    agentDir: join(root, "global"),
  };
  async function put(path: string, text: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  return { root, opts, put, resolve: () => resolveConfig(opts) };
}

test("Team config defaults serialize with the schema first and six explicit models", () => {
  const models = Object.fromEntries(Object.entries(DEFAULT_CONFIG.roles).map(([name, role]) => [name, role.model]));
  assert.deepEqual(models, {
    planner: "llmapi/gpt-6.2-sol",
    architect: "llmapi/gpt-6.2-astra",
    coder: "llmapi/gpt-6.2-astra",
    qa: "llmapi/gpt-6.2-astra",
    reviewer: "llmapi/gpt-6.1-terra",
    "security-auditor": "llmapi/gpt-6.2-astra",
  });
  assert.deepEqual(Object.keys(models), ROLE_NAMES);
  const text = defaultTeamConfigJson();
  assert.equal(text.split("\n")[1], '  "$schema": "https://example.com/pi-team/team.schema.json",');
  assert.deepEqual(parseTeamConfig(text), DEFAULT_CONFIG);
  const defaults = parseTeamConfig("{}");
  assert.deepEqual(defaults, DEFAULT_CONFIG);
  assert.notEqual(defaults.roles.coder?.skills, DEFAULT_CONFIG.roles.coder?.skills);
});

test("invalid Team config is rejected", () => {
  assert.throws(() => parseTeamConfig("{"), SyntaxError);
  assert.throws(() => parseTeamConfig('{"version":2}'), /unsupported team\.json version/);
  for (const value of [
    { unexpected: true }, { roles: { dispatcher: {} } }, { roles: { constructor: {} } },
    { fixBudget: 99 }, { fixBudget: -1 }, { fixBudget: 1.5 }, { board: " " },
    { defaultFlow: "large" }, { securityAudit: { trigger: "sometimes" } }, { $schema: 4 },
    ...[
      { thinking: "extreme" }, { maxTurns: 0 }, { enabled: "false" }, { model: "" },
      { skills: [""] }, { tools: [42] },
    ].map(coder => ({ roles: { coder } })),
  ]) {
    assert.throws(() => parseTeamConfig(JSON.stringify(value)), Error, JSON.stringify(value));
  }
});

test("generated agent frontmatter round-trips and the marker remains in the markdown body", () => {
  const frontmatter = {
    description: "Implement: the task",
    tools: ["read", "edit"],
    model: "llmapi/gpt-6.2-astra",
    thinking: "high" as const,
    maxTurns: 60,
    skills: ["local-tdd", "local-implement"],
    isolation: "worktree",
  };
  const def: RoleDefinition = {
    ...frontmatter, name: "coder", enabled: true, source: "project-json",
    jsonIgnored: false, prompt: "Implement the task.\n\nRun the Gate.",
  };
  const rendered = renderAgentFile(def);
  assert.equal(rendered, [
    "---", "description: Implement: the task", "tools: read, edit",
    "model: llmapi/gpt-6.2-astra", "thinking: high", "max_turns: 60",
    "skills: local-tdd, local-implement", "isolation: worktree",
    "---", "", GENERATED_MARKER, "", def.prompt,
  ].join("\n"));
  assert.deepEqual(parseAgentFile(rendered), {
    frontmatter, body: `${GENERATED_MARKER}\n\n${def.prompt}`,
  });
  assert.equal(isGeneratedAgentFile(rendered), true);
  assert.equal(isGeneratedAgentFile("---\ndescription: Hand-written\n---\nPrompt"), false);
});

test("agent parser handles quotes, empty lists, CRLF, and indented markdown", () => {
  const text = [
    "---", 'description: "Role: QA"', "tools: 'read, bash'", "skills:",
    "unknown: ignored", "thinking: 'minimal'", "---", "  ", "    code", "", "",
  ].join("\r\n");
  assert.deepEqual(parseAgentFile(text), {
    frontmatter: { description: "Role: QA", tools: ["read", "bash"], skills: [], thinking: "minimal" },
    body: "    code",
  });
  assert.deepEqual(parseAgentFile("---\n---"), {
    frontmatter: { description: "", tools: [], skills: [] }, body: "",
  });
});

test("agent parser rejects missing delimiters, invalid integers, and unknown thinking levels", () => {
  for (const text of ["prompt", "\n---\n---", "---\ndescription: unfinished"]) {
    assert.throws(() => parseAgentFile(text), /missing frontmatter/);
  }
  for (const value of ["abc", "2.5", "4turns"]) {
    assert.throws(() => parseAgentFile(`---\nmax_turns: ${value}\n---`), /max_turns/);
  }
  assert.throws(() => parseAgentFile("---\nthinking: automatic\n---"), /thinking/);
});

test("Role resolution respects file ownership, sparse JSON layers, and activation", async context => {
  const { opts, put, resolve } = await fixture(context);
  const packageFile = join(opts.packageDir, "agents", "coder.md");
  const globalFile = join(opts.agentDir, "agents", "coder.md");
  const projectFile = join(opts.projectDir, ".pi", "agents", "coder.md");
  const projectConfig = join(opts.projectDir, ".pi", "team.json");

  await put(packageFile, "---\nmodel: packaged\n---\nPackage agent prompt");
  let config = await resolve();
  assert.deepEqual(Object.keys(config.roles), ROLE_NAMES);
  assert.equal(config.roles.coder.source, "package-default");
  assert.equal(config.roles.coder.model, "packaged");
  assert.equal(config.roles.coder.prompt, "Package agent prompt");
  assert.equal(config.roles.qa.enabled, true);
  assert.equal(config.roles.qa.model, DEFAULT_CONFIG.roles.qa?.model);
  assert.equal(config.board, ".tasks/");

  await put(join(opts.agentDir, "team.json"), JSON.stringify({
    board: "global-board", dispatcherModel: "global-dispatcher", fixBudget: 4, defaultFlow: "big",
    securityAudit: { trigger: "always", label: "global-label" },
    roles: { coder: { model: "global-json-model", promptAppend: "Global notes" } },
  }));
  config = await resolve();
  assert.equal(config.roles.coder.source, "global-json");
  assert.equal(config.roles.coder.prompt, "Package agent prompt\n\nGlobal notes");

  await put(projectConfig, JSON.stringify({ roles: { coder: { promptAppend: "Project notes" } } }));
  config = await resolve();
  assert.equal(config.roles.coder.source, "project-json");
  assert.equal(config.roles.coder.model, "global-json-model");
  assert.equal(config.roles.coder.prompt, "Package agent prompt\n\nGlobal notes\n\nProject notes");

  await put(globalFile, "---\nmodel: global-file-model\ntools: read\n---\nGlobal prompt");
  await put(projectConfig, JSON.stringify({ roles: { coder: {} } }));
  config = await resolve();
  assert.equal(config.roles.coder.source, "global-file");
  assert.equal(config.roles.coder.model, "global-file-model");
  assert.equal(config.roles.coder.prompt, "Global prompt");
  assert.equal(config.roles.coder.jsonIgnored, true);

  await put(projectConfig, JSON.stringify({
    securityAudit: { label: "project-label" },
    roles: { coder: { model: "project-model", enabled: false, promptAppend: "Project notes" } },
  }));
  config = await resolve();
  assert.equal(config.roles.coder.source, "project-json");
  assert.equal(config.roles.coder.model, "project-model");
  assert.equal(config.roles.coder.prompt, "Global prompt\n\nProject notes");
  assert.deepEqual(config.roles.coder.tools, ["read"]);
  assert.equal(config.roles.coder.enabled, false);
  assert.equal(config.roles.coder.jsonIgnored, false);
  assert.equal(config.board, "global-board");
  assert.equal(config.dispatcherModel, "global-dispatcher");
  assert.equal(config.fixBudget, 4);
  assert.equal(config.defaultFlow, "big");
  assert.deepEqual(config.securityAudit, { trigger: "always", label: "project-label" });

  await put(projectConfig, JSON.stringify({
    roles: { coder: { enabled: false, prompt: "Replacement", promptAppend: "Not appended" } },
  }));
  assert.equal((await resolve()).roles.coder.prompt, "Replacement");

  await put(projectFile, "---\nskills: owned\n---\nProject prompt");
  config = await resolve();
  assert.deepEqual(config.roles.coder, {
    name: "coder", description: "", tools: [], skills: ["owned"], prompt: "Project prompt",
    source: "project-file", jsonIgnored: true, enabled: false,
  });

  await put(projectConfig, "{");
  await assert.rejects(resolve(), SyntaxError);
});

test("a malformed lower-priority agent is not treated as absent", async context => {
  const { opts, put, resolve } = await fixture(context);
  await put(join(opts.projectDir, ".pi", "agents", "qa.md"), "---\n---\nProject QA");
  await put(join(opts.packageDir, "agents", "qa.md"), "missing delimiters");
  await assert.rejects(resolve(), /missing frontmatter/);
});

test("role files cannot redirect reads outside their root", async context => {
  const { root, opts, put, resolve } = await fixture(context);
  const outside = join(root, "outside.md");
  await put(outside, "---\n---\nOutside");
  const agents = join(opts.packageDir, "agents");
  await mkdir(agents, { recursive: true });
  await symlink(outside, join(agents, "coder.md"));
  await assert.rejects(resolve(), /escapes/);
});

test("merging preserves both inputs and does not share mutable arrays", () => {
  const base = parseTeamConfig("{}");
  const over = parseTeamConfig('{"board":"other"}');
  over.roles = { coder: { skills: ["project-skill"], enabled: false } };
  const beforeBase = structuredClone(base);
  const beforeOver = structuredClone(over);

  const merged = mergeTeamConfig(base, over);
  assert.equal(merged.board, "other");
  assert.equal(merged.roles.coder?.model, base.roles.coder?.model);
  assert.equal(merged.roles.coder?.enabled, false);
  assert.deepEqual(merged.roles.coder?.skills, ["project-skill"]);
  merged.roles.coder?.skills?.push("changed");
  merged.roles.planner?.tools?.push("changed");
  merged.securityAudit.label = "changed";
  assert.deepEqual(base, beforeBase);
  assert.deepEqual(over, beforeOver);
});
