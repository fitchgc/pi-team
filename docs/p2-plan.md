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

### P2-4: Security auditor trigger

Scope: when the task file carries the `security-sensitive` label (or the
config trigger is `always`), run the security auditor; a rejection stops the
run and escalates to the user with no auto-fix loop. `never` disables it.
The `securityAudit` config (trigger + label) already exists in v0.1.

Files: `src/engine.ts`.

Acceptance: a labeled task triggers the audit; a rejection stops the run and
escalates; an unlabeled task skips it.

Open question: auditor after QA, after reviewer, or both?

### P2-5: `/team status`

Scope: text report of the active run — run id, task, started time, per-role
state, fixBudget remaining. Reads the run lock + board state. A live status
widget is P3, not this unit.

Files: `extensions/team.ts`, new `src/status.ts` if the formatting grows.

Acceptance: `/team status` prints the active run while a run is in flight
and "no active run" otherwise. Mostly independent of the other units (the
run lock already exists in v0.1).

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
