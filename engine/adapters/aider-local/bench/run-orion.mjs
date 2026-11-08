import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { profileForMemory } from "../src/profile.js";
import { runAiderLoop } from "../src/runner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "make-label");
const runs = Number(process.env.EPC_AIDER_BENCH_RUNS || 5);
const profile = profileForMemory(Number(process.env.EPC_AIDER_MEM_MB || 7600));
const command = process.env.EPC_AIDER_COMMAND || "epaperclip-aider";

async function proc(cwd, cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (b) => stdout += b);
    child.stderr.on("data", (b) => stderr += b);
    if (options.stdin != null) child.stdin.end(options.stdin); else child.stdin.end();
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs) : null;
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? 1, signal, timedOut, stdout, stderr });
    });
  });
}

async function initRepo(dir) {
  await fs.cp(fixture, dir, { recursive: true });
  await proc(dir, "git", ["init", "-q"]);
  await proc(dir, "git", ["config", "user.email", "epaperclip-bench@localhost"]);
  await proc(dir, "git", ["config", "user.name", "ePaperclip Aider Bench"]);
  await proc(dir, "git", ["add", "."]);
  await proc(dir, "git", ["commit", "-qm", "benchmark baseline"]);
}

function contract(testCommand, maxAttempts = 3) {
  return {
    goal: "Implement makeLabel(name) in TypeScript: lowercase; replace each run of non a-z0-9 characters with one dash; trim leading/trailing dashes; limit to 40 characters and remove any trailing dash caused by cutting; return device when normalization is empty; throw only when the final exact name is api, www, or auth, never for substrings.",
    allowedFiles: ["label.ts"],
    testCommand,
    definitionOfDone: "All supplied tests pass without modifying label.test.mjs.",
    maxAttempts,
    escalationAdapter: null,
    escalationConfig: {},
  };
}

const results = [];
for (let i = 1; i <= runs; i++) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `epc-aider-label-${i}-`));
  try {
    await initRepo(dir);
    const testCommand = `${JSON.stringify(process.execPath)} --experimental-strip-types --test label.test.mjs`;
    const outcome = await runAiderLoop({
      contract: contract(testCommand),
      profile,
      command,
      env: process.env,
      taskFile: path.join(dir, ".epaperclip", "task.md"),
      settingsFile: path.join(dir, ".epaperclip", "model.yml"),
      writeFile: async (p, content) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, content, { mode: 0o600 }); },
      exec: (cmd, args, options) => proc(dir, cmd, args, options),
      timeoutMs: 15 * 60 * 1000,
    });
    results.push({ run: i, outcome: outcome.outcome, passed: outcome.passed, attempts: outcome.attemptsUsed, model: outcome.model, numCtx: outcome.numCtx, tokens: outcome.usage, tokensPerSecond: outcome.tokensPerSecond, wallTimeMs: outcome.wallTimeMs, testLog: outcome.testLog.slice(-4000) });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const forcedDir = await fs.mkdtemp(path.join(os.tmpdir(), "epc-aider-escalate-"));
let forced;
try {
  await initRepo(forcedDir);
  forced = await runAiderLoop({
    contract: {
      ...contract(`${JSON.stringify(process.execPath)} -e "process.exit(1)"`, 1),
      goal: "Forced escalation control: make the supplied impossible acceptance command pass without changing anything outside label.ts.",
    },
    profile,
    command,
    env: process.env,
    taskFile: path.join(forcedDir, ".epaperclip", "task.md"),
    settingsFile: path.join(forcedDir, ".epaperclip", "model.yml"),
    writeFile: async (p, content) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, content, { mode: 0o600 }); },
    exec: (cmd, args, options) => proc(forcedDir, cmd, args, options),
    timeoutMs: 15 * 60 * 1000,
  });
} finally {
  await fs.rm(forcedDir, { recursive: true, force: true });
}

const passed = results.filter((x) => x.passed).length;
const report = {
  device: os.hostname(),
  memoryProfile: profile,
  makeLabel: {
    runs,
    passed,
    passRate: runs ? passed / runs : 0,
    attempts: results.map((x) => x.attempts),
    results,
  },
  forcedEscalationControl: {
    outcome: forced.outcome,
    attempts: forced.attemptsUsed,
    model: forced.model,
    testLog: forced.testLog.slice(-2000),
  },
  note: "Peak Jetson shared-memory usage should be recorded alongside this run with tegrastats; this script does not fabricate GPU/shared-memory telemetry.",
};
console.log(JSON.stringify(report, null, 2));
if (forced.outcome !== "escalate") process.exitCode = 2;
