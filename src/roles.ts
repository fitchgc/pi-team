import { ROLE_NAMES, type ResolvedConfig } from "./config.js";

export function formatRolesTable(config: ResolvedConfig): string {
  const lines = [
    `board: ${config.board}`,
    `dispatcher model: ${config.dispatcherModel ?? "(unset)"}`,
    `default flow: ${config.defaultFlow}`,
    `fix budget: ${config.fixBudget}`,
    "",
  ];
  const warnings: string[] = [];

  for (const role of ROLE_NAMES) {
    const def = config.roles[role];
    const columns = [
      role,
      def.source,
      def.model ?? "(inherit)",
      `skills:${def.skills.length}`,
      `tools:${def.tools.length}`,
      `turns:${def.maxTurns ?? "-"}`,
    ];
    if (def.model !== undefined && !/^[^/\s]+\/\S+$/.test(def.model)) {
      warnings.push(
        `WARN: ${role} model '${def.model}' is not a provider/modelId; the agent will inherit the parent model`,
      );
    }
    if (!def.enabled) {
      columns.push("DISABLED");
      warnings.push(`WARN: ${role} is disabled`);
    }
    lines.push(columns.join("  "));
  }

  return [...lines, "", ...(warnings.length ? warnings : ["All roles resolve."])].join("\n");
}
