import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { defaultTeamConfigJson, isGeneratedAgentFile, ROLE_NAMES } from "../src/config.js";
import { initTeam } from "../src/init.js";

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-team-init-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const opts = {
    projectDir: join(root, "project"),
    packageDir: join(root, "package"),
    agentDir: join(root, "global"),
    skillSourceDir: join(root, "source"),
  };
  return { root, opts, configDir: join(opts.projectDir, ".pi") };
}

test("fresh init installs the default config, board, all agents, and dereferenced skills", async context => {
  const { root, opts, configDir } = await fixture(context);
  const realSkill = join(root, "real-tdd");
  await put(join(realSkill, "SKILL.md"), "TDD instructions\n");
  await put(join(realSkill, "examples", "sample.txt"), "nested example\n");
  await put(join(opts.skillSourceDir, "local-implement", "SKILL.md"), "Implementation instructions\n");
  await symlink(realSkill, join(opts.skillSourceDir, "local-tdd"), "dir");

  const report = await initTeam(opts);
  assert.equal(report.teamJson, "created");
  assert.deepEqual(
    JSON.parse(await readFile(join(configDir, "team.json"), "utf8")),
    JSON.parse(defaultTeamConfigJson()),
  );
  assert.equal(report.boardDir, join(opts.projectDir, ".tasks"));
  assert.ok((await lstat(report.boardDir)).isDirectory());
  assert.deepEqual(report.agents, ROLE_NAMES.map(role => ({ role, action: "created" })));
  for (const role of ROLE_NAMES) {
    assert.ok(isGeneratedAgentFile(await readFile(join(configDir, "agents", `${role}.md`), "utf8")));
  }

  const names = report.skills.map(entry => entry.skill);
  assert.deepEqual(names, [...new Set(names)].sort());
  assert.deepEqual(report.skills.filter(entry => entry.action === "copied"), [
    { skill: "local-implement", action: "copied" },
    { skill: "local-tdd", action: "copied" },
  ]);
  for (const skill of ["local-implement", "local-tdd"]) {
    const path = join(configDir, "skills", skill);
    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false);
    assert.ok(info.isDirectory());
    assert.equal(
      await readFile(join(path, "SKILL.md"), "utf8"),
      await readFile(join(opts.skillSourceDir, skill, "SKILL.md"), "utf8"),
    );
  }
  assert.equal(await readFile(join(configDir, "skills", "local-tdd", "examples", "sample.txt"), "utf8"), "nested example\n");
});

test("second init keeps project config, hand-edited agents, and existing skills", async context => {
  const { opts, configDir } = await fixture(context);
  const teamFile = join(configDir, "team.json");
  const customConfig = '{ "board": "work/board", "roles": { "coder": { "model": "test/custom" } } }\n';
  await put(teamFile, customConfig);
  await put(join(opts.skillSourceDir, "local-tdd", "SKILL.md"), "source skill");
  await initTeam(opts);

  const coder = join(configDir, "agents", "coder.md");
  const originalCoder = await readFile(coder, "utf8");
  assert.match(originalCoder, /^model: test\/custom$/m);
  const qa = join(configDir, "agents", "qa.md");
  const handEdited = "---\ndescription: Custom QA\n---\n\nMy own QA instructions.\n";
  await writeFile(qa, handEdited);
  const installedSkill = join(configDir, "skills", "local-tdd", "SKILL.md");
  await writeFile(installedSkill, "project skill");

  const report = await initTeam(opts);
  assert.equal(report.teamJson, "exists");
  assert.equal(await readFile(teamFile, "utf8"), customConfig);
  assert.equal(report.boardDir, join(opts.projectDir, "work", "board"));
  assert.ok((await lstat(report.boardDir)).isDirectory());
  assert.deepEqual(report.agents, ROLE_NAMES.map(role => ({
    role,
    action: role === "qa" ? "skipped-hand-edited" : "updated",
  })));
  assert.equal(await readFile(coder, "utf8"), originalCoder);
  assert.equal(await readFile(qa, "utf8"), handEdited);
  assert.ok(report.warnings.includes("qa.md is hand-edited; /team init left it alone (delete the file to regenerate it)"));
  assert.deepEqual(report.skills.find(entry => entry.skill === "local-tdd"), { skill: "local-tdd", action: "exists" });
  assert.equal(await readFile(installedSkill, "utf8"), "project skill");
});

test("missing skills are reported once with the names of the referencing roles", async context => {
  const { opts, configDir } = await fixture(context);
  await put(join(configDir, "team.json"), JSON.stringify({
    roles: { coder: { skills: ["absent"] }, qa: { skills: ["absent"] } },
  }));
  const report = await initTeam(opts);
  assert.deepEqual(report.skills.filter(entry => entry.skill === "absent"), [{ skill: "absent", action: "missing" }]);
  assert.ok(report.warnings.includes(`skill 'absent' not found in ${opts.skillSourceDir}; role(s) coder, qa reference it`));
});

test("disabled roles get agent files but do not contribute skills", async context => {
  const { opts, configDir } = await fixture(context);
  await put(join(configDir, "team.json"), JSON.stringify({
    roles: { reviewer: { enabled: false, skills: ["review-only"] } },
  }));
  await put(join(opts.skillSourceDir, "review-only", "SKILL.md"), "Review instructions");

  const report = await initTeam(opts);
  assert.ok(!report.skills.some(entry => entry.skill === "review-only"));
  assert.ok(!report.warnings.some(warning => warning.includes("review-only")));
  assert.ok(isGeneratedAgentFile(await readFile(join(configDir, "agents", "reviewer.md"), "utf8")));
  await assert.rejects(lstat(join(configDir, "skills", "review-only")), { code: "ENOENT" });
});
