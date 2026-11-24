import { cp, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  defaultTeamConfigJson,
  GENERATED_MARKER,
  isGeneratedAgentFile,
  renderAgentFile,
  resolveConfig,
  ROLE_NAMES,
  type RoleName,
} from "./config.js";

export interface InitReport {
  teamJson: "created" | "exists";
  boardDir: string;
  agents: { role: RoleName; action: "created" | "updated" | "skipped-hand-edited" }[];
  skills: { skill: string; action: "copied" | "exists" | "missing" }[];
  warnings: string[];
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function createFile(path: string, content: string): Promise<"created" | "exists"> {
  try {
    await writeFile(path, content, { flag: "wx" });
    return "created";
  } catch (error) {
    if (hasCode(error, "EEXIST")) return "exists";
    throw error;
  }
}

async function inspect(path: string, followLinks: boolean) {
  try {
    return followLinks ? await stat(path) : await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function initTeam(opts: {
  projectDir: string;
  packageDir: string;
  agentDir: string;
  skillSourceDir?: string;
  configDirName?: string;
}): Promise<InitReport> {
  const config = await resolveConfig(opts);
  const configDir = join(opts.projectDir, opts.configDirName ?? ".pi");
  const agentsDir = join(configDir, "agents");
  const skillsDir = join(configDir, "skills");
  const skillSourceDir = opts.skillSourceDir ?? join(homedir(), "workspace", "custom-skills");
  const boardDir = resolve(join(opts.projectDir, config.board));

  await mkdir(configDir, { recursive: true });
  const teamJson = await createFile(join(configDir, "team.json"), defaultTeamConfigJson());
  await mkdir(boardDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });

  const report: InitReport = { teamJson, boardDir, agents: [], skills: [], warnings: [] };
  const skillRoles = new Map<string, RoleName[]>();
  for (const role of ROLE_NAMES) {
    const def = config.roles[role];
    if (def.enabled) {
      for (const skill of new Set(def.skills)) {
        const names = skillRoles.get(skill);
        if (names) names.push(role);
        else skillRoles.set(skill, [role]);
      }
    }

    const path = join(agentsDir, `${role}.md`);
    const prompt = def.prompt.startsWith(GENERATED_MARKER)
      ? def.prompt.slice(GENERATED_MARKER.length).replace(/^\n+/, "")
      : def.prompt;
    const content = renderAgentFile({ ...def, prompt });
    if (await createFile(path, content) === "created") {
      report.agents.push({ role, action: "created" });
    } else if (isGeneratedAgentFile(await readFile(path, "utf8"))) {
      await writeFile(path, content);
      report.agents.push({ role, action: "updated" });
    } else {
      report.agents.push({ role, action: "skipped-hand-edited" });
      report.warnings.push(
        `${role}.md is hand-edited; /team init left it alone (delete the file to regenerate it)`,
      );
    }
  }

  for (const skill of [...skillRoles.keys()].sort()) {
    if (skill === "." || skill === ".." || basename(skill) !== skill) {
      throw new Error(`expected a skill directory name, got '${skill}'`);
    }
    const target = join(skillsDir, skill);
    if (await inspect(target, false)) {
      report.skills.push({ skill, action: "exists" });
      continue;
    }

    const source = join(skillSourceDir, skill);
    const sourceInfo = await inspect(source, true);
    if (!sourceInfo) {
      report.skills.push({ skill, action: "missing" });
      report.warnings.push(
        `skill '${skill}' not found in ${skillSourceDir}; role(s) ${skillRoles.get(skill)?.join(", ")} reference it`,
      );
      continue;
    }

    if (!sourceInfo.isDirectory()) throw new Error(`skill source is not a directory: ${source}`);
    await mkdir(skillsDir, { recursive: true });
    await cp(source, target, { recursive: true, dereference: true, force: false, errorOnExist: true });
    report.skills.push({ skill, action: "copied" });
  }
  return report;
}
