import {
  adapterExecutionTargetRemoteCwd,
  readAdapterExecutionTarget,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { asString, runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { profileForMemory } from "../profile.js";

export async function testEnvironment(ctx) {
  const checks = [];
  const command = asString(ctx.config.command, "epaperclip-aider");
  const target = readAdapterExecutionTarget({ executionTarget: ctx.executionTarget, legacyRemoteExecution: ctx.executionTransport?.remoteExecution });
  const cwd = adapterExecutionTargetRemoteCwd(target, asString(ctx.config.cwd, process.cwd()));
  const run = async (cmd, args) => target
    ? runAdapterExecutionTargetProcess(`aider-test-${Date.now()}`, target, cmd, args, { cwd, env: process.env, timeoutSec: 10, graceSec: 2, onLog: async () => {} })
    : runChildProcess(`aider-test-${Date.now()}`, cmd, args, { cwd, env: Object.fromEntries(Object.entries(process.env).filter((e) => typeof e[1] === "string")), timeoutSec: 10, graceSec: 2, onLog: async () => {} });
  try {
    const ver = await run(command, ["--version"]);
    if (ver.exitCode !== 0) checks.push({ level: "error", code: "aider_missing", message: "epaperclip-aider is not ready on this execution target.", hint: "Run deploy/worker/install-aider.sh on the worker." });
    else checks.push({ level: "info", code: "aider_ready", message: String(ver.stdout || ver.stderr || "Aider ready").trim().slice(0, 200) });
    const mem = await run("sh", ["-lc", "awk '/MemTotal:/ { printf \"%d\\n\", $2/1024 }' /proc/meminfo"]);
    const profile = profileForMemory(Number(String(mem.stdout || "").trim()));
    checks.push({ level: "info", code: "small_device_profile", message: `${profile.tier}: ${profile.model}, ${profile.editFormat}, num_ctx=${profile.numCtx}, max ${profile.maxEditableFiles} editable file(s)` });
  } catch (e) {
    checks.push({ level: "error", code: "aider_probe_failed", message: e instanceof Error ? e.message : String(e) });
  }
  return { adapterType: ctx.adapterType, status: checks.some((c) => c.level === "error") ? "fail" : "pass", checks, testedAt: new Date().toISOString() };
}
