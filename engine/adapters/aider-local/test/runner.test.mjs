import test from "node:test";
import assert from "node:assert/strict";
import { runAiderLoop } from "../src/runner.js";
import { profileForMemory } from "../src/profile.js";

function harness({ passOnAttempt = 2, unauthorizedOn = null } = {}) {
  let attempt = 0;
  let changed = [];
  let untracked = [];
  const writes = new Map();
  const calls = [];
  const enc0 = (xs) => xs.length ? `${xs.join("\0")}\0` : "";
  const exec = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "git" && args[0] === "diff" && args.includes("--name-only")) return { exitCode: 0, stdout: enc0(changed), stderr: "", timedOut: false };
    if (cmd === "git" && args[0] === "diff" && args.includes("--cached")) return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (cmd === "git" && args[0] === "ls-files") return { exitCode: 0, stdout: enc0(untracked), stderr: "", timedOut: false };
    if (cmd === "git" && args[0] === "restore") { changed = changed.filter((x) => x !== args.at(-1)); return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; }
    if (cmd === "rm") { untracked = untracked.filter((x) => x !== args.at(-1)); return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; }
    if (cmd === "epaperclip-aider") {
      attempt++;
      changed = ["src/label.ts"];
      if (unauthorizedOn === attempt) changed.push("README.md");
      return { exitCode: 0, stdout: "Tokens: 1k sent, 100 received", stderr: "", timedOut: false };
    }
    if (cmd === "sh" && args[0] === "-lc") return { exitCode: attempt >= passOnAttempt ? 0 : 1, stdout: attempt >= passOnAttempt ? "ok" : "FAIL", stderr: "", timedOut: false };
    if (cmd === "git" && args[0] === "diff" && args.includes("--no-ext-diff")) return { exitCode: 0, stdout: "+fixed", stderr: "", timedOut: false };
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
  };
  return { exec, writeFile: async (p, c) => writes.set(p, c), writes, calls, attempts: () => attempt };
}

const contract = { goal: "fix", allowedFiles: ["src/label.ts"], testCommand: "npm test", definitionOfDone: "green", maxAttempts: 3, escalationAdapter: null, escalationConfig: {} };

test("retries until the explicit test command passes and returns evidence", async () => {
  const h = harness({ passOnAttempt: 2 });
  const out = await runAiderLoop({ contract, profile: profileForMemory(7600), ...h, taskFile: "/w/.epaperclip/task.md", settingsFile: "/w/.epaperclip/model.yml" });
  assert.equal(out.outcome, "pass");
  assert.equal(out.attemptsUsed, 2);
  assert.equal(out.diff, "+fixed");
  assert.equal(out.testLog, "ok");
  assert.deepEqual(out.usage, { inputTokens: 2000, outputTokens: 200 });
  const aider = h.calls.find(([c]) => c === "epaperclip-aider");
  assert.ok(aider);
  assert.ok(aider[1].includes("--auto-test"));
  assert.ok(aider[1].includes("--no-auto-commits"));
  assert.ok(aider[1].includes("src/label.ts"));
});

test("reverts newly changed files outside the allow-list and escalates", async () => {
  const h = harness({ passOnAttempt: 99, unauthorizedOn: 1 });
  const out = await runAiderLoop({ contract: { ...contract, maxAttempts: 1 }, profile: profileForMemory(7600), ...h, taskFile: "/w/.epaperclip/task.md", settingsFile: "/w/.epaperclip/model.yml" });
  assert.equal(out.outcome, "escalate");
  assert.deepEqual(out.scopeViolations, ["README.md"]);
  assert.ok(h.calls.some(([c, a]) => c === "git" && a[0] === "restore" && a.at(-1) === "README.md"));
});

test("4 GB profile rejects a two-file task before invoking aider", async () => {
  const h = harness();
  await assert.rejects(runAiderLoop({ contract: { ...contract, allowedFiles: ["a.ts", "b.ts"] }, profile: profileForMemory(4096), ...h, taskFile: "/w/t", settingsFile: "/w/s" }), /at most 1 editable/);
  assert.equal(h.attempts(), 0);
});
