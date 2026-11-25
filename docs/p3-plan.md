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
  `timedOut` field). Live verification: NOT done yet — needs a working
  Llmapi key (john is disabling the VM key used for P2-4/T-004/P2-5).
  Paths to check live: interrupt a run mid-flight (`/team stop`), then
  `/team resume` and confirm it continues from the last completed stage
  instead of restarting.

## P3-2: progress widget (next)

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

## P3-3: interactive `team_dispatch` (after the widget)

A dispatcher entry point for interactive use, as opposed to the
print-mode `/team run` command. Design still open: most likely a
registered TOOL (not just a slash command) the main session can call,
with interactive confirmation / stage progress via the P3-2 widget.
Do not start before the widget lands — the dispatch UX depends on it.
Needs a short design note before implementation.

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
