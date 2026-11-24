import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getSection } from "./taskfile.js";

export interface Ticket {
  id: string;
  filename: string;
  text: string;
  blockers: string[];
}

export async function ticketFiles(board: string, parent: string) {
  const files = new Map<string, string>();
  for (const entry of await readdir(board, { withFileTypes: true })) {
    const suffix = entry.name.slice(parent.length + 1);
    if (!entry.isFile() || !entry.name.startsWith(`${parent}-`) || !/^\d+-.+\.md$/.test(suffix)) continue;
    const stat = await lstat(join(board, entry.name), { bigint: true });
    files.set(entry.name, `${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}`);
  }
  return files;
}

export async function ticketWaves(board: string, parent: string, before: Map<string, string>) {
  const pending = new Map<string, Ticket>();
  for (const [filename, version] of await ticketFiles(board, parent)) {
    if (before.get(filename) === version) continue;
    const text = await readFile(join(board, filename), "utf8");
    const header = text.split(/^## /m, 1)[0];
    if (header.match(/^- 父任务[ \t]*[:：]([^\r\n]*)/m)?.[1].trim() !== parent) continue;
    const dependencies = header.match(/^- 依赖[ \t]*[:：]([^\r\n]*)/m)?.[1].trim();
    if (dependencies === undefined || !getSection(text, "需求") || !getSection(text, "验收标准")) {
      throw new Error(`incomplete subtask ${filename}: expected 依赖, 需求 and 验收标准`);
    }
    const number = filename.slice(parent.length + 1).split("-", 1)[0];
    const id = `${parent}-${number}`;
    if (pending.has(id)) throw new Error(`duplicate subtask id: ${id}`);
    const blockers = dependencies ? dependencies.split(/[,，]/).map(item => item.trim()) : [];
    pending.set(id, { id, filename, text, blockers });
  }
  if (!pending.size) throw new Error(`planner wrote no subtask files for ${parent}`);
  for (const ticket of pending.values()) {
    for (const id of ticket.blockers) {
      if (!pending.has(id)) throw new Error(`${ticket.id}: unknown dependency ${id}`);
    }
  }
  const waves: Ticket[][] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter(ticket => ticket.blockers.every(id => !pending.has(id)));
    if (!ready.length) throw new Error(`cyclic subtask dependencies: ${[...pending.keys()].join(", ")}`);
    ready.sort((left, right) => left.id.localeCompare(right.id, "en", { numeric: true }));
    waves.push(ready);
    for (const ticket of ready) pending.delete(ticket.id);
  }
  return waves;
}
