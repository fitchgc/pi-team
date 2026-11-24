# pi-team

Pi-team turns Pi into a multi-role coding team that runs on one machine: the main session dispatches, role agents implement, and independent verification decides what ships.

## Language

**Dispatcher**:
The main Pi session. It decomposes a requirement into tasks, hands tasks to roles, and records verdicts. It writes code never.
_Avoid_: coordinator, orchestrator (as a person); the orchestrator is the extension code, see below

**Role**:
A named agent persona with a fixed job: planner, architect, coder, qa, reviewer, security-auditor. Each role has a model, a prompt, skills, tools, and a turn limit.
_Avoid_: agent type, subagent (a role is what it does; a subagent is how Pi runs it)

**Task board**:
The `.tasks/` directory. One file per task, the single source of truth for what is todo, implemented, or done. Roles read and write it; the dispatcher owns its state transitions.
_Avoid_: issue tracker, queue

**Run**:
One execution of the pipeline over a task file, from dispatch to a done or stopped verdict. One board has at most one active run.
_Avoid_: session, job

**Fix budget**:
The number of times a rejected task may go back to the coder. QA and reviewer rejections share one budget, default 2.
_Avoid_: retry count

**Gate**:
A check that must pass before the next step runs, currently the project's test command. A gate failure is a verdict, not a suggestion.
_Avoid_: check, validation

**Team config**:
`.pi/team.json` in the project. It selects which roles the project uses and overrides each role's model, prompt, skills, tools, and turn limit.
_Avoid_: settings (that word means Pi's own `settings.json`)

**Package agent**:
A default role definition shipped inside the pi-team package. Lowest priority: any project or user agent file with the same name silently wins.
_Avoid_: built-in role

**Ephemeral agent**:
A role registered at runtime over the pi-subagents RPC bus, with no file behind it. It carries only a name, description, and prompt: no model pin, no skills.
_Avoid_: temporary agent (as a file)

**Worktree isolation**:
Running parallel coders in temporary git worktrees, one per task, merged back on completion. Only available in git repos with at least one commit.
_Avoid_: sandbox
