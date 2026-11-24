import assert from "node:assert/strict";
import test from "node:test";
import {
  getSection,
  parseTaskFile,
  parseVerdict,
  taskIdFromFilename,
  updateConclusion,
  updateSection,
  updateStatus,
} from "../src/taskfile.js";

const taskText = `# T-001：登录接口

- 状态：待验收
- 负责人：coder
- 依赖：无
- 测试命令：npm test -- auth

## 需求
实现登录接口。

## 验收标准
- [ ] 有效凭据返回成功

## 实现记录
已添加接口和测试。

## 验收结论
- verdict：
- 证据：

## open question
无
`;

test("extracts the leading task ID or falls back to the filename stem", () => {
  assert.equal(taskIdFromFilename(".tasks/T-001-登录接口.md"), "T-001");
  assert.equal(taskIdFromFilename("T-12.md"), "T-12");
  assert.equal(taskIdFromFilename("foo.md"), "foo");
  assert.equal(taskIdFromFilename("T-001"), "T-001");
});

test("parses the task header and retains the original text", () => {
  assert.deepEqual(parseTaskFile("T-001-登录接口.md", taskText), {
    id: "T-001",
    title: "登录接口",
    status: "待验收",
    testCommand: "npm test -- auth",
    raw: taskText,
  });
});

test("accepts ASCII separators and uses the first heading and metadata values", () => {
  const raw = [
    "preamble",
    "# T-12: Run checks",
    "# Another title",
    "- 状态: 已中断 ",
    "- 状态：通过",
    "- 测试命令: npm test ",
    "- 测试命令：false",
  ].join("\r\n");
  assert.deepEqual(parseTaskFile("T-12.md", raw), {
    id: "T-12",
    title: "Run checks",
    status: "已中断",
    testCommand: "npm test",
    raw,
  });
});

test("handles absent metadata and unconfigured test commands", () => {
  const task = parseTaskFile("foo.md", "# 登录接口\n");
  assert.equal(task.title, "登录接口");
  assert.equal(task.status, undefined);
  assert.equal(task.testCommand, undefined);
  for (const value of ["无", "  "]) {
    assert.equal(parseTaskFile("foo.md", `- 测试命令：${value}\n正文`).testCommand, undefined);
  }
});

test("updates only the first status line and preserves its separator", () => {
  const text = "# Title\r\n- 状态: 待实现\r\n- 状态：打回\r\n";
  assert.equal(updateStatus(text, "实现中"), "# Title\r\n- 状态: 实现中\r\n- 状态：打回\r\n");
  assert.equal(updateStatus("- 状态：待实现", "通过"), "- 状态：通过");
});

test("inserts status immediately after the first title or at the top", () => {
  assert.equal(updateStatus("intro\n# Title\n\n正文", "打回"), "intro\n# Title\n- 状态：打回\n\n正文");
  assert.equal(updateStatus("正文\n", "待实现"), "- 状态：待实现\n正文\n");
  assert.equal(updateStatus("# Title", "通过"), "# Title\n- 状态：通过");
});

test("reads exact sections and trims only surrounding blank lines", () => {
  const text = "## 需求详情\n忽略\n## 需求  \r\n \r\n  第一行  \r\n### 子标题\r\n\r\n## 设计\n";
  assert.equal(getSection(text, "需求"), "  第一行  \r\n### 子标题");
  assert.equal(getSection(text, "设计"), "");
  assert.equal(getSection(text, "验收标准"), undefined);
});

test("replaces and appends section bodies idempotently", () => {
  const original = "# Title\n\n## 需求\n旧\n\n## 设计\n保留\n";
  const updated = "# Title\n\n## 需求\n  新\n第二行\n## 设计\n保留\n";
  const content = "\n  新\n第二行\n\n";
  assert.equal(updateSection(original, "需求", content), updated);
  assert.equal(updateSection(updated, "需求", content), updated);

  const appended = `${updated}\n## open question\n无\n`;
  assert.equal(updateSection(updated, "open question", "无\n\n"), appended);
  assert.equal(updateSection(appended, "open question", "无"), appended);
  assert.equal(updateSection("## 设计", "设计", "方案"), "## 设计\n方案\n");
});

test("writes exact conclusion fields and omits empty reasons", () => {
  const original = "## 验收结论\n待定\n## 设计\n保留\n";
  const rejected = updateConclusion(original, { verdict: "打回", evidence: "失败", reasons: "缺测试" });
  assert.equal(rejected, "## 验收结论\n- verdict：打回\n- 证据：失败\n- 打回原因：缺测试\n## 设计\n保留\n");
  const accepted = updateConclusion(rejected, { verdict: "通过", evidence: "", reasons: "" });
  assert.equal(accepted, "## 验收结论\n- verdict：通过\n- 证据：\n## 设计\n保留\n");
});

test("parses QA evidence and gives Chinese reasons precedence", () => {
  assert.deepEqual(parseVerdict("- verdict：打回\n- 证据： 断言失败 \nreason: fallback\n- 打回原因：缺少校验"), {
    verdict: "打回",
    evidence: "断言失败",
    reasons: "缺少校验",
  });
  assert.deepEqual(parseVerdict("VERDICT: 打回\nreason: missing check"), {
    verdict: "打回",
    evidence: "",
    reasons: "missing check",
  });
});

test("uses only the first verdict line and requires an exact value", () => {
  assert.deepEqual(parseVerdict("verdict: 通过\nverdict：打回"), {
    verdict: "通过",
    evidence: "",
    reasons: "",
  });
  assert.equal(parseVerdict("证据：通过"), null);
  assert.equal(parseVerdict("verdict: 通过了"), null);
  assert.equal(parseVerdict("verdict:\n通过"), null);
  assert.equal(parseVerdict("verdict: 待定\nverdict: 通过"), null);
});
