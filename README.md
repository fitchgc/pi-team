# pi-team

Pi extension that turns one Pi session into a multi-role coding team: the main session dispatches, role agents implement, and independent verification decides what ships.

## Install

```bash
pi install npm:@fitchgc/pi-team
```

Requires Pi ≥ 1.1.0 and `@herbertgao/pi-subagents` (the extension drives subagents through its cross-extension RPC bus).

## Quick start

```bash
/team init     # write .pi/team.json and generate role files for this project
/team roles    # show the effective roles, models, and where each came from
/team run <task-file>   # run the pipeline: coder -> gate -> QA
```

## Configure per project

`.pi/team.json` selects which roles the project uses and overrides each role's model, prompt, skills, tools, and turn limit. A hand-edited `.pi/agents/<role>.md` always wins over the JSON. See `team.schema.json` for the full schema.

## Status

v0.1 (in development): package skeleton, `/team init`, `/team roles`, `/team run` for the small flow. The big flow (architect, parallel coders, reviewer, security auditor), status widget, resume, and cost accounting come later.
