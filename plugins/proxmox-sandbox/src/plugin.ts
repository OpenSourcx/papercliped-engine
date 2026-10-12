/**
 * The `proxmox` sandbox provider: Paperclip's environment hooks implemented on
 * Proxmox VE LXC containers.
 *
 * Lifecycle of a lease:
 *   acquire  → next free vmid, full clone of the template (or create from a CT
 *              template volid) into the configured pool, tags, start, wait for
 *              an address, wait for SSH, record the host key, make the workspace
 *   execute  → one `ssh` call per command
 *   release  → shut down and delete (purge), unless leases are reused
 *   resume   → start again if stopped; report "expired" if the container is gone
 *   destroy  → always delete; a container that is already gone is success
 *   stop     → shut down and keep the container and its files
 *
 * The Proxmox API and SSH layers are injected (see ProviderDeps), so the whole
 * lifecycle runs in tests against a fake Proxmox server and a local shell.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
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
import {
  DEFAULT_DISK_GB,
  checkConfig,
  isSecretRef,
  parseConfig,
  parseTemplateRef,
  type ProxmoxDriverConfig,
  type TemplateRef,
} from "./config.js";
import { ProxmoxApiError, ProxmoxClient, defaultSleep, type HttpTransport, type LxcInterface } from "./proxmox-api.js";
import { SshKeyError, derivePublicKey } from "./ssh-keys.js";
import {
  DETECT_CONTEXT_SCRIPT,
  buildExecScript,
  buildKillScript,
  createSshRunner,
  mkdirScript,
  shCommand,
  type SshResult,
  type SshRunner,
  type SshTarget,
} from "./ssh.js";

export const PROVIDER_KEY = "proxmox";
/** Tag on every container this provider creates; nothing without it is ever stopped or deleted. */
export const OWNER_TAG = "epaperclip";
const WORKSPACE_DIRNAME = "paperclip-workspace";
const SHUTDOWN_TIMEOUT_S = 30;

export interface ProviderDeps {
  /** HTTPS transport for the Proxmox API (default: node:https). */
  transport?: HttpTransport;
  /** Runs one command in a container (default: the system ssh client). */
  ssh?: SshRunner;
  sleep?: (ms: number) => Promise<void>;
  /** Grace period between SIGTERM and SIGKILL when a command times out. */
  killGraceSeconds?: number;
}

interface LeaseRef {
  node: string;
  vmid: number;
}

/** `providerLeaseId` is `<node>/<vmid>`, so cleanup works even after the environment config changes. */
export function parseLeaseId(value: string | null | undefined): LeaseRef | null {
  if (!value) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)\/(\d+)$/.exec(value);
  if (!match) return null;
  return { node: match[1]!, vmid: Number(match[2]) };
}

/** Proxmox tags allow `[a-z0-9_][a-z0-9_+.-]*`. */
export function sanitizeTag(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_+.-]+/g, "-")
    .replace(/^[^a-z0-9_]+/, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64)
    .replace(/[-.+]+$/, "");
  return cleaned || "unknown";
}

export function buildTags(companyId: string, runId: string): string {
  return [OWNER_TAG, sanitizeTag(`company-${companyId}`), sanitizeTag(`run-${runId}`)].join(";");
}

function parseTags(value: unknown): string[] {
  return typeof value === "string" ? value.split(/[;, ]+/).map((tag) => tag.trim().toLowerCase()).filter(Boolean) : [];
}

/**
 * Whether a container belongs to this provider and this company. Before
 * stopping or deleting anything the provider checks this, so a vmid that was
 * reused by someone else after our container was deleted is never touched.
 */
export function isOwnedContainer(config: Record<string, unknown>, companyId: string | undefined): boolean {
  const tags = parseTags(config.tags);
  if (!tags.includes(OWNER_TAG)) return false;
  if (companyId && !tags.includes(sanitizeTag(`company-${companyId}`))) return false;
  return Number(config.template ?? 0) !== 1;
}

/**
 * Template safety checks: an unprivileged container with no host bind mounts,
 * no device passthrough and no raw LXC settings. Clones inherit all of these.
 */
