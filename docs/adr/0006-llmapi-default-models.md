# Default models are Llmapi-only

The package's default role models all come from Llmapi: sol for dispatcher, planner, and reviewer; astra for coder, architect, QA, and security auditor. Antigravity/ACP models are not defaults, even though the author's own setup uses them for coder, architect, and reviewer.

A default that needs an Antigravity account does not run for anyone else, which defeats the point of an open-source default. Anyone with Llmapi access can install and run v0.1 with zero extra setup. Projects that have agy models override per role in `.pi/team.json` (one line per role); the author's own projects do exactly that. Reviewer on sol is the deliberate cost saving: review is a checklist task against existing conventions, and a project that wants stronger review bumps one line to astra.
