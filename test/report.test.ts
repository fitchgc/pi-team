import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverReport, notify } from "../src/report.js";

function capture() {
  const writes: [string, string][] = [];
  const output = {
    stdout: { write: (text: string) => writes.push(["stdout", text]) },
    stderr: { write: (text: string) => writes.push(["stderr", text]) },
  };
  return { writes, output };
}

test("print writes the whole report to stdout without queuing it", () => {
  const { writes, output } = capture();
  deliverReport("print", "roles\nAll roles resolve.", assert.fail, output);
  assert.deepEqual(writes, [["stdout", "roles\nAll roles resolve.\n"]]);
});

test("print sends info and warnings to stdout and errors to stderr", () => {
  const { writes, output } = capture();
  const ui = { notify: () => assert.fail("unexpected UI notification") };
  for (const type of ["info", "warning", "error"] as const) {
    notify("print", ui, "message", type, output);
  }
  assert.deepEqual(writes, [
    ["stdout", "message\n"],
    ["stdout", "message\n"],
    ["stderr", "message\n"],
  ]);
});

for (const mode of ["tui", "rpc", "json"] as const) {
  test(`${mode} delegates reports and notifications without writing to streams`, () => {
    const { writes, output } = capture();
    const calls: string[] = [];
    deliverReport(mode, "roles", text => calls.push(text), output);
    notify(mode, { notify: (text, type) => calls.push(`${type}: ${text}`) }, "listed", "info", output);
    assert.deepEqual(calls, ["roles", "info: listed"]);
    assert.deepEqual(writes, []);
  });
}
