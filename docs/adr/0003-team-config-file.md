# Team configuration lives in `.pi/team.json`, not in Pi settings

Per-project team configuration (enabled roles, per-role model, prompt, skills, tools, turn limit, board path, fix budget) is stored in a dedicated `.pi/team.json` file read by the extension with plain file IO. It is not stored in Pi's `settings.json`.

Pi's settings have a fixed schema with no namespace for extension-owned keys, and `pi.getSettings()` only returns merged official settings. A dedicated file keeps the schema ours to version, keeps project config committable next to the role files it generates, and keeps `settings.json` free of keys Pi would not recognise.
