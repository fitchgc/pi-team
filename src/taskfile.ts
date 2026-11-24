import { basename } from "node:path";

export interface TaskFile {
  id: string;
  title: string;
  status?: string;
  testCommand?: string;
  parallel?: boolean;
  raw: string;
}

export interface QaVerdict {
  verdict: "通过" | "打回";
  evidence: string;
  reasons: string;
}

const statusLine = /^(- 状态[ \t]*[:：][ \t]*)([^\r\n]*)/m;
const commandLine = /^- 测试命令[ \t]*[:：]([^\r\n]*)/m;
const titleLine = /^# ([^\r\n]*)(\r?\n|$)/m;

function lineEnding(text: string): string {
  return text.match(/\r?\n/)?.[0] ?? "\n";
}

function trimBlankLines(text: string): string {
  return text
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .replace(/(?:\r?\n[ \t]*)+$/, "")
    .replace(/^[ \t]+$/, "");
}

function sectionBounds(text: string, name: string) {
  let start: number | undefined;
  let newline = lineEnding(text);
  let hasHeadingTerminator = false;

  for (const heading of text.matchAll(/^## ([^\r\n]*)(\r?\n|$)/gm)) {
    if (start !== undefined) {
      return { start, end: heading.index, newline, hasHeadingTerminator };
    }
    if (heading[1]?.trimEnd() === name) {
      start = heading.index + heading[0].length;
      hasHeadingTerminator = Boolean(heading[2]);
      newline = heading[2] || newline;
    }
  }

  return start === undefined
    ? undefined
    : { start, end: text.length, newline, hasHeadingTerminator };
}

export function taskIdFromFilename(filename: string): string {
  const stem = basename(filename, ".md");
  return stem.match(/^T-\d+/)?.[0] ?? stem;
}

export function parseTaskFile(filename: string, text: string): TaskFile {
  const title = text.match(titleLine)?.[1]?.trim() ?? "";
  const task: TaskFile = {
    id: taskIdFromFilename(filename),
    title: title.replace(/^T-\d+[:：]?\s*/, ""),
    raw: text,
  };

  const header = text.split(/^## /m, 1)[0];
  const parallel = header.match(/^- 并行[ \t]*[:：]([^\r\n]*)/m)?.[1];
  if (parallel !== undefined) task.parallel = parallel.trim() === "是";
  const status = text.match(statusLine)?.[2]?.trim();
  if (status !== undefined) {
    task.status = status;
  }
  const command = text.match(commandLine)?.[1]?.trim();
  if (command && command !== "无") {
    task.testCommand = command;
  }
  return task;
}

export function getSection(text: string, name: string): string | undefined {
  const bounds = sectionBounds(text, name);
  return bounds && trimBlankLines(text.slice(bounds.start, bounds.end));
}

export function updateStatus(text: string, status: string): string {
  if (statusLine.test(text)) {
    return text.replace(statusLine, (_line, prefix: string) => prefix + status);
  }

  const line = `- 状态：${status}`;
  const heading = titleLine.exec(text);
  if (!heading) {
    return line + (text ? lineEnding(text) + text : "");
  }
  const end = heading.index + heading[0].length;
  const newline = heading[2] || lineEnding(text);
  const insertion = heading[2] ? line + newline : newline + line;
  return text.slice(0, end) + insertion + text.slice(end);
}

export function updateSection(text: string, name: string, content: string): string {
  const bounds = sectionBounds(text, name);
  const newline = bounds?.newline ?? lineEnding(text);
  const body = trimBlankLines(content).replace(/\r?\n/g, newline);
  const terminatedBody = body ? body + newline : "";

  if (!bounds) {
    const prefix = text ? text + newline : "";
    return `${prefix}## ${name}${newline}${terminatedBody}`;
  }

  const separator = bounds.hasHeadingTerminator ? "" : newline;
  return text.slice(0, bounds.start) + separator + terminatedBody + text.slice(bounds.end);
}

export function updateConclusion(
  text: string,
  conclusion: { verdict: string; evidence: string; reasons: string },
): string {
  const lines = [`- verdict：${conclusion.verdict}`, `- 证据：${conclusion.evidence}`];
  if (conclusion.reasons) {
    lines.push(`- 打回原因：${conclusion.reasons}`);
  }
  return updateSection(text, "验收结论", lines.join("\n"));
}

export function parseVerdict(text: string): QaVerdict | null {
  const verdict = text.match(/\bverdict[ \t]*[:：][ \t]*([^\r\n]*)/i)?.[1]?.trim();
  if (verdict !== "通过" && verdict !== "打回") {
    return null;
  }

  const evidence = text.match(/证据[ \t]*[:：]([^\r\n]*)/)?.[1]?.trim() ?? "";
  const reasons = text.match(/打回原因[ \t]*[:：]([^\r\n]*)/)?.[1]?.trim()
    ?? text.match(/\breason[ \t]*[:：]([^\r\n]*)/i)?.[1]?.trim()
    ?? "";
  return { verdict, evidence, reasons };
}
