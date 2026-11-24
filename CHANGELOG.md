# Changelog

## 0.1.0 — 2026-11-24

First release: package skeleton plus the small flow.

- `/team init` writes `.pi/team.json`, generates role agent files, copies the
  skills each role needs into `.pi/skills/`, and creates the task board.
- `/team roles` shows the effective roles, models, skills, tools, and turn
  limits, with the source of each value.
- `/team run` runs the small flow: coder, test gate, QA, with a shared
  2-round fix budget. `/team stop` stops an active run.
- Default models are Llmapi-only (sol for dispatcher, planner, and reviewer;
  astra for coder, architect, QA, and security auditor). Any provider can be
  used per role through `.pi/team.json`.
- One active run per task board, enforced with a lock file.
