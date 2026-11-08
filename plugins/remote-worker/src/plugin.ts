/**
 * The `remote-worker` sandbox provider: Paperclip's environment hooks implemented on persistent machines adopted into
 * the ePaperclip Worker Fabric. It is stateless: every decision (which worker, which workspace, capacity, identity)
 * lives in the host's Fabric hub, reached through its loopback control API with this organization's token.
 *
 *   acquire  -> reserve capacity on a compatible worker and prepare the agent's workspace on it
 *   resume   -> take a kept lease and workspace back
 *   execute  -> run the command in the workspace, streaming output as it arrives
 *   release  -> free the scheduler slot (kept workspace) or, without reuse, remove the run (like the Proxmox provider)
 *   stop     -> kill the lease's processes; the workspace stays
 *   destroy  -> remove the lease and its workspace. There is no call here, or in the control API, that removes a node.
 */
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginContext,
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentDiagnostic,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentTerminationReceipt,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";
import { checkConfig, parseConfig, type RemoteWorkerConfig } from "./config.js";
import { Control, ControlError, type Fetch } from "./control.js";
import { PROVIDER_KEY } from "./manifest.js";

export { PROVIDER_KEY };

export interface ProviderDeps {
  fetch?: Fetch;
}

const CAP = 4 * 1024 * 1024;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createRemoteWorkerPlugin(deps: ProviderDeps = {}) {
  let ctx: PluginContext | null = null;

  function runtimeConfig(raw: Record<string, unknown>): RemoteWorkerConfig {
    const c = parseConfig(raw);
    const { errors } = checkConfig(c);
    if (errors.length) throw new Error(`Invalid remote worker environment config: ${errors.join(" ")}`);
    return c;
  }
  const control = (c: RemoteWorkerConfig) => new Control({ url: c.controlUrl, token: c.controlToken!, fetch: deps.fetch });
  const gone = (e: unknown) => e instanceof ControlError && (e.status === 404 || e.status === 410);

  async function stopLease(params: PluginEnvironmentReleaseLeaseParams): Promise<PluginEnvironmentTerminationReceipt> {
    const id = params.providerLeaseId!;
    try {
      await control(runtimeConfig(params.config)).stop(id);
    } catch (e) {
      if (!gone(e)) throw e; // a failed stop must throw, never fall back to deleting
    }
    return { providerLeaseId: id, state: "stopped" };
  }
  async function destroyLease(params: PluginEnvironmentDestroyLeaseParams): Promise<PluginEnvironmentTerminationReceipt> {
    const id = params.providerLeaseId!;
    try {
      await control(runtimeConfig(params.config)).destroy(id);
    } catch (e) {
      if (!gone(e)) throw e;
    }
    return { providerLeaseId: id, state: "destroyed" };
  }

  return definePlugin({
    async setup(context) {
      ctx = context;
      context.logger.info("Remote worker provider ready");
    },
    async onHealth() {
      return { status: "ok", message: "Remote worker provider healthy" };
    },

    async onEnvironmentValidateConfig(params: PluginEnvironmentValidateConfigParams): Promise<PluginEnvironmentValidationResult> {
      const c = parseConfig(params.config);
      const { errors, warnings } = checkConfig(c);
      if (errors.length) return { ok: false, errors, warnings };
      return { ok: true, warnings, normalizedConfig: { ...c, controlToken: params.config.controlToken ?? null, workerId: c.workerId ?? "" } };
    },

    async onEnvironmentProbe(params: PluginEnvironmentProbeParams): Promise<PluginEnvironmentProbeResult> {
      const c = parseConfig(params.config);
      const diagnostics: PluginEnvironmentDiagnostic[] = [];
      const { errors, warnings } = checkConfig(c);
      for (const e of errors) diagnostics.push({ severity: "error", code: "config", message: e });
      for (const w of warnings) diagnostics.push({ severity: "warning", code: "config", message: w });
      const metadata: Record<string, unknown> = { provider: PROVIDER_KEY, workerId: c.workerId };
      if (errors.length) return { ok: false, summary: "Remote worker environment config is incomplete.", diagnostics, metadata };
      try {
        const r = await control(c).probe({ companyId: params.companyId, workerId: c.workerId, requirements: c.requirements, needsInference: c.needsInference });
        for (const w of r.candidates) diagnostics.push({ severity: w.reasons.length ? "warning" : "info", code: "worker", message: `${w.name}: ${w.online ? "online" : "offline"}${w.reasons.length ? ` (${w.reasons.join("; ")})` : ", ready"}` });
        metadata.candidates = r.candidates.length;
        if (!r.ok) diagnostics.push({ severity: "error", code: "no_worker", message: r.summary });
        return { ok: r.ok, summary: r.summary, diagnostics, metadata };
      } catch (e) {
        const rejected = e instanceof ControlError && e.status === 401;
        diagnostics.push({ severity: "error", code: "control", message: rejected ? "The Worker Fabric rejected the control token." : msg(e) });
        return { ok: false, summary: rejected ? "The Worker Fabric rejected the control token." : "The Worker Fabric is not reachable.", diagnostics, metadata };
      }
    },

    async onEnvironmentAcquireLease(params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease> {
      const c = runtimeConfig(params.config);
      const lease = await control(c).acquire(
        {
          companyId: params.companyId,
          agentId: params.agentId ?? `env-${params.environmentId}`,
          runId: params.runId,
          environmentId: params.environmentId,
          workerId: c.workerId,
          requirements: c.requirements,
          needsInference: c.needsInference,
          reuse: c.reuseLease,
          // A kept workspace is named by the execution workspace; otherwise each run has its own.
          workspaceKey: c.reuseLease ? params.executionWorkspaceId ?? "default" : params.runId,
        },
        c.timeoutMs,
      );
      ctx?.logger.info("Remote worker lease ready", { worker: lease.workerName, lease: lease.leaseId });
      return { providerLeaseId: lease.leaseId, metadata: { provider: PROVIDER_KEY, workerId: lease.workerId, workerName: lease.workerName, remoteCwd: lease.workspace } };
    },

    async onEnvironmentResumeLease(params: PluginEnvironmentResumeLeaseParams): Promise<PluginEnvironmentLease> {
      const c = runtimeConfig(params.config);
      try {
        const l = await control(c).resume(params.providerLeaseId);
        return { providerLeaseId: l.leaseId, metadata: { ...(params.leaseMetadata ?? {}), provider: PROVIDER_KEY, workerId: l.workerId, remoteCwd: l.workspace } };
      } catch (e) {
        // Gone, or the worker is busy or away: let Paperclip start a fresh lease.
        if (gone(e) || (e instanceof ControlError && (e.code === "offline" || e.code === "no_capacity"))) return { providerLeaseId: null, metadata: { expired: true } };
        throw e;
      }
    },

    async onEnvironmentReleaseLease(params: PluginEnvironmentReleaseLeaseParams): Promise<PluginEnvironmentTerminationReceipt | void> {
      if (!params.providerLeaseId) return;
      if (params.resourceDisposition === "stop_and_retain") return await stopLease(params);
      const c = parseConfig(params.config);
      if (c.reuseLease) {
        // Free the slot; the workspace stays for the next run.
        try {
          await control(runtimeConfig(params.config)).release(params.providerLeaseId);
        } catch (e) {
          if (!gone(e)) throw e;
        }
        return;
      }
      return await destroyLease(params);
    },

    async onEnvironmentStopLease(params: PluginEnvironmentReleaseLeaseParams): Promise<PluginEnvironmentTerminationReceipt> {
      return await stopLease(params);
    },

    async onEnvironmentDestroyLease(params: PluginEnvironmentDestroyLeaseParams): Promise<PluginEnvironmentTerminationReceipt | void> {
      if (!params.providerLeaseId) return;
      return await destroyLease(params);
    },

    async onEnvironmentRealizeWorkspace(params: PluginEnvironmentRealizeWorkspaceParams): Promise<PluginEnvironmentRealizeWorkspaceResult> {
      const c = runtimeConfig(params.config);
      const id = params.lease.providerLeaseId;
      if (!id) throw new Error("No worker lease is attached to this run.");
      const meta = (params.workspace.metadata ?? {}) as Record<string, unknown>;
      const repo = typeof meta.repoUrl === "string" ? meta.repoUrl : undefined;
      const cwd = (await control(c).workspace(id, { mode: repo ? "worktree" : "directory", repo, ref: typeof meta.ref === "string" ? meta.ref : undefined })).cwd;
      return { cwd, metadata: { provider: PROVIDER_KEY, remoteCwd: cwd } };
    },

    async onEnvironmentExecute(params: PluginEnvironmentExecuteParams): Promise<PluginEnvironmentExecuteResult> {
      const id = params.lease.providerLeaseId;
      if (!id) return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "No worker lease is attached to this run." };
      const c = runtimeConfig(params.config);
      let stdout = "";
      let stderr = "";
      const execution = ctx?.execution;
      const limit = params.timeoutMs ?? c.timeoutMs;
      try {
        const r = await control(c).exec(
          id,
          { command: params.command, args: params.args ?? [], cwd: params.cwd ?? (params.lease.metadata?.remoteCwd as string | undefined), env: params.env, stdin: params.stdin, timeoutMs: limit },
          ({ stream, data }) => {
            execution?.log(stream, data);
            if (stream === "stdout") stdout = (stdout + data).slice(-CAP);
            else stderr = (stderr + data).slice(-CAP);
          },
          limit + 30_000,
        );
        return { exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, stdout, stderr, metadata: { provider: PROVIDER_KEY, workerId: params.lease.metadata?.workerId } };
      } catch (e) {
        return { exitCode: 1, signal: null, timedOut: false, stdout, stderr: `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}[remote-worker] ${msg(e)}\n` };
      }
    },
  });
}

const plugin = createRemoteWorkerPlugin();
export default plugin;
