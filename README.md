# pi-team

Pi extension that turns one Pi session into a multi-role coding team: the main session dispatches, role agents implement, and independent verification decides what ships.

## Why pi-team?

`pi-subagents` (official or HerbertGao's) gives you the mechanism: spawn child agents, run workflows, review in parallel. pi-team gives you the process on top of it:

- **A fixed pipeline, not ad-hoc delegation.** The dispatcher only dispatches and never implements. Coder → test gate → QA → reviewer, with QA and reviewer sharing one 2-round fix budget; an exhausted budget escalates to a human.
- **A task board as the single source of truth.** `.tasks/` files carry status, implementation record, and QA verdicts — readable any time, resumable after interruption.
- **One command to start.** `/team init` writes the config, generates role files, and copies the skills each role needs. No hand-written agent files or workflow scripts.
- **Per-project teams.** `.pi/team.json` selects roles and overrides each role's model, prompt, skills, tools, and turn limit. A hand-edited `.pi/agents/<role>.md` always wins.
- **Verification independent of implementation, enforced by the engine, not by convention.** The coder cannot mark its own work done; the QA verdict decides.
- **Deterministic orchestration.** The flow runs in code over the subagents RPC bus; models do the work, they don't decide the flow.

v0.2.0 ships the full pipeline: big flow (architect, parallel coders, reviewer, security auditor), resume, progress widget, interactive dispatch, and cost accounting. If you prefer to script the pipeline yourself, pi-subagents workflows can express much of the same — pi-team's value is the enforced process, not the mechanism.

## Install

```bash
pi install git:github.com/fitchgc/pi-team@v0.2.0
```

Requires Pi ≥ 1.1.0 and `@herbertgao/pi-subagents` (the extension drives subagents through its cross-extension RPC bus). The official `pi-subagents` package uses a different RPC protocol (v1); pi-team ships an adapter for it — set `"subagents": "official"` in `.pi/team.json` (HerbertGao stays the default). Live verification of the official backend is still pending.

The package is not on npm yet, so `pi install npm:@fitchgc/pi-team` does not work today; install from GitHub as above until it is published.

## Quick start

```bash
/team init     # write .pi/team.json and generate role files for this project
/team roles    # show the effective roles, models, and where each came from
/team run <task-file>   # run the pipeline: architect -> coder -> gate -> QA -> reviewer
/team status   # show the active run: stages, active agents, fix budget left
/team resume <task-file>  # resume an interrupted run where it stopped
```

## Configure per project

`.pi/team.json` selects which roles the project uses and overrides each role's model, prompt, skills, tools, and turn limit. A hand-edited `.pi/agents/<role>.md` always wins over the JSON. See `team.schema.json` for the full schema.

## Status

v0.2.0: big flow (architect, parallel coders, reviewer, security auditor), `/team status`, `/team resume`, progress widget, `team_dispatch` tool, and cost accounting on the official backend. npm publish is still pending.
