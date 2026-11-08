export const type = "aider_local";
export const label = "Aider (small device)";
export const models = [
  { id: "qwen2.5-coder:7b", label: "Qwen2.5 Coder 7B (8 GB+)" },
  { id: "qwen2.5-coder:3b", label: "Qwen2.5 Coder 3B (4 GB)" },
];

export const agentConfigurationDoc = `# aider_local agent configuration

Adapter: aider_local

Purpose:
- Run small, test-driven coding tasks on persistent ePaperclip Worker Fabric nodes.
- Use Aider with a memory-sized local Ollama model, then escalate failures to claude_local or codex_local.

Task contract (required per run in context.aiderTask/context.taskContract, or as adapterConfig.taskContract):
- goal: exact outcome
- allowedFiles: one to three repository-relative files (4 GB tier allows one)
- testCommand: mandatory correctness command; the adapter refuses tasks without it
- definitionOfDone: explicit acceptance criteria
- maxAttempts: optional, 1-5, default 3

Adapter config:
- command: defaults to epaperclip-aider (installed by deploy/worker/install-aider.sh)
- timeoutSec: defaults to 900 seconds
- graceSec: defaults to 20 seconds
- env: optional environment values
- escalationAdapter: claude_local or codex_local
- escalationConfig: adapterConfig passed to that stronger adapter after the small-model lane exhausts retries

Behavior:
- Device memory chooses the local profile: 4 GB -> qwen2.5-coder:3b + whole-file edits; 8 GB -> qwen2.5-coder:7b + diff edits.
- Ollama num_ctx is explicitly pinned to 8192 on the small tiers (16384 on 12 GB+).
- Aider receives only the declared editable files, --test-cmd/--auto-test, --yes-always, and no auto commits.
- The adapter also runs the test command itself after each outer attempt and reverts any newly changed file outside the allow-list.
- Failed tasks return an escalation record; when a stronger adapter is configured, the current diff and test log are handed to it automatically.
`;

export { createServerAdapter } from "./server/index.js";
