import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { runCommand, runGate } from "../src/gate.js";

const cwd = process.cwd();
const invalidCwd = join(cwd, "src", "gate.ts", "invalid-directory");

test("skips unconfigured commands even with an invalid working directory", async () => {
  for (const command of [undefined, "", " \t ", "无"]) {
    assert.deepEqual(await runGate(command, invalidCwd), {
      passed: true,
      skipped: true,
      output: "no test command configured; gate skipped",
      code: null,
      timedOut: false,
    });
  }
});

test("returns ordinary success and failure exit codes", async () => {
  for (const [command, code] of [["true", 0], ["false", 1]] as const) {
    assert.deepEqual(await runCommand(command, { cwd }), {
      code,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
  }
});

test("rejects when the process cannot start", async () => {
  await assert.rejects(runCommand("true", { cwd: invalidCwd }));
});

test("passes a successful gate and captures its output", async () => {
  assert.deepEqual(await runGate("echo hello", cwd), {
    passed: true,
    skipped: false,
    output: "hello",
    code: 0,
    timedOut: false,
  });
  assert.equal((await runGate("true", cwd)).output, "(no output)");
});

test("reports failure with stdout followed by stderr", async () => {
  assert.deepEqual(await runGate("echo out; echo err >&2; exit 3", cwd), {
    passed: false,
    skipped: false,
    output: "out\nerr",
    code: 3,
    timedOut: false,
  });
});

test("removes trailing blank lines from each stream", async () => {
  const result = await runGate("printf '行  \\n\\n'; printf '错误\\n \\n' >&2", cwd);
  assert.equal(result.output, "行  \n错误");
});

test("prefixes exactly the last 4000 characters when truncating", async () => {
  const result = await runGate("printf '%05000dTAIL\\n' 0", cwd);
  assert.equal(result.passed, true);
  assert.equal(result.output, `...[truncated]\n${"0".repeat(3996)}TAIL`);
});

test("reports a timed-out command with a null exit code", { timeout: 4_000 }, async () => {
  const result = await runGate("sleep 5", cwd, 200);
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.equal(result.passed, false);
  assert.equal(result.skipped, false);
});
