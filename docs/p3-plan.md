# P3 plan

P3 = the experience layer: progress widget, cost accounting, resume
(断点续跑), interactive `team_dispatch`. Design doc line 278 lists the same
four items; `/team stop` was listed there too but already landed in v0.1.
P2 is done (code + live, 2026-11-25). P3 units in order:

## P3-1: resume — `/team resume <task-file>` — DONE (2026-11-25, implementation + tests; live check pending a key)

Ctrl+C / `/team stop` currently abandons the run: the task sits at 已中断
and `/team run` restarts it from scratch. Resume re-enters the flow from
the last completed board stage instead of redoing finished work.

- Preconditions: task status must be 已中断 (anything else → error, use
  `/team run`); no other run active (same guard as `run`).
- Stage derivation from the board (big flow):
  - no 接口设计 → architect (full re-run)
  - 接口设计 present, no 实现记录 → coder
  - 实现记录 present, no 验收结论 → gate + QA
  - 验收结论 present (QA 通过), no 评审结论 → reviewer
  - 评审结论 present, no 安全审计, and the task needs an audit
    (label / `always`) → auditor
  - all sections present → re-run from gate + QA (verify the code on disk;
    never silently mark 通过)
  - small flow: no 实现记录 → coder; 实现记录 present, no 验收结论 →
    gate + QA; 验收结论 present → re-run gate + QA.
- Implementation: optional `startAt` stage parameter on both flows
  (`architect | coder | verify | reviewer | auditor`, where `verify` =
  gate + QA as one stage; small flow uses `coder | verify`). `startAt`
  applies to the first pass only — fix iterations run the full loop.
- Fix budget resets to 0 on resume (a fresh budget per resume; each
  resume is a human decision, so no silent infinite loop).
- Parallel tasks: resume restarts from the planner (full re-run of the
  parallel flow). Documented limitation — merge-state resume is a
  follow-up, not this unit.
- The resumed run gets a new runId and the status goes back to 实现中.
  Auditor trigger rules are the same as the normal flows.
- Files: new `src/resume.ts` (stage derivation + wrapper), `src/engine.ts`
  (`startAt` plumbing), `extensions/team.ts` (`resume` subcommand).
- Tests: 124/124 (was 113, +11 resume tests incl. stage derivation,
  skipped-agent assertions, fresh fix budget, parallel restarts at the
  planner). tsc strict clean.
- Notes: the Codex diff arrived with three corrupt hunk headers (off-by-one
  counts) plus bare empty lines git rejects — repaired by normalizing the
  empty lines and recomputing the headers; only two header numbers changed,
  content untouched. One test-only type fix by hand (stub `git` needed the
  `timedOut` field). Live verification: DONE 2026-11-25, key still live
  at the time. T-008 (isOdd) in pi-team-fresh: started a run, `/team
  stop` at ~75s (status 已中断, 接口设计 + 实现记录 present, no 验收结论),
  then `/team resume` → 通过 in 27s with `rounds: 0` (no coder spawned —
  the resume entered at verify as designed), the 接口设计 section
  byte-identical (md5 754a14fd… unchanged, architect did not re-run),
  the original coder record kept, QA + reviewer ran, 15 tests pass.
  The stopped run's own process exited with "no longer owns the lock"
  (expected — the stop removed the lock). The non-interrupted error
  path was also checked live (`/team resume` on 通过 T-004 →
  "is not interrupted"). P3-1 is fully done (code + live).

## P3-2: progress widget — DONE (2026-11-25, implementation + tests; live TUI check pending)

Live TUI progress during `/team run`: role, stage, fix rounds used.
API verified in the installed Pi 1.5.2 types
(`@earendil-works/pi-coding-agent`):
- `ctx.ui.setWidget(key, content: string[], options?: { placement?: "aboveEditor" | "belowEditor" })`
- `ctx.ui.setStatus(key, text | undefined)` (already used by `run`).
Design doc line 245 already anticipates this: "扩展用 `ctx.ui.setStatus` /
`setWidget` 在 TUI 底部显示进度（角色、状态、已用轮次）".
Shape: the engine takes an `onProgress` callback (stage transitions,
active role, fixRoundsUsed); the extension renders it into the widget in
interactive mode and clears it when the run ends. Print mode keeps the
text report (no widget there). Tests: callback invocation per stage +
widget content formatting; live check needs an interactive Pi session.

Implementation: new `src/progress.ts` (`RunProgress`, `formatProgressLines`
— two lines: `pi-team ${taskId} — ${stage}` and
`agent: ${role} · fix ${used}/${budget} · round ${n}`). The engine emits
from the `agent()` helper right after each spawn (so resume entries are
correct with no special-casing) and before each gate call; no `done`
event — the extension clears the widget in the `finally` block. The
widget updates only when `ctx.mode === "tui"` (`ExtensionMode` is
`"tui" | "rpc" | "json" | "print"`; the type docs say to guard
terminal-only UI with `"tui"`). Both `run` and `resume` wire the same
callback. Tests: 129/129 (was 124, +5 progress tests incl. event
sequences for small/big flows, fix-round counters, resume-from-verify
first event `gate`). tsc strict clean. This time the Codex diff applied
cleanly on the first check (the P3-1 empty-line warning in the brief
worked).