export function assessTemplateConfig(template: Record<string, unknown>, allowPrivileged: boolean): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (Number(template.template ?? 0) !== 1) {
    warnings.push("The template vmid is a regular container, not a template; it must stay stopped to be cloned.");
  }
  if (Number(template.unprivileged ?? 0) !== 1) {
    if (allowPrivileged) warnings.push("The template is a privileged container, so every clone is privileged.");
    else errors.push("The template is a privileged container. Clones would be privileged too; rebuild it unprivileged (build-template.sh does).");
  }
  for (const [key, value] of Object.entries(template)) {
    if (/^mp\d+$/.test(key) && typeof value === "string") {
      const source = value.split(",")[0] ?? "";
      if (source.startsWith("/")) errors.push(`The template bind-mounts a host path (${key}: ${source}). Containers must not see host files.`);
    }
    if (/^dev\d+$/.test(key)) errors.push(`The template passes a host device through (${key}). Remove it.`);
    if (key === "lxc") errors.push("The template has raw lxc.* settings. Remove them; they can weaken isolation.");
  }
  return { errors, warnings };
}

export function containerHostname(config: Pick<ProxmoxDriverConfig, "namePrefix">, vmid: number): string {
  return `${config.namePrefix}-${vmid}`.slice(0, 63);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return error instanceof ProxmoxApiError && error.isNotFound;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** First IPv4 address of the container's non-loopback interfaces, without the prefix length. */
export function pickIpv4(interfaces: LxcInterface[] | null): string | null {
  for (const iface of interfaces ?? []) {
    if (!iface || iface.name === "lo") continue;
    const candidates = [iface.inet, ...(iface["ip-addresses"] ?? []).filter((a) => a["ip-address-type"] === "inet").map((a) => a["ip-address"])];
    for (const candidate of candidates) {
      const ip = candidate?.split("/")[0]?.trim();
      if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ip.startsWith("127.") && !ip.startsWith("169.254.")) return ip;
    }
  }
  return null;
}

/** A static `ip=` in the container's net0, used when the interfaces call has nothing. */
function staticIpFromConfig(config: Record<string, unknown>): string | null {
  const net0 = str(config.net0);
  const match = net0 ? /(?:^|,)ip=(\d{1,3}(?:\.\d{1,3}){3})(?:\/\d+)?(?:,|$)/.exec(net0) : null;
  return match ? match[1]! : null;
}

