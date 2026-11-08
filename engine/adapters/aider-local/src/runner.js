import { modelSettingsYaml, parseAiderTokens } from "./profile.js";
import { taskMarkdown } from "./task.js";

const split0 = (s) => String(s || "").split("\0").filter(Boolean);
const uniq = (a) => [...new Set(a)];

async function repoChanges(exec) {
  const [work, staged, untracked] = await Promise.all([
    exec("git", ["diff", "--name-only", "-z"], {}),
    exec("git", ["diff", "--cached", "--name-only", "-z"], {}),
    exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], {}),
  ]);
  for (const r of [work, staged, untracked]) if (r.exitCode !== 0) throw new Error(`git status check failed: ${(r.stderr || r.stdout || "unknown error").slice(-1000)}`);
  return { tracked: uniq([...split0(work.stdout), ...split0(staged.stdout)]), untracked: split0(untracked.stdout) };
}

async function restoreUnauthorized(exec, paths, untracked) {
  const untrackedSet = new Set(untracked);
  for (const file of paths) {
    if (untrackedSet.has(file)) {
      await exec("rm", ["-rf", "--", file], {});
    } else {
      await exec("git", ["restore", "--source=HEAD", "--staged", "--worktree", "--", file], {});
    }
  }
}

function aiderArgs({ contract, profile, taskFile, settingsFile }) {
  return [
    "--model", profile.aiderModel,
    "--weak-model", profile.aiderModel,
    "--edit-format", profile.editFormat,
    "--model-settings-file", settingsFile,
    "--map-tokens", String(profile.mapTokens),
    "--message-file", taskFile,
    "--test-cmd", contract.testCommand,
    "--auto-test",
    "--yes-always",
    "--no-auto-commits",
    "--no-dirty-commits",
    "--no-auto-lint",
    "--no-gitignore",
    "--no-check-update",
    "--no-show-release-notes",
    "--no-show-model-warnings",
    "--no-check-model-accepts-settings",
    "--no-suggest-shell-commands",
    "--analytics-disable",
    "--no-pretty",
    "--no-stream",
    ...contract.allowedFiles,
  ];
}

export async function runAiderLoop({ contract, profile, exec, writeFile, taskFile, settingsFile, command = "epaperclip-aider", env = {}, timeoutMs = 900000, onAttempt = async () => {} }) {
  if (contract.allowedFiles.length > profile.maxEditableFiles) {
    throw new Error(`${profile.tier} profile allows at most ${profile.maxEditableFiles} editable file(s); task requested ${contract.allowedFiles.length}.`);
  }
  const allowed = new Set(contract.allowedFiles);
  const before = await repoChanges(exec);
  const dirtyOutside = uniq([...before.tracked, ...before.untracked]).filter((f) => !allowed.has(f));
  if (dirtyOutside.length) throw new Error(`Workspace has pre-existing changes outside the task allow-list: ${dirtyOutside.join(", ")}`);

  await writeFile(settingsFile, modelSettingsYaml(profile));
  let previousFailure = "";
  let attemptsUsed = 0;
  let testLog = "";
  let passed = false;
  let scopeViolations = [];
  let aiderOutput = "";
  const started = Date.now();

  for (let attempt = 1; attempt <= contract.maxAttempts; attempt++) {
    attemptsUsed = attempt;
    await writeFile(taskFile, taskMarkdown(contract, previousFailure));
    const run = await exec(command, aiderArgs({ contract, profile, taskFile, settingsFile }), { env, timeoutMs });
    const combined = `${run.stdout || ""}${run.stderr ? `\n${run.stderr}` : ""}`;
    aiderOutput += `${aiderOutput ? "\n" : ""}--- attempt ${attempt} ---\n${combined}`;

    const changed = await repoChanges(exec);
    const unauthorized = uniq([...changed.tracked, ...changed.untracked]).filter((f) => !allowed.has(f));
    if (unauthorized.length) {
      await restoreUnauthorized(exec, unauthorized, changed.untracked);
      scopeViolations = uniq([...scopeViolations, ...unauthorized]);
    }

    const test = await exec("sh", ["-lc", contract.testCommand], { timeoutMs });
    testLog = `${test.stdout || ""}${test.stderr ? `\n${test.stderr}` : ""}`.trim();
    passed = test.exitCode === 0 && !test.timedOut && unauthorized.length === 0;
    await onAttempt({ attempt, aiderExitCode: run.exitCode, testExitCode: test.exitCode, passed, scopeViolations: unauthorized, testLog });
    if (passed) break;
    previousFailure = [
      unauthorized.length ? `Scope violation: changed ${unauthorized.join(", ")}; those changes were reverted.` : "",
      test.timedOut ? "The test command timed out." : "",
      testLog || `Test command exited ${test.exitCode}`,
    ].filter(Boolean).join("\n");
  }

  const diffRun = await exec("git", ["diff", "--no-ext-diff", "--", ...contract.allowedFiles], {});
  const diff = diffRun.stdout || "";
  const usage = parseAiderTokens(aiderOutput);
  const wallTimeMs = Date.now() - started;
  return {
    outcome: passed ? "pass" : "escalate",
    passed,
    attemptsUsed,
    model: profile.model,
    aiderModel: profile.aiderModel,
    editFormat: profile.editFormat,
    numCtx: profile.numCtx,
    mapTokens: profile.mapTokens,
    diff,
    testLog,
    scopeViolations,
    usage,
    wallTimeMs,
    tokensPerSecond: wallTimeMs > 0 && usage.outputTokens > 0 ? Number((usage.outputTokens / (wallTimeMs / 1000)).toFixed(2)) : null,
    aiderOutput,
  };
}