Live verification: DONE 2026-11-25 via a real TUI session (`script -qec
`pi -a`` in pi-team-fresh, T-009 isPositive). The widget rendered above
the editor and updated across stages — the terminal capture shows
`pi-team T-009 — architect` / `agent: architect · fix 0/2 · round 0`,
then coder (round 1), qa (round 1), reviewer (round 1); after the run
the widget rows and the status line were cleared, and T-009 ended 通过
(16 tests pass). The `gate` stage never rendered — it runs for ~1s and
the TUI coalesced the update before a frame; the event itself fires
(unit-tested), so this is a rendering timing artifact, not a bug.
Side notes from the session: `/exit` is NOT a Pi command (it went to the
main model as a prompt — interrupted with Ctrl+C, no harm); Pi 1.6.0 is
available (we run 1.5.2 — do not upgrade mid-roadmap). P3-2 is fully
done (code + live).

## P3-3: interactive `team_dispatch` — DONE (2026-11-25, implementation + tests; live check pending)

The main session dispatches work to the team and watches it: the dispatcher
as a persistent role in the main session. Today `/team run` is user-invoked;
`team_dispatch` lets the main session do it, so the user just says "add X"
in the main session and the main session creates the task, runs the team,
and reports back.

Decisions (verified against the installed Pi 1.5.2 types):
- A registered TOOL, not a slash command: `pi.registerTool` with a TypeBox
  parameter schema (`typebox` is already a pi-team peerDependency).
  Name `team_dispatch`. The main session calls it; the user never types it.
- Parameters: `task` (required, the requirement in the user's words),
  `title` (optional, short title for the task file), `acceptance`
  (optional, acceptance criteria, one per line), `parallel` (optional,
  default false), `labels` (optional string[], e.g. `["security-sensitive"]`).
- Behavior: allocate the next task id (scan `.tasks/T-*.md`, max+1),
  write the task file in the board format (status 待实现; `- 并行：是` /
  `- 标签：` headers when set; `## 需求` + task; `## 验收标准` + acceptance,
  omitted when absent), then run the same flow as `/team run`
  (config `defaultFlow`; widget progress via the P3-2 `onProgress`
  callback; the tool's AbortSignal passed through to the flow).
  Returns the run summary as the tool result text. One run at a time:
  the engine lock enforces it; on a lock conflict the task file stays
  as 待实现 (the user can `/team run` it later) and the tool returns an
  `isError` result the main session can explain.
- Confirmation: NO `ctx.ui.confirm` dialog (it exists, but it is not
  used). The main session's conversation is the confirmation layer —
  the model asks the user in chat when the request is vague and calls
  the tool when it is clear. The tool is only reachable by the main
  session, never by a raw user keystroke, so the model is the gate.
- `executionMode: "sequential"` (a minutes-long dispatch must not run
  concurrently with other tool calls). Errors from the flow are returned
  as `isError` results, not thrown. The tool errors clearly when the
  project is not initialized (`/team init` not run).
- Files: new `src/dispatch.ts` (`dispatchTask`, engine-level, testable
  with FakeRpc); task-file building in `src/taskfile.ts`
  (`allocateTaskId` + `buildTaskContent`); thin tool handler in
  `extensions/team.ts`. No changes to the flows, the lock, or `/team run`.
- Tests: id allocation, slug/title, parallel/labels headers, acceptance
  present/absent, dispatch end-to-end with FakeRpc (file on disk, flow
  runs, summary returned, status 通过), lock conflict. The tool
  registration itself is verified live only.
- Live verification: interactive TUI session — type a plain request in
  the main session ("add isNegative to math.mjs"), watch the model call
  `team_dispatch`, the widget show progress, the task complete, and the
  main session narrate the result. Needs a working Llmapi key.

Implementation: new `src/dispatch.ts` (`dispatchTask` — allocate id,
write the task file, run the configured flow) + `allocateTaskId` /
`buildTaskContent` in `src/taskfile.ts` + the `team_dispatch` tool
registration in `extensions/team.ts` (TypeBox params, sequential,
errors as `isError` results). Tests: 135/135 (was 129, +6 dispatch
tests incl. id allocation, exact file format, end-to-end dispatch,
lock conflict leaving the file 待实现). tsc strict clean. The Codex
diff applied cleanly on the first check again.
Note (Codex's own addition, kept): `dispatchTask` rejects input whose
task text contains a `- 测试命令：` line — `parseTaskFile` would read
that line anywhere in the file as the test command and the gate would
EXECUTE it, so dispatch refuses rather than letting model prose become
an executable command; the error tells the model to indent the line.
Live verification: NOT done yet — needs an interactive TUI session
(main session must call the tool itself).

## P3-4: cost accounting (last — gated on the adapter decision)

Per-run cost summary, consistent with Pi's `/session` accounting
(design doc line 278: "费用汇总与 `/session` 一致").
Blocker: the subagent token/cost data is NOT visible to the extension
through the HerbertGao RPC v2 (no cost method; `SubagentInfo` carries no
usage) or through the main session's context usage (child sessions are
separate). The official `pi-subagents` 0.90.0 HAS a `cost` method — so
cost accounting needs the official-RPC adapter (open question from the
2026-11-24 audit, undecided by john) or a design spike proving another
source. Do not build this unit until the adapter question is decided.

## Order

P3-1 first (highest value: interrupted runs are the painful case — T-004
hit a suspected Pi-side timeout mid-review on 2026-11-24). P3-2 next
(small, API already verified). P3-3 after the widget. P3-4 last, gated.

## Not P3

- P4 (npm publish) — needs john's npm login.
- Official-RPC adapter itself — separate thread, decides P3-4.
