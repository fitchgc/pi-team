# Role definitions live in generated agent files, not in runtime registration

The primary way a role takes effect is a `.pi/agents/<role>.md` file generated from the team config by `/team init`. Runtime registration over the pi-subagents RPC bus (`subagents:rpc:register-agents`) is a supplement for ad-hoc roles only.

The file route carries everything a role needs: a pinned `model:`, preloaded `skills:`, tool allowlist, and turn limit. The RPC route accepts only name, description, system prompt, and color, and forces `extensions: false, skills: false`. Worse, pi-subagents resolves the model from the agent file first and lets a caller-supplied model only fill gaps, so a model chosen at spawn time cannot override a file pin. Generating files is therefore the only route that makes per-project model configuration real.
