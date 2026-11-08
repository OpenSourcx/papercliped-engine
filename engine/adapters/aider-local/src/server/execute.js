import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  ensureAdapterExecutionTargetCommandResolvable,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeout,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { profileForMemory } from "../profile.js";
import { runAiderLoop } from "../runner.js";
import { escalationMarkdown, taskContract } from "../task.js";

const cleanRun = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "run";

function envStrings(v) {
  const out = {};
  for (const [k, value] of Object.entries(parseObject(v))) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof value === "string") out[k] = value;
  return out;
}

async function invokeStrongerAdapter(ctx, adapterType, adapterConfig, handoff) {
  const spec = adapterType === "claude_local" ? "@paperclipai/adapter-claude-local/server" : "@paperclipai/adapter-codex-local/server";
  const mod = await import(spec);
  if (typeof mod.execute !== "function") throw new Error(`Escalation adapter ${adapterType} has no execute() export.`);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "epaperclip-aider-escalation-"));
  const instructions = path.join(temp, "handoff.md");
  await fs.writeFile(instructions, handoff, { mode: 0o600 });
  try {
    const nextConfig = {
      ...adapterConfig,
      instructionsFilePath: instructions,
      promptTemplate: typeof adapterConfig.promptTemplate === "string" && adapterConfig.promptTemplate.trim()
        ? adapterConfig.promptTemplate
        : "Continue the escalated coding task from the injected instructions. Preserve the allowed-file scope and run the required test command before finishing.",
    };
    return await mod.execute({ ...ctx, config: nextConfig, context: { ...ctx.context, aiderEscalation: true } });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export async function execute(ctx) {
  const { runId, config, context, onLog } = ctx;
  const contract = taskContract(config, context);
  const command = asString(config.command, "epaperclip-aider");
  const executionTarget = readAdapterExecutionTarget({ executionTarget: ctx.executionTarget, legacyRemoteExecution: ctx.executionTransport?.remoteExecution });
  const workspace = parseObject(context.paperclipWorkspace);
  const localCwd = asString(workspace.cwd, "") || asString(config.cwd, "") || process.cwd();
  await ensureAbsoluteDirectory(localCwd, { createIfMissing: true });

  const timeout = resolveAdapterExecutionTargetTimeout(executionTarget, asNumber(config.timeoutSec, 900));
  const timeoutSec = timeout.timeoutSec || 900;
  const graceSec = asNumber(config.graceSec, 20);
  const env = Object.fromEntries(Object.entries(ensurePathInEnv({ ...process.env, ...buildPaperclipEnv(ctx.agent, ctx.agentIdentity), ...envStrings(config.env), PAPERCLIP_RUN_ID: runId })).filter(([, v]) => typeof v === "string"));

  let effectiveCwd = adapterExecutionTargetRemoteCwd(executionTarget, localCwd);
  let restoreRemoteWorkspace = null;
  let cleanupRunFiles = null;
  let runtimeTarget = executionTarget;
  try {
    if (executionTarget?.kind === "remote") {
      await onLog("stdout", "[aider] syncing the Paperclip workspace to the Worker Fabric node\n");
      const prepared = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "aider",
        timeoutSec,
        workspaceLocalDir: localCwd,
        detectCommand: command,
        onProgress: (line) => onLog("stdout", line),
        onRuntimeProgress: ctx.onRuntimeProgress,
        assets: [],
      });
      restoreRemoteWorkspace = () => prepared.restoreWorkspace((line) => onLog("stdout", line));
      effectiveCwd = prepared.workspaceRemoteDir ?? effectiveCwd;
      runtimeTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveCwd);
    }

    await ensureAdapterExecutionTargetCommandResolvable(command, runtimeTarget, localCwd, env, { timeoutSec });

    const runProcess = async (cmd, args, opts = {}) => {
      const runEnv = { ...env, ...(opts.env || {}) };
      const onChunk = async (stream, chunk) => {
        if (cmd === command || cmd === "sh") await onLog(stream, chunk);
      };
      if (runtimeTarget) {
        return runAdapterExecutionTargetProcess(runId, runtimeTarget, cmd, args, {
          cwd: localCwd,
          env: runEnv,
          stdin: opts.stdin,
          timeoutSec: Math.max(1, Math.ceil((opts.timeoutMs || timeoutSec * 1000) / 1000)),
          graceSec,
          onLog: onChunk,
        });
      }
      return runChildProcess(`${runId}-aider-${Date.now()}`, cmd, args, {
        cwd: effectiveCwd,
        env: runEnv,
        stdin: opts.stdin,
        timeoutSec: Math.max(1, Math.ceil((opts.timeoutMs || timeoutSec * 1000) / 1000)),
        graceSec,
        onLog: onChunk,
      });
    };

    const mem = await runProcess("sh", ["-lc", "awk '/MemTotal:/ { printf \"%d\\n\", $2/1024 }' /proc/meminfo"], { timeoutMs: 5000 });
    const memMb = Number(String(mem.stdout || "").trim());
    const profile = profileForMemory(memMb);
    await onLog("stdout", `[aider] ${profile.tier} profile: ${profile.model}, ${profile.editFormat}, num_ctx=${profile.numCtx}, maxFiles=${profile.maxEditableFiles}\n`);

    const slug = cleanRun(runId);
    const epcDir = path.posix.join("/tmp", "epaperclip-aider", slug);
    const taskFile = path.posix.join(epcDir, "task.md");
    const settingsFile = path.posix.join(epcDir, "model.yml");
    cleanupRunFiles = async () => { try { await runProcess("rm", ["-rf", "--", epcDir], { timeoutMs: 5000 }); } catch {} };
    const writeFile = async (file, content) => {
      const r = await runProcess("sh", ["-lc", 'umask 077; mkdir -p "$(dirname "$1")"; cat > "$1"', "epaperclip-aider", file], { stdin: content, timeoutMs: 5000 });
      if (r.exitCode !== 0) throw new Error(`Could not write Aider run file: ${(r.stderr || r.stdout || "unknown error").slice(-500)}`);
    };

    const outcome = await runAiderLoop({
      contract,
      profile,
      exec: runProcess,
      writeFile,
      taskFile,
      settingsFile,
      command,
      env,
      timeoutMs: timeoutSec * 1000,
      onAttempt: async (a) => onLog("stdout", `[aider] attempt ${a.attempt}: tests ${a.passed ? "passed" : "failed"}${a.scopeViolations.length ? `; reverted out-of-scope files ${a.scopeViolations.join(", ")}` : ""}\n`),
    });

    const baseResult = {
      exitCode: outcome.passed ? 0 : 2,
      signal: null,
      timedOut: false,
      usage: outcome.usage,
      provider: "ollama",
      model: outcome.model,
      resultJson: {
        adapter: "aider_local",
        outcome: outcome.outcome,
        diff: outcome.diff,
        testLog: outcome.testLog,
        passed: outcome.passed,
        attemptsUsed: outcome.attemptsUsed,
        model: outcome.model,
        aiderModel: outcome.aiderModel,
        editFormat: outcome.editFormat,
        numCtx: outcome.numCtx,
        mapTokens: outcome.mapTokens,
        tokens: outcome.usage,
        tokensPerSecond: outcome.tokensPerSecond,
        wallTimeMs: outcome.wallTimeMs,
        scopeViolations: outcome.scopeViolations,
      },
      summary: outcome.passed ? `Aider passed the required tests in ${outcome.attemptsUsed} attempt(s).` : `Aider exhausted ${outcome.attemptsUsed} attempt(s); escalation required.`,
    };

    if (outcome.passed || !contract.escalationAdapter) return baseResult;

    await onLog("stderr", `[aider] ESCALATE -> ${contract.escalationAdapter}; handing off the current diff and failing test log\n`);
    if (cleanupRunFiles) { await cleanupRunFiles(); cleanupRunFiles = null; }
    if (restoreRemoteWorkspace) {
      await restoreRemoteWorkspace();
      restoreRemoteWorkspace = null;
    }
    const handoff = escalationMarkdown(contract, outcome);
    const strong = await invokeStrongerAdapter(ctx, contract.escalationAdapter, contract.escalationConfig, handoff);
    return {
      ...strong,
      resultJson: {
        ...(strong.resultJson && typeof strong.resultJson === "object" ? strong.resultJson : {}),
        aider: { ...baseResult.resultJson, outcome: "escalated", escalationAdapter: contract.escalationAdapter },
      },
      summary: strong.summary || `Escalated from ${outcome.model} to ${contract.escalationAdapter}.`,
    };
  } catch (err) {
    await onLog("stderr", `[aider] ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: err instanceof Error ? err.message : String(err), resultJson: { adapter: "aider_local", outcome: "error" } };
  } finally {
    if (cleanupRunFiles) await cleanupRunFiles();
    if (restoreRemoteWorkspace) await restoreRemoteWorkspace();
  }
}
