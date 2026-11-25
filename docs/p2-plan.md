# P2 plan: the big flow

Status: planned (2026-11-24). Unblocks per ADR 0004: the small flow has been
tried on a real project (T-001, fresh project, 2026-11-24 — coder → gate → QA,
1 round, passed), so P2 can start. Estimate from the design doc: ~1 week.
Implementation goes through Codex + gpt-6.2-astra (high reasoning effort),
one unit at a time, same as v0.1; every unit lands with tests + a live run.

## Units

### P2-1: Big-flow engine (`runBigFlow`)

Scope: `defaultFlow: "big"` selects it. Sequence: architect (read-only,
outputs the shared interface design; dispatcher writes it to the board) →
coder(s) → gate → QA → reviewer (after QA passes). QA and reviewer rejections
share one fix budget (fixBudget, default 2); exhaustion stops the run and
escalates to the user.

Files: `src/engine.ts` (new `runBigFlow`), `extensions/team.ts` (route by
`defaultFlow`), `test/engine.test.ts`.

Acceptance: a big-flow task runs end-to-end on a real project; a reviewer
rejection consumes budget and triggers a fix round; budget exhaustion stops
and escalates.

### P2-2: Parallel coders with worktree isolation

**Done 2026-11-24 (live-verified).** Scope: split one task into subtasks, spawn one coder per subtask, each in an
isolated worktree (`isolation: "worktree"` on spawn), collect the results and
merge them back into the main worktree. Worktree-isolation failure is an
error that stops the run — never a silent fallback (grill decision, ADR 0007).

Files: `src/engine.ts`, `src/rpc.ts` (isolation is already a spawn option),
`src/git.ts` (new), `src/tickets.ts` (new), `src/taskfile.ts`, `src/gate.ts`,
`src/init.ts`.

Acceptance: a task split into 2 subtasks completes with both coders' work
merged and the gate passing.

Live verification (pi-team-parallel): T-005 (strings + arrays) — planner wrote
2 subtask files, both coders ran in worktrees, settle committed to
`pi-agent-<id>` branches, engine merged both in order and deleted the
branches, gate + QA + reviewer passed, `node --test test/*.test.mjs` 12/12.
T-004 ran first and exposed two gaps, both fixed/verified before T-005:
(1) the worktree settle commits, so a project without git `user.name` /
`user.email` silently loses the coders' work — the merge then reports
"no changes" while the files sit staged in orphaned /tmp worktrees. Fixed
with a preflight identity check (fail fast, clear message); pi-team-parallel
now has identity configured. (2) the `/team` command timed out at the
review stage in T-004 (Pi-side turn budget; reviewer verdict came from a
supplementary review instead). T-005's reviewer instead hit transient
upstream HTTP 502s from Llmapi (three failures, then a retry passed once
the outage cleared) — infra flake, not a pi-team bug.

Decompose (decided by john 2026-11-24): the planner — the role that organizes
the requirement — splits the task with the `local-to-tickets` skill, along
the module boundaries from the architect's interface design. The tickets'
blocking edges decide what runs in parallel (no edges between them) and what
runs in waves (topological order).

