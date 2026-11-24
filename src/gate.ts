import { spawn } from "node:child_process";

export interface GateResult {
  passed: boolean;
  skipped: boolean;
  output: string;
  code: number | null;
  timedOut: boolean;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const defaultTimeoutMs = 600_000;
const outputLimit = 4_000;

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

export function runCommand(
  cmd: string,
  opts: { cwd: string; timeoutMs?: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], {
      cwd: opts.cwd,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let escalation: NodeJS.Timeout | undefined;

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });

    const deadline = setTimeout(() => {
      if (pid === undefined) {
        return;
      }
      timedOut = true;
      try {
        if (signalGroup(pid, "SIGTERM")) {
          escalation = setTimeout(() => {
            try {
              signalGroup(pid, "SIGKILL");
            } catch (error: unknown) {
              reject(error);
            }
          }, 2_000);
        }
      } catch (error: unknown) {
        reject(error);
      }
    }, opts.timeoutMs ?? defaultTimeoutMs);

    child.once("error", (error) => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      try {
        // Descendants can close their pipes and outlive the shell.
        if (escalation && pid !== undefined && !signalGroup(pid, 0)) {
          clearTimeout(escalation);
        }
        resolve({ code: timedOut ? null : code, stdout, stderr, timedOut });
      } catch (error: unknown) {
        reject(error);
      }
    });
  });
}

function trimTrailingBlankLines(text: string): string {
  return text.replace(/(?:\r?\n[ \t]*)+$/, "").replace(/^[ \t]+$/, "");
}

export async function runGate(
  testCommand: string | undefined,
  cwd: string,
  timeoutMs = defaultTimeoutMs,
): Promise<GateResult> {
  const command = testCommand?.trim();
  if (!command || command === "无") {
    return {
      passed: true,
      skipped: true,
      output: "no test command configured; gate skipped",
      code: null,
      timedOut: false,
    };
  }

  const { code, stdout, stderr, timedOut } = await runCommand(command, { cwd, timeoutMs });
  const combined = [stdout, stderr].map(trimTrailingBlankLines).filter(Boolean).join("\n");
  const output = combined.length > outputLimit
    ? `...[truncated]\n${combined.slice(-outputLimit)}`
    : combined || "(no output)";
  return { passed: code === 0, skipped: false, output, code, timedOut };
}