export function createProxmoxSandboxPlugin(deps: ProviderDeps = {}) {
  const ssh = deps.ssh ?? createSshRunner();
  const sleep = deps.sleep ?? defaultSleep;
  let ctx: PluginContext | null = null;

  const log = (level: "info" | "warn", message: string, meta?: Record<string, unknown>) => {
    ctx?.logger[level](message, meta);
  };

  /** Parses and checks config for a lifecycle call; refuses to act on a config validation would reject. */
  function runtimeConfig(raw: Record<string, unknown>): ProxmoxDriverConfig {
    const config = parseConfig(raw);
    const { errors } = checkConfig(config);
    if (errors.length > 0) throw new Error(`Invalid Proxmox environment config: ${errors.join(" ")}`);
    return config;
  }

  /**
   * Stopping and deleting need only the API settings: the node and vmid come
   * from the lease id. A container must stay removable even after the rest of
   * the environment config has changed or become invalid.
   */
  function cleanupConfig(raw: Record<string, unknown>): ProxmoxDriverConfig {
    const config = parseConfig(raw);
    const apiErrors = checkConfig(config).errors.filter((e) => /^(apiUrl|apiTokenId|apiTokenSecret|timeoutMs)/.test(e));
    if (apiErrors.length > 0) throw new Error(`Invalid Proxmox API settings: ${apiErrors.join(" ")}`);
    return config;
  }

  function client(config: ProxmoxDriverConfig): ProxmoxClient {
    return new ProxmoxClient({
      apiUrl: config.apiUrl,
      tokenId: config.apiTokenId!,
      tokenSecret: config.apiTokenSecret!,
      caCert: config.caCert,
      allowInsecureTls: config.allowInsecureTls,
      transport: deps.transport,
      sleep,
    });
  }

  function sshTarget(config: ProxmoxDriverConfig, ref: LeaseRef, ip: string, knownHosts: string | null): SshTarget {
    return {
      host: ip,
      port: config.sshPort,
      user: config.sshUser,
      privateKey: config.sshPrivateKey!,
      hostKeyAlias: `epaperclip-${ref.node}-${ref.vmid}`,
      knownHosts,
    };
  }

  async function waitForStatus(api: ProxmoxClient, ref: LeaseRef, wanted: "running" | "stopped", deadline: number): Promise<void> {
    let delay = 500;
    for (;;) {
      const status = await api.lxcStatus(ref.node, ref.vmid);
      if (status.status === wanted) return;
      if (Date.now() + delay > deadline) throw new Error(`Container ${ref.vmid} did not reach "${wanted}" (still "${status.status}").`);
      await sleep(delay);
      delay = Math.min(delay * 2, 2_000);
    }
  }

  async function start(api: ProxmoxClient, ref: LeaseRef, deadline: number): Promise<void> {
    const upid = await api.lxcPower(ref.node, ref.vmid, "start");
    await api.waitForTask(ref.node, upid, `start of CT ${ref.vmid}`, deadline);
    await waitForStatus(api, ref, "running", deadline);
  }

  async function discoverIp(api: ProxmoxClient, ref: LeaseRef, deadline: number): Promise<string> {
    let delay = 500;
    for (;;) {
      try {
        const ip = pickIpv4(await api.lxcInterfaces(ref.node, ref.vmid));
        if (ip) return ip;
      } catch (error) {
        // Older Proxmox releases have no interfaces call; the config fallback below still works for static addresses.
        if (!(error instanceof ProxmoxApiError) || error.status === 401 || error.status === 403) throw error;
      }
      const fallback = staticIpFromConfig(await api.lxcConfig(ref.node, ref.vmid));
      if (fallback) return fallback;
      if (Date.now() + delay > deadline) {
        throw new Error(`Container ${ref.vmid} got no IPv4 address. Check that DHCP serves the bridge, or set a static ip= on the template's net0.`);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 3_000);
    }
  }

  /**
   * Connects until sshd answers, with backoff, and returns the home directory,
   * the shell to use, and the container's known_hosts.
   */
  async function waitForSsh(
    target: SshTarget,
    deadline: number,
  ): Promise<{ homeDir: string; shellCommand: "bash" | "sh"; knownHosts: string | null }> {
    let delay = 1_000;
    let last: SshResult | Error | null = null;
    for (;;) {
      try {
        const result = await ssh({
          target,
          command: shCommand(DETECT_CONTEXT_SCRIPT),
          timeoutMs: Math.max(1_000, Math.min(30_000, deadline - Date.now())),
          acceptNewHostKey: !target.knownHosts,
        });
        if (!result.timedOut && result.exitCode === 0) {
          const [home, shell] = result.stdout.split(/\r?\n/);
          return {
            homeDir: home?.trim() || "/root",
            shellCommand: shell?.trim() === "bash" ? "bash" : "sh",
            knownHosts: result.knownHosts ?? target.knownHosts,
          };
        }
        last = result;
        if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(result.stderr)) {
          throw new Error(`SSH host key of ${target.host} does not match the one recorded for this container. Refusing to connect.`);
        }
      } catch (error) {
        if (error instanceof Error && /Refusing to connect/.test(error.message)) throw error;
        last = error instanceof Error ? error : new Error(String(error));
      }
      if (Date.now() + delay > deadline) {
        const detail =
          last instanceof Error
            ? last.message
            : last?.timedOut
              ? "the connection attempt timed out (is the address reachable from the engine host?)"
              : last?.stderr.trim() || last?.stdout.trim() || `exit ${String(last?.exitCode)}`;
        throw new Error(`SSH to ${target.user}@${target.host}:${target.port} did not become ready: ${detail}`);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 5_000);
    }
  }

  async function runChecked(target: SshTarget, script: string, action: string, timeoutMs = 60_000): Promise<void> {
    const result = await ssh({ target, command: shCommand(script), timeoutMs });
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(`Failed to ${action} in container ${target.hostKeyAlias}: ${result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`}`);
    }
  }

  /** Brings a started container to a usable lease: address, SSH, workspace. */
  async function readyLease(input: {
    api: ProxmoxClient;
    config: ProxmoxDriverConfig;
    ref: LeaseRef;
    deadline: number;
    requestedCwd: string | null;
    knownHosts: string | null;
    resumed: boolean;
  }): Promise<PluginEnvironmentLease> {
    const { api, config, ref, deadline } = input;
    const ip = await discoverIp(api, ref, deadline);
    const remote = await waitForSsh(sshTarget(config, ref, ip, input.knownHosts), deadline);
    const target = sshTarget(config, ref, ip, remote.knownHosts);
    const remoteCwd = input.requestedCwd || path.posix.join(remote.homeDir, WORKSPACE_DIRNAME);
    await runChecked(target, mkdirScript(remoteCwd), "create the workspace");
    return {
      providerLeaseId: `${ref.node}/${ref.vmid}`,
      metadata: {
        provider: PROVIDER_KEY,
        node: ref.node,
        vmid: ref.vmid,
        ip,
        remoteCwd,
        shellCommand: remote.shellCommand,
        sshUser: config.sshUser,
        sshPort: config.sshPort,
        hostKeyAlias: target.hostKeyAlias,
        knownHosts: remote.knownHosts,
        timeoutMs: config.timeoutMs,
        reuseLease: config.reuseLease,
        resumedLease: input.resumed,
      },
    };
  }

  /** Creates the container (clone or create) and returns its vmid. Retries if another caller took the same vmid. */
  async function createContainer(
    api: ProxmoxClient,
    config: ProxmoxDriverConfig,
    template: TemplateRef,
    params: PluginEnvironmentAcquireLeaseParams,
    deadline: number,
  ): Promise<number> {
    const node = config.node!;
    const tags = buildTags(params.companyId, params.runId);
    const description = `Paperclip sandbox. Company ${params.companyId}, environment ${params.environmentId}, run ${params.runId}.`;
    const net0 = `name=eth0,bridge=${config.bridge},ip=dhcp`;
    for (let attempt = 1; ; attempt += 1) {
      const vmid = await api.nextId();
      const hostname = containerHostname(config, vmid);
      try {
        let upid: string;
        if (template.kind === "vmid") {
          upid = await api.cloneLxc(node, template.vmid, {
            newid: vmid,
            full: 1,
            pool: config.pool,
            storage: config.storage ?? undefined,
            hostname,
            description,
          });
        } else {
          upid = await api.createLxc(node, {
            vmid,
            ostemplate: template.volid,
            hostname,
            pool: config.pool,
            storage: config.storage,
            rootfs: `${config.storage}:${config.diskGb ?? DEFAULT_DISK_GB}`,
            cores: config.cores,
            memory: config.memoryMb,
            swap: 0,
            net0,
            unprivileged: config.unprivileged ? 1 : 0,
            "ssh-public-keys": `${derivePublicKey(config.sshPrivateKey!)} epaperclip-proxmox-sandbox`,
            tags,
            description,
            onboot: 0,
            start: 0,
          });
        }
        log("info", "Creating Proxmox container", { node, vmid, mode: template.kind === "vmid" ? "clone" : "create" });
        try {
          await api.waitForTask(node, upid, template.kind === "vmid" ? `clone of CT ${template.vmid} to ${vmid}` : `create of CT ${vmid}`, deadline);
        } catch (error) {
          // The task may have left a half-made container behind; remove it before reporting.
          await destroyQuietly(api, config, { node, vmid }, params.companyId, deadline);
          throw error;
        }
        return vmid;
      } catch (error) {
        const taken = error instanceof ProxmoxApiError && /already exists/i.test(error.detail);
        if (taken && attempt < 3) continue;
        throw error;
      }
    }
  }

  async function shutdown(api: ProxmoxClient, ref: LeaseRef, hard: boolean, deadline: number): Promise<void> {
    const upid = hard
      ? await api.lxcPower(ref.node, ref.vmid, "stop")
      : await api.lxcPower(ref.node, ref.vmid, "shutdown", { timeout: SHUTDOWN_TIMEOUT_S, forceStop: 1 });
    await api.waitForTask(ref.node, upid, `${hard ? "stop" : "shutdown"} of CT ${ref.vmid}`, deadline);
    await waitForStatus(api, ref, "stopped", deadline);
  }

  /**
   * Stops and deletes a container this provider owns. Returns false when
   * there was nothing (of ours) to delete.
   */
  async function destroyContainer(
    api: ProxmoxClient,
    ref: LeaseRef,
    companyId: string | undefined,
    hard: boolean,
    deadline: number,
    options: { createdHostname?: string } = {},
  ): Promise<boolean> {
    let ctConfig: Record<string, unknown>;
    try {
      ctConfig = await api.lxcConfig(ref.node, ref.vmid);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    if (Number(ctConfig.template ?? 0) === 1) {
      log("warn", "Refusing to delete a template", { node: ref.node, vmid: ref.vmid });
      return false;
    }
    // A container this acquire just created may not carry its tags yet (a clone gets them after the
    // copy); it is recognised by the hostname the create call gave it.
    const justCreated = options.createdHostname !== undefined && ctConfig.hostname === options.createdHostname;
    if (!justCreated && !isOwnedContainer(ctConfig, companyId)) {
      // Our container is gone and the vmid now belongs to something else: leave it alone.
      log("warn", "Container is not one of ours; not deleting it", { node: ref.node, vmid: ref.vmid });
      return false;
    }
    try {
      const status = await api.lxcStatus(ref.node, ref.vmid);
      if (status.status === "running") await shutdown(api, ref, hard, deadline);
      const upid = await api.destroyLxc(ref.node, ref.vmid, { purge: 1, "destroy-unreferenced-disks": 1 });
      await api.waitForTask(ref.node, upid, `delete of CT ${ref.vmid}`, deadline);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    log("info", "Deleted Proxmox container", { node: ref.node, vmid: ref.vmid });
    return true;
  }

  /** Removes a container that this acquire call created and could not finish. */
  async function destroyQuietly(api: ProxmoxClient, config: ProxmoxDriverConfig, ref: LeaseRef, companyId: string, deadline: number): Promise<void> {
    try {
      await destroyContainer(api, ref, companyId, true, Math.max(deadline, Date.now() + 120_000), {
        createdHostname: containerHostname(config, ref.vmid),
      });
    } catch (error) {
      log("warn", "Cleanup of a failed container did not finish", { vmid: ref.vmid, error: errorMessage(error) });
    }
  }

  async function stopLease(params: PluginEnvironmentReleaseLeaseParams): Promise<PluginEnvironmentTerminationReceipt> {
    const ref = parseLeaseId(params.providerLeaseId);
    if (!ref) throw new Error(`Not a Proxmox lease id: ${String(params.providerLeaseId)}`);
    const config = cleanupConfig(params.config);
    const api = client(config);
    const deadline = Date.now() + config.timeoutMs;
    let ctConfig: Record<string, unknown>;
    try {
      ctConfig = await api.lxcConfig(ref.node, ref.vmid);
    } catch (error) {
      if (isNotFound(error)) throw new Error(`Container ${ref.vmid} no longer exists; there is nothing to stop and keep.`);
      throw error;
    }
    if (!isOwnedContainer(ctConfig, params.companyId)) {
      throw new Error(`Container ${ref.vmid} is not a container this provider created; refusing to stop it.`);
    }
    const status = await api.lxcStatus(ref.node, ref.vmid);
    if (status.status !== "stopped") await shutdown(api, ref, params.cancelActiveWork === true, deadline);
    // Confirm, never assume: the receipt means execution has ended.
    const after = await api.lxcStatus(ref.node, ref.vmid);
    if (after.status !== "stopped") throw new Error(`Container ${ref.vmid} did not stop (status "${after.status}").`);
    return { providerLeaseId: params.providerLeaseId!, state: "stopped" };
  }

  async function destroyLease(params: PluginEnvironmentDestroyLeaseParams): Promise<PluginEnvironmentTerminationReceipt | void> {
    const ref = parseLeaseId(params.providerLeaseId);
    if (!params.providerLeaseId) return;
    if (!ref) throw new Error(`Not a Proxmox lease id: ${params.providerLeaseId}`);
    const config = cleanupConfig(params.config);
    const api = client(config);
    await destroyContainer(api, ref, params.companyId, params.cancelActiveWork === true, Date.now() + config.timeoutMs);
    return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
  }

  return definePlugin({
    async setup(context) {
      ctx = context;
      context.logger.info("Proxmox sandbox provider ready");
    },

    async onHealth() {
      return { status: "ok", message: "Proxmox sandbox provider healthy" };
    },

    async onEnvironmentValidateConfig(params: PluginEnvironmentValidateConfigParams): Promise<PluginEnvironmentValidationResult> {
      const config = parseConfig(params.config);
      const { errors, warnings } = checkConfig(config);
      if (config.sshPrivateKey && !isSecretRef(config.sshPrivateKey) && !errors.some((e) => e.startsWith("sshPrivateKey"))) {
        try {
          derivePublicKey(config.sshPrivateKey);
        } catch (error) {
          errors.push(error instanceof SshKeyError ? error.message : `sshPrivateKey could not be read: ${errorMessage(error)}`);
        }
      }
      if (errors.length > 0) return { ok: false, errors, warnings };
      const { apiTokenIdConflict: _conflict, ...normalized } = config;
      return {
        ok: true,
        warnings,
        normalizedConfig: {
          ...normalized,
          // Secret fields go back exactly as given: Paperclip owns how they are stored
          // (a bare UUID there means "saved secret id", so never rewrite them into one).
          apiTokenId: params.config.apiTokenId ?? null,
          apiTokenSecret: params.config.apiTokenSecret ?? null,
          sshPrivateKey: params.config.sshPrivateKey ?? null,
        },
      };
    },

    async onEnvironmentProbe(params: PluginEnvironmentProbeParams): Promise<PluginEnvironmentProbeResult> {
      const config = parseConfig(params.config);
      const diagnostics: PluginEnvironmentDiagnostic[] = [];
      const add = (severity: PluginEnvironmentDiagnostic["severity"], code: string, message: string) =>
        diagnostics.push({ severity, code, message });
      const { errors, warnings } = checkConfig(config);
      for (const error of errors) add("error", "config", error);
      const metadata: Record<string, unknown> = { provider: PROVIDER_KEY, node: config.node, pool: config.pool, template: config.template };
      if (errors.length > 0) {
        return { ok: false, summary: "Proxmox environment config is incomplete.", diagnostics, metadata };
      }
      for (const warning of warnings) add("warning", "config", warning);

      const api = client(config);
      const node = config.node!;
      const parts: string[] = [];
      try {
        const version = await api.version();
        metadata.proxmoxVersion = version.version;
        parts.push(`Proxmox VE ${version.version}`);
        add("info", "api", `Connected to Proxmox VE ${version.version} at ${config.apiUrl}.`);
      } catch (error) {
        const rejected = error instanceof ProxmoxApiError && error.status === 401;
        add("error", "api", rejected ? `Proxmox rejected the API token: ${errorMessage(error)}` : `Cannot reach the Proxmox API: ${errorMessage(error)}`);
        metadata.error = errorMessage(error);
        return {
          ok: false,
          summary: rejected ? `Proxmox at ${config.apiUrl} rejected the API token.` : `Proxmox API at ${config.apiUrl} is not reachable.`,
          diagnostics,
          metadata,
        };
      }

      try {
        const status = await api.nodeStatus(node);
        metadata.nodeUptime = status.uptime;
        add("info", "node", `Node ${node} is online.`);
      } catch (error) {
        if (error instanceof ProxmoxApiError && error.status === 403) {
          add("warning", "node", `The token may not read node ${node}'s status (Sys.Audit on /nodes/${node}); continuing.`);
        } else {
          add("error", "node", `Node ${node}: ${errorMessage(error)}`);
        }
      }

      const template = parseTemplateRef(config.template)!;
      try {
        if (template.kind === "vmid") {
          const tplConfig = await api.lxcConfig(node, template.vmid);
          const assessment = assessTemplateConfig(tplConfig, config.allowPrivileged);
          for (const e of assessment.errors) add("error", "template", e);
          for (const w of assessment.warnings) add("warning", "template", w);
          if (assessment.errors.length === 0) add("info", "template", `Template ${template.vmid} exists and is unprivileged.`);
        } else {
          await api.storageVolume(node, template.storage, template.volid);
          add("info", "template", `CT template ${template.volid} exists.`);
        }
      } catch (error) {
        add("error", "template", `Template ${config.template} on node ${node}: ${errorMessage(error)}`);
      }

      try {
        await api.pool(config.pool!);
        add("info", "pool", `Pool ${config.pool} exists.`);
      } catch (error) {
        add("error", "pool", `Pool ${config.pool}: ${errorMessage(error)} (create it with pveum pool add, and grant the token rights on /pool/${config.pool}).`);
      }

      if (config.storage) {
        try {
          const storage = await api.storageStatus(node, config.storage);
          if (storage.active === 0 || storage.active === false) add("error", "storage", `Storage ${config.storage} is not active on ${node}.`);
          else add("info", "storage", `Storage ${config.storage} is available.`);
        } catch (error) {
          add("error", "storage", `Storage ${config.storage}: ${errorMessage(error)}`);
        }
      }

      if (!isSecretRef(config.sshPrivateKey!)) {
        try {
          metadata.sshPublicKey = derivePublicKey(config.sshPrivateKey!);
        } catch (error) {
          add("error", "ssh", errorMessage(error));
        }
      }

      const failed = diagnostics.filter((d) => d.severity === "error");
      const ok = failed.length === 0;
      parts.push(`node ${node}`, `template ${config.template}`, `pool ${config.pool}`);
      return {
        ok,
        summary: ok ? `Ready: ${parts.join(", ")}.` : `Proxmox environment is not ready: ${failed.map((d) => d.message).join(" ")}`,
        diagnostics,
        metadata,
      };
    },

    async onEnvironmentAcquireLease(params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease> {
      const config = runtimeConfig(params.config);
      const api = client(config);
      const deadline = Date.now() + config.timeoutMs;
      const template = parseTemplateRef(config.template)!;
      derivePublicKey(config.sshPrivateKey!); // fail before creating anything if the key is unusable

      if (template.kind === "vmid") {
        const assessment = assessTemplateConfig(await api.lxcConfig(config.node!, template.vmid), config.allowPrivileged);
        if (assessment.errors.length > 0) throw new Error(`Template ${template.vmid} is not safe to clone: ${assessment.errors.join(" ")}`);
      }

      const vmid = await createContainer(api, config, template, params, deadline);
      const ref: LeaseRef = { node: config.node!, vmid };
      try {
        if (template.kind === "vmid") {
          // Clones keep the template's settings; apply this environment's size, network and tags.
          await api.updateLxcConfig(ref.node, vmid, {
            cores: config.cores,
            memory: config.memoryMb,
            net0: `name=eth0,bridge=${config.bridge},ip=dhcp`,
            tags: buildTags(params.companyId, params.runId),
          });
          if (config.diskGb != null) {
            try {
              const upid = await api.resizeLxc(ref.node, vmid, "rootfs", `${config.diskGb}G`);
              if (typeof upid === "string" && upid.startsWith("UPID:")) await api.waitForTask(ref.node, upid, `resize of CT ${vmid}`, deadline);
            } catch (error) {
              // Proxmox only grows disks; a template disk already larger than diskGb is fine.
              if (!/shrink|smaller/i.test(errorMessage(error))) throw error;
            }
          }
        }
        await start(api, ref, deadline);
        const lease = await readyLease({
          api,
          config,
          ref,
          deadline,
          requestedCwd: str(params.requestedCwd),
          knownHosts: null,
          resumed: false,
        });
        log("info", "Proxmox container ready", { node: ref.node, vmid, ip: lease.metadata?.ip });
        return lease;
      } catch (error) {
        await destroyQuietly(api, config, ref, params.companyId, deadline);
        throw error;
      }
    },

    async onEnvironmentResumeLease(params: PluginEnvironmentResumeLeaseParams): Promise<PluginEnvironmentLease> {
      const ref = parseLeaseId(params.providerLeaseId);
      if (!ref) return { providerLeaseId: null, metadata: { expired: true } };
      const config = runtimeConfig(params.config);
      const api = client(config);
      const deadline = Date.now() + config.timeoutMs;
      let ctConfig: Record<string, unknown>;
      try {
        ctConfig = await api.lxcConfig(ref.node, ref.vmid);
      } catch (error) {
        if (isNotFound(error)) return { providerLeaseId: null, metadata: { expired: true } };
        throw error;
      }
      if (!isOwnedContainer(ctConfig, params.companyId)) return { providerLeaseId: null, metadata: { expired: true } };
      const status = await api.lxcStatus(ref.node, ref.vmid);
      if (status.status !== "running") await start(api, ref, deadline);
      return await readyLease({
        api,
        config,
        ref,
        deadline,
        requestedCwd: str(params.leaseMetadata?.remoteCwd),
        knownHosts: str(params.leaseMetadata?.knownHosts),
        resumed: true,
      });
    },

    async onEnvironmentReleaseLease(params: PluginEnvironmentReleaseLeaseParams): Promise<PluginEnvironmentTerminationReceipt | void> {
      if (!params.providerLeaseId) return;
      if (params.resourceDisposition === "stop_and_retain") return await stopLease(params);
      const config = parseConfig(params.config);
      // Reused leases stay running for the next run; Paperclip destroys them when they go stale.
      if (config.reuseLease) return;
      return await destroyLease(params);
    },

    async onEnvironmentStopLease(params: PluginEnvironmentReleaseLeaseParams): Promise<PluginEnvironmentTerminationReceipt> {
      return await stopLease(params);
    },

    async onEnvironmentDestroyLease(params: PluginEnvironmentDestroyLeaseParams): Promise<PluginEnvironmentTerminationReceipt | void> {
      return await destroyLease(params);
    },

    async onEnvironmentRealizeWorkspace(params: PluginEnvironmentRealizeWorkspaceParams): Promise<PluginEnvironmentRealizeWorkspaceResult> {
      const config = runtimeConfig(params.config);
      const ref = parseLeaseId(params.lease.providerLeaseId);
      const ip = str(params.lease.metadata?.ip);
      const remoteCwd = str(params.lease.metadata?.remoteCwd) ?? str(params.workspace.remotePath) ?? `/tmp/${WORKSPACE_DIRNAME}`;
      if (ref && ip) {
        await runChecked(sshTarget(config, ref, ip, str(params.lease.metadata?.knownHosts)), mkdirScript(remoteCwd), "create the workspace");
      }
      return { cwd: remoteCwd, metadata: { provider: PROVIDER_KEY, remoteCwd } };
    },

    async onEnvironmentExecute(params: PluginEnvironmentExecuteParams): Promise<PluginEnvironmentExecuteResult> {
      const ref = parseLeaseId(params.lease.providerLeaseId);
      const ip = str(params.lease.metadata?.ip);
      if (!ref || !ip) {
        return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "No Proxmox container is attached to this lease." };
      }
      const config = runtimeConfig(params.config);
      const knownHosts = str(params.lease.metadata?.knownHosts);
      const target = sshTarget(config, ref, ip, knownHosts);
      const execId = randomUUID();
      let script: string;
      try {
        script = buildExecScript({
          command: params.command,
          args: params.args ?? [],
          cwd: params.cwd ?? str(params.lease.metadata?.remoteCwd),
          env: params.env,
          execId,
        });
      } catch (error) {
        return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: errorMessage(error) };
      }
      const execution = ctx?.execution;
      const result = await ssh({
        target,
        command: shCommand(script),
        stdin: params.stdin,
        timeoutMs: params.timeoutMs ?? config.timeoutMs,
        onOutput: execution ? (stream, chunk) => execution.log(stream, chunk) : undefined,
        acceptNewHostKey: !knownHosts,
      });
      if (result.timedOut) {
        // Closing ssh does not stop a remote command without a terminal; kill its process group explicitly.
        await ssh({ target, command: shCommand(buildKillScript(execId, deps.killGraceSeconds ?? 2)), timeoutMs: 30_000 }).catch((error) =>
          log("warn", "Could not kill a timed-out command", { vmid: ref.vmid, error: errorMessage(error) }),
        );
      }
      let stderr = result.stderr;
      if (!result.timedOut && result.exitCode === 255 && /^(ssh:|Host key verification failed|Permission denied|Connection )/m.test(stderr)) {
        stderr += `\n[proxmox] ssh could not run the command in container ${ref.vmid} at ${ip}; the container may be stopped or unreachable.\n`;
      }
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr,
        metadata: { provider: PROVIDER_KEY, node: ref.node, vmid: ref.vmid },
      };
    },
  });
}

const plugin = createProxmoxSandboxPlugin();
export default plugin;
