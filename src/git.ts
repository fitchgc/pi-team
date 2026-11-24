import { runCommand } from "./gate.js";

export const realGit = (args: string[], cwd: string) =>
  runCommand(["git", "-c", "color.ui=false", "-c", "rerere.enabled=false", ...args], { cwd });

export type Git = typeof realGit;

type RunGit = (args: string[]) => ReturnType<Git>;

export async function mergeTicket(run: RunGit, ticket: string, agent: string, touched: Map<string, string[]>) {
  const output = async (...args: string[]) => {
    const result = await run(args);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout || result.code}`);
    return result.stdout.trimEnd();
  };
  const diagnostic = (...args: string[]) => output(...args).catch((error: unknown) => String(error));
  const indent = (text: string) => text.split("\n").map(line => `    ${line}`).join("\n");
  const prefix = `pi-agent-${agent}`;
  if (!/^[\w.-]+$/.test(agent)) throw new Error(`invalid worktree agent id: ${agent}`);
  const listing = await output("branch", "--list", `${prefix}*`);
  const branches = listing.split("\n").map(line => line.trim()).filter(Boolean);
  if (!branches.length) return { record: `${ticket}: no changes, nothing to merge`, escalated: false };
  const [branch] = branches;
  if (branches.length !== 1 || !(branch === prefix || (branch.startsWith(`${prefix}-`) && /^\d+$/.test(branch.slice(prefix.length + 1))))) {
    return { record: `${ticket}: ambiguous worktree branches for ${agent}: ${branches.join(", ")}`, escalated: true };
  }
  if ((await run(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"])).code === 0) {
    throw new Error("main checkout already has a merge in progress; finish it before merging subtasks");
  }
  const paths = (await output("diff", "--name-only", `HEAD...${branch}`)).split("\n");
  const result = await run(["merge", "--no-edit", "--no-autostash", branch]);
  if (result.code !== 0) {
    const unmerged = (await diagnostic("diff", "--name-only", "--diff-filter=U")).split("\n");
    const others = [...touched].filter(([, files]) => files.some(file => unmerged.includes(file))).map(([id]) => id);
    const abort = await diagnostic("merge", "--abort");
    const files = await diagnostic("diff", "--name-only", "HEAD", branch);
    const ours = await diagnostic("diff", `${branch}...HEAD`);
    const theirs = await diagnostic("diff", `HEAD...${branch}`);
    return {
      escalated: true,
      record: [
        `merge conflict: ${ticket} (${branch}) vs ${others.join(", ") || "main checkout"}; branch retained`,
        indent(result.stderr || result.stdout), `git merge --abort: ${abort || "ok"}`,
        `Unmerged files:\n${indent(unmerged.join("\n"))}`, `Files (HEAD vs branch):\n${indent(files)}`,
        `Main diff from merge base:\n${indent(ours)}`, `Subtask diff from merge base:\n${indent(theirs)}`,
      ].join("\n"),
    };
  }
  touched.set(ticket, paths);
  const deletion = await diagnostic("branch", "-d", branch);
  return { record: `${ticket}: merged ${branch}\n    git branch -d: ${deletion || "ok"}`, escalated: false };
}