Merge (decided by john 2026-11-24, accepts Muse's proposal): the engine — code,
not an agent — applies each coder's worktree diff to the main worktree in
dependency order. If every diff applies cleanly, the flow continues to
gate/QA. On a conflict, the run stops and escalates to the user with a report
(conflicting subtasks, files, both diffs); no auto-resolve, no integrator
agent by default. Rationale: a conflict means two subtasks touched the same
code with incompatible assumptions — a design divergence, and a model picking
a side (or inventing a third version) hides it; the dispatcher never writes
code (pi-team principle), and this matches the grill decision that
worktree-isolation failure stops instead of silently degrading. A
coder-as-integrator remains a manual fallback the user can trigger, not the
default. If the user picks this proposal, the fix is at the decomposition
step: the planner re-splits with cleaner boundaries, or the user resolves it
himself.

### P2-3: Reviewer stage

Scope: reviewer runs after QA passes; verdict recorded on the board
(extend the 验收结论 section or add a 评审结论 section); rejection sends
the task back to the coder within the shared fix budget.

Files: `src/engine.ts`.

Acceptance: a task with a reviewer rejection gets fixed and re-reviewed
within budget; budget exhaustion stops and escalates.

Open question: reviewer after QA only, or also a design review after the
architect step?

### P2-4: Security auditor trigger — DONE (2026-11-25, commit 8fe060d, pushed)

Scope: when the task file carries the `security-sensitive` label (or the
config trigger is `always`), run the security auditor; a rejection stops the
run and escalates to the user with no auto-fix loop. `never` disables it.
The `securityAudit` config (trigger + label) already exists in v0.1.

Position decision (taken 2026-11-25, was the plan's open question): the
auditor runs AFTER the reviewer passes (big flow) and after QA passes
(small flow), as the final gate before marking 通过 — never twice.
Labels come from a task-file header line `- 标签：a, b`. A rejection
writes the report to a `安全审计` board section and returns 打回 +
escalated with no fix round and no budget consumption; an unparseable
verdict and an auditor agent failure are handled the same way (the
failure interrupts the run instead).

Live verification (2026-11-25, pi-team-fresh T-004 `isSafeRedirect`,
labeled security-sensitive): architect → coder → gate → QA 通过 →
reviewer 通过 → auditor 打回 on a REAL finding — `/\evil.example`
passes the `/` prefix check but browsers may treat the backslash as a
slash, making it a protocol-relative external URL (open redirect). The
reviewer had only hinted at the same risk as a suggestion; the auditor
made it blocking. Task ended 打回 + escalated, fixRoundsUsed 0, no
coder re-spawn. The pass path is covered by unit tests only (106/106);
a live 通过 via the auditor is still unproven.

Follow-up fix found by the live run: `extensions/team.ts` hardcoded
"escalated: fix budget exhausted — needs a human" for every escalation.
`RunSummary` now carries `escalationReason` (budget exhaustion, security
audit rejected, parallel merge conflict) and the report renders the real
cause. The `summary()` closures omit the key when no reason is set, so
existing deepEqual test expectations still pass.

Files: `src/engine.ts`, `src/taskfile.ts`, `test/engine.test.ts`,
`extensions/team.ts`.

Live-run blocker found the same morning (NOT a pi-team bug): both
`/team run` attempts stalled ~25–30 min with zero board progress, and
bare `pi -p` probes hung the same way. Root cause was the launch, not
the key: `pi -p` waits on stdin when stdin is an open pipe with no EOF
(the exec runtime's stdin). Fix: always add `< /dev/null` to Pi
invocations (see TOOLS.md). The IP allowlist was suspected first
(egress changed after the 07:40 VM replacement) and john removed the
restriction, but the stdin fix is what unblocked it — whether the stale
allowlist (172.18.0.1) would also have blocked is unproven.

### P2-5: `/team status` — DONE (2026-11-25, implementation + tests; live check pending a key)

Scope: text report of the active run — run id, task, started time, per-role
state, fixBudget remaining. Reads the run lock + board state. A live status
widget is P3, not this unit.

Files: `extensions/team.ts`, new `src/status.ts` (`getRunStatus` +
`formatRunStatus`). Lock gains two optional fields: `fixRoundsUsed`
(patched after each increment in both flows) and `currentRoles`
(maintained alongside the agent ids at the same write points, so the
status report can name the active role; pre-change locks report
`"unknown"` for a single agent and `"coder"` for parallel ids).
Per-role completion is derived from board sections: 接口设计 / 实现记录 /
验收结论 / 评审结论 / 安全审计. `formatRunStatus` shows start time +
elapsed, stages as done/pending, active agents, fix budget remaining
(clamped at 0). Missing task file does not throw (title undefined, all
stages pending). Command mirrors `stop`: no lock → notify
"no pi-team run is active".

Acceptance: `/team status` prints the active run while a run is in flight
and "no active run" otherwise. Mostly independent of the other units (the
run lock already exists in v0.1).

Tests: 113/113 (was 106, +7 status tests incl. the engine persisting
`fixRoundsUsed === 2` after two QA rejections). tsc strict clean.

Live verification: DONE 2026-11-25, both paths, key still live at the
time (T-006 clamp task in pi-team-fresh): (1) no-run path → "no pi-team
run is active"; (2) active-run path mid-flight →
"pi-team run run-1795574942753-46630a / task: T-006 加一个 clamp 工具函数 /
started: 2026/11/25 10:49:02 (2m ago) / status: 实现中 /
stages: architect done, coder pending, qa pending, reviewer pending,
security-auditor pending / active: coder (61664fd1-b9da-461) /
fix budget: 2 of 2 remaining" — the `currentRoles` pairing works, the
stage checklist reads the board correctly. P2 is now fully done
(code + live): P2-1, P2-2, P2-3 (in P2-1), P2-4, P2-5.

## Order

P2-1 first (the skeleton the rest plugs into). P2-3 and P2-4 plug into P2-1
and can follow in either order. P2-2 needs P2-1 plus the worktree-isolation
path. P2-5 is independent and can land any time after P2-1.

## Not P2 (separate threads)

- Official `pi-subagents` RPC adapter (v1 protocol): open question from the
  2026-11-24 audit — build the adapter, or install HerbertGao's package as a
  stopgap on john's machine. Does not block P2, which runs on HerbertGao RPC v2.
- P3 (progress widget, cost accounting, resume, interactive `team_dispatch`),
  P4 (npm publish). Both wait for P2.
