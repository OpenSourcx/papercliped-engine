const ADAPTERS = new Set(["claude_local", "codex_local"]);

export class TaskContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskContractError";
    this.code = code;
  }
}

function string(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function normalizeAllowedFile(value) {
  if (typeof value !== "string") throw new TaskContractError("bad_allowed_file", "Every allowed file must be a string.");
  const s = value.trim().replace(/\\/g, "/");
  if (!s || s.startsWith("/") || s.includes("\0")) throw new TaskContractError("bad_allowed_file", `Allowed file must be a relative repository path: ${value}`);
  const parts = s.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) throw new TaskContractError("bad_allowed_file", `Allowed file may not escape the workspace: ${value}`);
  if (s.length > 512) throw new TaskContractError("bad_allowed_file", "Allowed file path is too long.");
  return s;
}

function object(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/**
 * A per-run contract may be supplied as context.aiderTask/taskContract. Agent
 * config is the fallback so dedicated small-device agents remain easy to set up.
 */
export function taskContract(config = {}, context = {}) {
  const raw = object(context.aiderTask ?? context.taskContract ?? config.taskContract);
  const goal = string(raw.goal) ?? string(context.taskTitle) ?? string(context.issueTitle) ?? string(config.goal);
  const definitionOfDone = string(raw.definitionOfDone) ?? string(config.definitionOfDone);
  const testCommand = string(raw.testCommand) ?? string(config.testCommand);
  const sourceFiles = Array.isArray(raw.allowedFiles) ? raw.allowedFiles : Array.isArray(config.allowedFiles) ? config.allowedFiles : [];
  const allowedFiles = [...new Set(sourceFiles.map(normalizeAllowedFile))];
  if (!goal) throw new TaskContractError("goal_required", "Aider tasks require a goal.");
  if (!allowedFiles.length) throw new TaskContractError("allowed_files_required", "Aider tasks require an explicit allowed-files list.");
  if (!testCommand) throw new TaskContractError("test_required", "Aider tasks require a test command; refusing an untestable small-model edit.");
  if (!definitionOfDone) throw new TaskContractError("definition_required", "Aider tasks require a definition of done.");
  if (allowedFiles.length > 3) throw new TaskContractError("too_many_files", "Aider small-device tasks may name at most three editable files.");
  const attemptsRaw = raw.maxAttempts ?? config.maxAttempts ?? 3;
  const maxAttempts = Number(attemptsRaw);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new TaskContractError("bad_attempts", "maxAttempts must be a whole number from 1 to 5.");
  const escalationAdapter = string(raw.escalationAdapter) ?? string(config.escalationAdapter);
  if (escalationAdapter && !ADAPTERS.has(escalationAdapter)) throw new TaskContractError("bad_escalation_adapter", "Escalation adapter must be claude_local or codex_local.");
  const escalationConfig = object(raw.escalationConfig ?? config.escalationConfig);
  return { goal, allowedFiles, testCommand, definitionOfDone, maxAttempts, escalationAdapter: escalationAdapter || null, escalationConfig };
}

export function taskMarkdown(contract, previousFailure = "") {
  const lines = [
    "# ePaperclip small-device task",
    "",
    "## Goal",
    contract.goal,
    "",
    "## Editable files",
    ...contract.allowedFiles.map((f) => `- ${f}`),
    "",
    "## Test command",
    "```sh",
    contract.testCommand,
    "```",
    "",
    "## Definition of done",
    contract.definitionOfDone,
    "",
    "## Hard rules",
    "- Edit only the files listed above.",
    "- Do not commit, push, change remotes, or modify credentials.",
    "- Use the supplied test command as the correctness oracle.",
    "- Keep the change as small as possible.",
  ];
  if (previousFailure) lines.push("", "## Previous failing test output", "```text", previousFailure.slice(-12000), "```");
  return `${lines.join("\n")}\n`;
}

export function escalationMarkdown(contract, outcome) {
  return [
    "# Escalation from ePaperclip Aider small-device lane",
    "",
    `Small model: ${outcome.model}`,
    `Attempts used: ${outcome.attemptsUsed}`,
    "",
    "## Goal",
    contract.goal,
    "",
    "## Allowed files",
    ...contract.allowedFiles.map((f) => `- ${f}`),
    "",
    "## Definition of done",
    contract.definitionOfDone,
    "",
    "## Test command",
    "```sh",
    contract.testCommand,
    "```",
    "",
    "## Small-model diff",
    "```diff",
    outcome.diff || "(no diff)",
    "```",
    "",
    "## Last test output",
    "```text",
    outcome.testLog || "(no test output)",
    "```",
    "",
    "Continue from the current workspace. Fix the task, run the required test command, and keep edits inside the allowed files unless the task is impossible without escalation beyond this scope.",
    "",
  ].join("\n");
}
