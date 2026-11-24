# The extension drives orchestration over RPC, not workflow scripts

The pipeline (coder, gate, QA, reviewer, fix budget) is implemented as TypeScript code in the extension, driving pi-subagents through its cross-extension RPC bus (`subagents:rpc:spawn`, completion events, `consume`, `steer`, `stop`). It is not a `SubagentWorkflow` script.

The RPC surface has no channel to start a workflow: `workflow_get` and `workflow_list` only query a workflow that is already running, and a workflow can only be started by the model calling the `SubagentWorkflow` tool. Building the engine on workflow scripts would hand determinism back to the model remembering to call the tool, which is exactly what the plugin exists to remove.
