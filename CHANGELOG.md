# Changelog

## 0.2.0 — 2026-11-25

Big flow, resume, and cost accounting.

- `/team run` now runs the big flow by default: architect writes the
  interface design, coder implements, test gate, QA, reviewer, with QA and
  reviewer sharing one 2-round fix budget.
- Parallel coders: the planner splits a task along the architect's interface
  boundaries; coders work in isolated worktrees and the engine merges their
  branches in dependency order, stopping on conflict.
- Security auditor: runs as the final gate after reviewer (big flow) or QA
  (small flow) on tasks labeled `security-sensitive` (configurable to
  `always` or `never`); a rejection escalates with no fix loop.
- `/team status` shows the active run: stages, active agents, fix budget left.
- `/team resume <task-file>` resumes an interrupted run from the right stage;
  the fix budget resets.
- Progress widget: two-line status above the editor while a run is live (TUI).
- `team_dispatch` tool: the main session dispatches a task in plain language.
- Cost accounting: runs on the official backend report USD cost per role in
  the run summary.
- Official `pi-subagents` adapter: set `"subagents": "official"` in
  `.pi/team.json` (HerbertGao stays the default). Parallel coding is not
  supported on the official backend yet; live verification is pending.

## 0.1.0 — 2026-11-24

First release: package skeleton plus the small flow.

- `/team init` writes `.pi/team.json`, generates role agent files, copies the
  skills each role needs into `.pi/skills/`, and creates the task board.
- `/team roles` shows the effective roles, models, skills, tools, and turn
  limits, with the source of each value.
- `/team run` runs the small flow: coder, test gate, QA, with a shared
  2-round fix budget. `/team stop` stops an active run.
- Default models are Llmapi-only (sol for dispatcher and planner; terra for
  reviewer; astra for coder, architect, QA, and security auditor). Any
  provider can be used per role through `.pi/team.json`.
- One active run per task board, enforced with a lock file.
