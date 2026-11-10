import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diagnoseLxc, redactLines, summarizeDiagnosis, ProxmoxError, type LxcDiagnoseInput, type LxcDiagnosis, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import type { EngineGateway } from "./engine.ts";
import { HttpError } from "./http.ts";
import type { StateStore } from "./state.ts";
import { generateSshKey, realSsh, type SshRunner } from "./containers-ssh.ts";

/**
 * Agent containers: the guided setup that makes the engine run agents inside unprivileged Proxmox LXC containers
 * (the Proxmox sandbox provider plugin) instead of on the host.
 *
 * Every Proxmox action is made through the Proxmox API as the signed-in administrator, so Proxmox's own permission checks
 * decide. The host service runs unprivileged and has no shell or pveum. Engine actions are made as the service account
 * (the engine's instance admin).
 *
 * Secrets: the API token's secret (shown once by Proxmox) and the SSH private key go to the vault the moment they exist.
 * They are never returned to a browser, never logged, and are scrubbed from every job log line and error message. They
 * reach the engine only as Paperclip secrets that the environments reference by id.
 */

export const SANDBOX_USER = "epaperclip-sandbox@pve";
export const TOKEN_NAME = "sandbox";
export const TOKEN_ID = `${SANDBOX_USER}!${TOKEN_NAME}`;
export const PLUGIN_KEY = "epaperclip.proxmox-sandbox-provider";
export const TAG = "epaperclip";
export const TEMPLATE_TAG = "epaperclip-template";
export const TEMPLATE_HOSTNAME = "epaperclip-agent-template";
export const CONFIRM_PHRASE = "remove agent containers";
export const DEFAULT_POOL = "epc-agents";
const AGENT_USER = "agent";

/** Roles with only what the provider uses (docs/PROXMOX-SANDBOX.md). Role names may not start with "PVE". */
export const ROLES: Record<string, string[]> = {
  EPCSandbox: ["VM.Allocate", "VM.Audit", "VM.Config.CPU", "VM.Config.Memory", "VM.Config.Disk", "VM.Config.Network", "VM.Config.Options", "VM.PowerMgmt", "Pool.Audit"],
  EPCSandboxTemplate: ["VM.Clone", "VM.Audit"],
  EPCSandboxStorage: ["Datastore.AllocateSpace", "Datastore.Audit"],
  EPCSandboxNetwork: ["SDN.Use"],
  EPCSandboxNode: ["Sys.Audit"],
};

export type ContainersState = "not_set_up" | "partial" | "ready" | "error";
export type StepId = "check" | "access" | "key" | "template" | "grant" | "plugin" | "environments" | "enforce";
const STEPS: { id: StepId; label: string }[] = [
  { id: "access", label: "Create the sandbox user, role and API token in Proxmox" },
  { id: "key", label: "Generate the SSH key the engine uses" },
  { id: "grant", label: "Give the token rights on the pool, template, storage and bridge" },
  { id: "template", label: "Build the agent container template" },
  { id: "plugin", label: "Install the Proxmox provider in the engine" },
  { id: "environments", label: "Create an environment for each organization" },
  { id: "enforce", label: "Stop agents from running on the host" },
];
const JOB_STEPS: { id: StepId; label: string }[] = [{ id: "check", label: "Check this host" }, ...STEPS];

export interface Size {
  cores: number;
  memoryMb: number;
  diskGb: number;
}
export interface Params {
  storage: string;
  templateStorage: string;
  bridge: string;
  pool: string;
  size: Size;
}

interface OrgSecrets {
  tokenSecretId: string;
  keySecretId: string;
  tokenFp: string;
  keyFp: string;
}
interface Stored {
  params?: Params;
  templateVmid?: number;
  /** The architecture the current template was built from; a template from another architecture is never reused. */
  templateArch?: HostArch;
  /** Consecutive failed template builds. Three in a row needs an explicit "try again" after the cause is fixed. */
  templateAttempts?: number;
  lastTemplateError?: string;
  publicKey?: string;
  pluginId?: string;
  poolCreated?: boolean;
  environments?: Record<string, { environmentId: string }>;
  secrets?: Record<string, OrgSecrets>;
  /** What Proxmox reported about the chosen storages on the last check. */
  storageFacts?: Record<string, StorageFacts>;
  createdBy?: string;
  createdAt?: number;
  lastJob?: JobView;
  lastState?: ContainersState;
}

export type StepState = "pending" | "running" | "done" | "failed" | "skipped";
export interface JobView {
  id: string;
  kind: "setup" | "teardown";
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  startedBy: string;
  steps: { id: StepId | "teardown"; label: string; state: StepState; detail?: string }[];
  log: { t: number; level: "info" | "warn" | "error"; text: string }[];
  error?: string;
  /** Why the failed Proxmox task failed, when it was one: the matched cause, the exact fix and the (redacted) log lines it rests on. */
  diagnosis?: LxcDiagnosis & { step: string };
}

interface Guest {
  vmid?: number;
  type: string;
  tags?: string;
  template?: number;
  status?: string;
  name?: string;
}
interface Company {
  id: string;
  name: string;
  status?: string;
}
interface EngineEnv {
  id: string;
  name: string;
  driver: string;
  status: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown> | null;
}

class StepError extends Error {}
/** A failed Proxmox task with the diagnosis made from its log; `input` lets a later probe refine it. */
class DiagError extends StepError {
  readonly diagnosis: LxcDiagnosis;
  readonly input: LxcDiagnoseInput;
  readonly what: string;
  constructor(message: string, diagnosis: LxcDiagnosis, input: LxcDiagnoseInput, what: string) {
    super(message);
    this.diagnosis = diagnosis;
    this.input = input;
    this.what = what;
  }
}

/** A grant that is wanted: a role on a path for the sandbox user and its token. */
interface GrantGap {
  path: string;
  role: string;
  who: "user" | "token";
  /** Why it counts as missing: no entry, or an entry that does not reach the pool's members. */
  why: "absent" | "not-inherited" | "ineffective";
  /** Privileges Proxmox says are not effective (only for "ineffective"). */
  lacking?: string[];
}

/** A call to the engine as a person who can manage the organization (the signed-in administrator). */
const describeGaps = (gaps: GrantGap[]): string => {
  const by = new Map<string, { path: string; role: string; who: string[]; lacking: Set<string> }>();
  for (const g of gaps) {
    const k = `${g.path}\0${g.role}`;
    const e = by.get(k) ?? { path: g.path, role: g.role, who: [], lacking: new Set<string>() };
    e.who.push(g.who === "user" ? "the user" : "the token");
    for (const l of g.lacking ?? []) e.lacking.add(l);
    by.set(k, e);
  }
  return [...by.values()].map((e) => `${e.role} on ${e.path} for ${e.who.join(" and ")}${e.lacking.size ? ` (lacking ${[...e.lacking].join(", ")})` : ""}`).join("; ");
};

export type EngineActor = (method: string, path: string, body?: unknown) => Promise<unknown>;

const STORAGE_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const BRIDGE_RE = /^[A-Za-z][A-Za-z0-9._-]{0,14}$/;
const POOL_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const intIn = (v: unknown, lo: number, hi: number, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, "bad_request", `${what} must be a whole number from ${lo} to ${hi}`);
  return v;
};
export const DEFAULT_SIZE: Size = { cores: 2, memoryMb: 4096, diskGb: 16 };
const TEMPLATE_DISK_GB = 8;

/** Strict parse of the setup request. Anything not recognised is refused. */
export function parseSetup(b: Record<string, unknown>): Partial<Params> & { size?: Size } {
  const known = new Set(["storage", "bridge", "pool", "templateStorage", "size", "force"]);
  for (const k of Object.keys(b)) if (!known.has(k)) throw new HttpError(400, "bad_request", `Unknown setting ${k.slice(0, 40)}`);
  const out: Partial<Params> & { size?: Size } = {};
  const text = (k: string, re: RegExp, what: string) => {
    if (b[k] === undefined || b[k] === "") return undefined;
    if (typeof b[k] !== "string" || !re.test(b[k] as string)) throw new HttpError(400, "bad_request", `${what} doesn't look right`);
    return b[k] as string;
  };
  out.storage = text("storage", STORAGE_RE, "The container storage");
  out.templateStorage = text("templateStorage", STORAGE_RE, "The template storage");
  out.bridge = text("bridge", BRIDGE_RE, "The bridge");
  out.pool = text("pool", POOL_RE, "The pool");
  if (b.size !== undefined) {
    const s = b.size as Record<string, unknown> | null;
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new HttpError(400, "bad_request", "size must be an object");
    out.size = { cores: intIn(s.cores ?? DEFAULT_SIZE.cores, 1, 16, "Cores"), memoryMb: intIn(s.memoryMb ?? DEFAULT_SIZE.memoryMb, 1024, 65536, "Memory"), diskGb: intIn(s.diskGb ?? DEFAULT_SIZE.diskGb, TEMPLATE_DISK_GB, 512, "Disk") };
  }
  return out;
}

/** The processor architecture container templates must match. The host service runs on the Proxmox node, so this is the
 * node's own architecture. `arm64` covers the ARM hosts; `amd64` is x86-64. */
export type HostArch = "amd64" | "arm64";

export function hostArch(): HostArch | null {
  const a = (globalThis as { process?: { arch?: string } }).process?.arch;
  return a === "arm64" ? "arm64" : a === "x64" ? "amd64" : null;
}

/**
 * The newest debian-NN-standard template in a catalog for the host's architecture.
 *
 * The catalog can list templates for more than one processor at once (a host whose `pveam` catalog was synced with both
 * amd64 and arm64 entries). Sorting by version alone then picks whatever is newest — which is exactly how an amd64 host
 * came to unpack an arm64 template and report "the container's init process died". When `arch` is given, only templates
 * for that architecture are considered.
 */
export function newestDebian(files: string[], arch?: HostArch | null): string | null {
  const re = /^debian-(\d+)-standard_([\w.+~-]+?)_(amd64|arm64)\.tar\.(zst|gz|xz)$/;
  const ver = (f: string) => {
    const m = re.exec(f)!;
    return [Number(m[1]), ...m[2].split(/[.-]/).map((x) => Number(x) || 0)];
  };
  const list = files.filter((f) => {
    const m = re.exec(f);
    return Boolean(m) && (!arch || m![3] === arch);
  });
  list.sort((a, b) => {
    const x = ver(a);
    const y = ver(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
  return list[0] ?? null;
}

/** What Proxmox's API can say about one storage, and what it means for unprivileged container disks. */
export interface StorageFacts {
  name: string;
  /** Proxmox storage type: dir, lvmthin, zfspool, nfs, cifs, ... */
  type?: string;
  active?: boolean;
  enabled?: boolean;
  availBytes?: number;
  totalBytes?: number;
  content?: string;
  /** For dir storage: the host path and, when Proxmox reports it, the filesystem and mount options behind it. */
  path?: string;
  filesystem?: string;
  mountOptions?: string[];
  verdict: "ok" | "warning" | "unsupported" | "unknown";
  /** One sentence an administrator can act on. Always set when the verdict is not "ok". */
  reason?: string;
  /** The host command that answers what the API could not. Set when the verdict is "unknown". */
  hostCheck?: string;
}

const BLOCK_TYPES = new Set(["lvm", "lvmthin", "zfspool", "zfs", "rbd", "iscsi", "iscsidirect"]);
const NETWORK_TYPES = new Set(["nfs", "cifs", "glusterfs", "cephfs"]);
/** Filesystems that cannot hold an unprivileged container's root: no ownership/xattrs for uid 100000+, or no POSIX modes. */
const UNSUITABLE_FS = new Set(["ntfs", "ntfs3", "exfat", "vfat", "msdos", "fuseblk", "fat"]);

/**
 * Whether a storage can hold unprivileged container disks, from what Proxmox reports. Pure, so the console and the tests
 * can use the same rule. It never guesses: when the filesystem behind `dir` storage is not reported, the verdict is
 * "unknown" and says which host command answers it.
 */
export function storageVerdict(f: Omit<StorageFacts, "verdict" | "reason" | "hostCheck">): StorageFacts {
  const base = { ...f };
  const name = f.name;
  if (f.active === false) return { ...base, verdict: "unsupported", reason: `Storage "${name}" is not active on this node. On the host, 'pvesm status' shows why (an unmounted drive or share).` };
  if (typeof f.availBytes === "number" && f.availBytes < 4 * 1024 ** 3) return { ...base, verdict: "unsupported", reason: `Storage "${name}" has only ${(f.availBytes / 1024 ** 3).toFixed(1)} GiB free; building the template needs about 4 GiB and every agent container more.` };
  if (f.type && BLOCK_TYPES.has(f.type)) return { ...base, verdict: "ok" };
  if (f.type && NETWORK_TYPES.has(f.type)) {
    return { ...base, verdict: "warning", reason: `Storage "${name}" is ${f.type} storage. Unprivileged containers need the share to allow ownership and extended attributes (export with no_root_squash; CIFS needs uid/gid mapping). If a container fails to start, this is the first thing to check.` };
  }
  if (f.type === "dir" || f.path || f.filesystem) {
    const fs = (f.filesystem ?? "").toLowerCase();
    if (fs && UNSUITABLE_FS.has(fs)) {
      return { ...base, verdict: "unsupported", reason: `Storage "${name}" is on ${fs}, whose filesystem cannot store an unprivileged container's files (they belong to uid 100000+ and need POSIX ownership and extended attributes). Use ext4, xfs, btrfs, ZFS or LVM.`, hostCheck: `findmnt -T ${f.path ?? "<storage path>"} -o TARGET,SOURCE,FSTYPE,OPTIONS` };
    }
    const opts = (f.mountOptions ?? []).map((o) => o.toLowerCase());
    if (opts.includes("noexec") || opts.includes("ro")) {
      return { ...base, verdict: "unsupported", reason: `Storage "${name}" is mounted ${opts.includes("ro") ? "read-only" : "noexec"}, so the container cannot run its own init from it.`, hostCheck: `findmnt -T ${f.path ?? "<storage path>"} -o TARGET,SOURCE,FSTYPE,OPTIONS` };
    }
    if (opts.includes("nodev")) {
      return { ...base, verdict: "warning", reason: `Storage "${name}" is mounted nodev. Unprivileged containers may still start (their /dev is provided by LXC), but if a device inside the container fails this is the first thing to check.` };
    }
    if (fs) return { ...base, verdict: "ok" };
    return {
      ...base,
      verdict: "unknown",
      reason: `Proxmox does not report which filesystem is behind "${name}" through its API. ePaperclip cannot confirm it supports unprivileged containers.`,
      hostCheck: `findmnt -T ${f.path ?? "<storage path>"} -o TARGET,SOURCE,FSTYPE,OPTIONS   # must not be ntfs/exfat/vfat, and not noexec/nodev/ro`,
    };
  }
  return { ...base, verdict: "unknown", reason: `Proxmox did not report enough about "${name}" (type ${f.type ?? "unknown"}) to judge whether it can hold unprivileged container disks.`, hostCheck: `pvesm status ; findmnt -T <its path>` };
}

const fp = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 16);
const hasTag = (tags: string | undefined, t: string) => (tags ?? "").split(/[;,\s]+/).includes(t);
/** Proxmox's own reason when it gave one; otherwise a sentence about the status, never the API path it came from. */
const proxmoxStatusText = (status: number): string =>
  status === 401 ? "Your Proxmox session ended. Sign in again." : status === 403 ? "This Proxmox account doesn't have permission for that." : status === 404 ? "Proxmox doesn't have what was asked for. It may be a version ePaperclip doesn't know yet." : status >= 500 ? `Proxmox reported an error (${status}) without saying why. Its task log and system log have the details.` : `Proxmox refused the request (${status}).`;
const errText = (e: unknown): string => (e instanceof ProxmoxError ? e.detail ?? proxmoxStatusText(e.status) : e instanceof Error ? e.message : String(e));

export interface ContainersDeps {
  gateway: EngineGateway | null;
  state: StateStore;
  node: string;
  /** The Proxmox API address the engine's plugin should use, and the CA that signed it (if any). */
  pveUrl: string;
  caPem?: string;
  ssh?: SshRunner;
  /** Where the built plugin is installed (the engine reads it from here). */
  pluginDir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Waits between polls are multiplied by this (tests use 0). */
  paceMs?: number;
  /** The node's processor architecture (tests set it); defaults to the host service's own. */
  arch?: HostArch | null;
}

/** Harness adapters that have both an ACP lane (the engine's default) and a direct command-line lane. */
const CLI_LANE = new Set(["claude_local", "codex_local", "gemini_local", "kimi_local"]);

export class AgentContainers {
  private readonly d: ContainersDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ssh: SshRunner;
  private readonly pluginDir: string;
  private job: JobView | null = null;
  private readonly jobs = new Map<string, JobView>();
  private scrub = new Set<string>();
  private reconciling: Promise<void> | null = null;
  private actor: EngineActor | null = null;
  /** Set by an explicit "try the template again": allows a rebuild after repeated failures. */
  private force = false;

  constructor(d: ContainersDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref()));
    this.ssh = d.ssh ?? realSsh();
    this.pluginDir = d.pluginDir ?? "/opt/epaperclip/plugins/proxmox-sandbox";
  }

  // ---- stored state

  private stored(): Stored {
    return this.d.state.getSetting<Stored>("agentContainers") ?? {};
  }
  private save(patch: Partial<Stored>) {
    this.d.state.setSetting("agentContainers", { ...this.stored(), ...patch });
  }
  private tokenSecret(): string | null {
    return this.d.state.getSecret("agentContainers.apiToken");
  }
  private sshKey(): string | null {
    return this.d.state.getSecret("agentContainers.sshKey");
  }
  /** Defaults for anything not chosen yet. */
  private params(over: Partial<Params> = {}): Params {
    const s = this.stored().params;
    return {
      storage: over.storage ?? s?.storage ?? "local-lvm",
      templateStorage: over.templateStorage ?? s?.templateStorage ?? "local",
      bridge: over.bridge ?? s?.bridge ?? "vmbr0",
      pool: over.pool ?? s?.pool ?? DEFAULT_POOL,
      size: over.size ?? s?.size ?? DEFAULT_SIZE,
    };
  }
  private pools(): Record<string, { pool: string; cores?: number; memoryMb?: number; maxGuests?: number }> {
    return this.d.state.getSetting<Record<string, { pool: string; cores?: number; memoryMb?: number; maxGuests?: number }>>("resourceGroups") ?? {};
  }
  private poolFor(companyId: string): string {
    return this.pools()[companyId]?.pool ?? "";
  }
  /** The node's architecture; templates for the other one cannot run here. */
  private arch(): HostArch | null {
    return this.d.arch !== undefined ? this.d.arch : hostArch();
  }

  /**
   * What Proxmox can say about a storage: its type and state, and for `dir` storage the path, filesystem and mount
   * options from `/nodes/{node}/disks/directory`. Every call is best effort: a missing answer becomes "unknown", never a
   * guessed cause.
   */
  async storageFacts(pve: ProxmoxClient, storage: string): Promise<StorageFacts> {
    const node = this.d.node;
    const [status, config, dirs] = await Promise.all([
      pve.storageStatus(node, storage).catch(() => undefined),
      pve.storageConfig(storage).catch(() => undefined),
      pve.nodeStorageDirectories(node).catch(() => []),
    ]);
    const path = config?.path;
    const dir = path ? dirs.find((d) => d.path === path) : undefined;
    return storageVerdict({
      name: storage,
      type: status?.type ?? config?.type,
      active: status ? status.active !== 0 : undefined,
      enabled: status ? status.enabled !== 0 : undefined,
      availBytes: status?.avail,
      totalBytes: status?.total,
      content: status?.content ?? config?.content,
      path,
      filesystem: dir?.type,
      mountOptions: dir?.options?.split(",").map((o) => o.trim()).filter(Boolean),
    });
  }

  // ---- job log

  private log(job: JobView, level: "info" | "warn" | "error", text: string) {
    let t = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\u001b\[[0-9;]*m/g, "");
    for (const s of this.scrub) if (s.length >= 6) t = t.split(s).join("[redacted]");
    t = t.slice(0, 2000);
    job.log.push({ t: this.now(), level, text: t });
    if (job.log.length > 1500) job.log.splice(0, job.log.length - 1500);
  }
  private clean(msg: string): string {
    let t = msg;
    for (const s of this.scrub) if (s.length >= 6) t = t.split(s).join("[redacted]");
    return t.slice(0, 600);
  }
  private addSecret(...v: (string | null | undefined)[]) {
    for (const s of v) if (s) this.scrub.add(s);
  }
  private pace(ms: number) {
    return this.sleep(this.d.paceMs ?? ms);
  }

  // ---- engine

  private async eng<T>(method: string, path: string, body?: unknown): Promise<T> {
    const g = this.d.gateway;
    if (!g) throw new StepError("The engine isn't set up on this host.");
    const r = await g.serviceJson<T>(method, path, body).catch((e) => {
      // Say which engine call was refused (the path never carries a secret).
      if (e instanceof HttpError) throw new HttpError(e.status, e.code, `${e.message} (${method} ${path.split("?")[0]})`);
      throw e;
    });
    if (r === null) throw new StepError("The engine's instance admin isn't ePaperclip's service account (another account claimed the engine first), so ePaperclip can't install the provider or create environments. Do it in the engine as that admin, following docs/PROXMOX-SANDBOX.md, or reset the engine's data.");
    return r;
  }
  private async companies(): Promise<Company[]> {
    return (await this.eng<Company[]>("GET", "/api/companies")).filter((c) => c.status !== "archived");
  }
  private async engineEnvs(companyId: string): Promise<EngineEnv[]> {
    return this.eng<EngineEnv[]>("GET", `/api/companies/${encodeURIComponent(companyId)}/environments`);
  }
  private ours(e: EngineEnv): string | null {
    const m = e.metadata as { epaperclip?: string; companyId?: string } | null | undefined;
    return m?.epaperclip === "agent-containers" && typeof m.companyId === "string" ? m.companyId : null;
  }

  /** The engine must be answering, with ePaperclip's service account as its admin. */
  async assertEngineReady() {
    const g = this.d.gateway;
    if (!g) throw new HttpError(409, "engine_not_ready", "The engine isn't set up on this host.");
    const st = await g.status();
    if (!st.ready) throw new HttpError(409, "engine_not_ready", st.error ?? "The engine isn't ready yet. Wait for it to finish starting, then try again.");
    if (!(await g.serviceReady())) throw new HttpError(409, "engine_not_ours", "The engine's instance admin isn't ePaperclip's service account, so ePaperclip can't install the provider. See docs/PROXMOX-SANDBOX.md to do it by hand.");
  }

  // ---- enforcement: the engine refuses to run an agent on the local environment

  /** Turns on the engine's managed-sandbox-only policy: a run that would land on the host fails closed. Best effort. */
  async enforce(): Promise<{ ok: boolean; error?: string }> {
    try {
      const cur = await this.eng<Record<string, unknown>>("GET", "/api/instance/settings/experimental");
      if (cur.enableManagedSandboxOnly === true) return { ok: true };
      await this.eng("PATCH", "/api/instance/settings/experimental", { enableManagedSandboxOnly: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  // ---- status

  async status(pve: ProxmoxClient | null, canManage: boolean) {
    const st = this.stored();
    const base = { canManage, job: this.job ? { id: this.job.id, status: this.job.status } : null };
    if (!canManage || !pve) {
      const state = st.lastState ?? "not_set_up";
      return { ...base, state, steps: [], pluginInstalled: false, environments: [], template: { exists: false }, token: { exists: false } };
    }
    const p = this.params();
    const steps = STEPS.map((s) => ({ id: s.id, label: s.label, done: false, detail: undefined as string | undefined }));
    const set = (id: StepId, done: boolean, detail?: string) => {
      const s = steps.find((x) => x.id === id)!;
      s.done = done;
      s.detail = detail;
    };
    let checkError: string | null = null;
    let template: { vmid?: number; name?: string; exists: boolean; arch?: HostArch | null } = { exists: false };
    let tokenExists = false;
    let pluginInstalled = false;
    let grantGaps: GrantGap[] = [];
    const environments: { companyId: string; environmentId: string; ok: boolean }[] = [];
    const tokenSecret = this.tokenSecret();
    try {
      const [roles, guests] = await Promise.all([pve.call<{ roleid: string; privs?: string }[]>("GET", "/access/roles"), pve.clusterResources()]);
      const user = await pve.call<unknown>("GET", `/access/users/${encodeURIComponent(SANDBOX_USER)}`).then(() => true, () => false);
      const tokens = user ? await pve.call<{ tokenid: string }[]>("GET", `/access/users/${encodeURIComponent(SANDBOX_USER)}/token`).catch(() => []) : [];
      tokenExists = tokens.some((t) => t.tokenid === TOKEN_NAME);
      const missingRoles = Object.entries(ROLES).filter(([name, privs]) => {
        const r = roles.find((x) => x.roleid === name);
        const have = new Set((r?.privs ?? "").split(","));
        return !r || !privs.every((x) => have.has(x));
      });
      if (!user) set("access", false, `The user ${SANDBOX_USER} doesn't exist`);
      else if (missingRoles.length) set("access", false, `Missing or changed role: ${missingRoles.map(([n]) => n).join(", ")}`);
      else if (!tokenExists) set("access", false, `The API token ${TOKEN_ID} doesn't exist`);
      else if (!tokenSecret) set("access", false, "The token exists but its secret isn't in the vault (it is shown only once); setup will replace it");
      else set("access", true);
      set("key", Boolean(this.sshKey() && st.publicKey));

      const vmid = st.templateVmid;
      const g = vmid ? (guests as Guest[]).find((x) => x.vmid === vmid) : undefined;
      template = { vmid, name: g ? TEMPLATE_HOSTNAME : undefined, exists: Boolean(g && g.template === 1 && hasTag(g.tags, TEMPLATE_TAG)), arch: st.templateArch ?? null };
      set("template", template.exists, vmid && !template.exists ? "The template isn't there" : undefined);

      // Rights: for the user and for the token, on each path. The template's own right can only exist once the template does.
      const { gaps } = await this.grantGaps(pve, p, template.exists, true);
      grantGaps = gaps;
      const detail = gaps.length ? `Missing: ${describeGaps(gaps)}` : !template.exists ? "Rights on the pool, storage, bridge and node are in place; the template's own right is added once it is built" : undefined;
      set("grant", template.exists && gaps.length === 0, detail);
    } catch (e) {
      checkError = `Couldn't check Proxmox. ${errText(e)}`;
      // The reason is shown once, above the steps; each step only says it wasn't checked.
      for (const id of ["access", "key", "template", "grant"] as StepId[]) set(id, false, "Not checked");
    }
    // The engine side.
    try {
      if (!this.d.gateway) throw new StepError("The engine isn't set up on this host.");
      const plugins = await this.eng<{ id: string; pluginKey: string; status: string; lastError?: string | null }[]>("GET", "/api/plugins");
      const pl = plugins.find((x) => x.pluginKey === PLUGIN_KEY);
      pluginInstalled = pl?.status === "ready";
      set("plugin", pluginInstalled, pl ? (pl.status === "ready" ? undefined : `The provider is ${pl.status}${pl.lastError ? `: ${pl.lastError}` : ""}`) : "The provider isn't installed");
      const cos = await this.companies();
      const envs = cos.length ? await this.engineEnvs(cos[0].id) : [];
      for (const c of cos) {
        const e = envs.find((x) => this.ours(x) === c.id);
        if (e) environments.push({ companyId: c.id, environmentId: e.id, ok: e.status === "active" && this.envMatches(e, c.id, p, st.templateVmid) });
      }
      const missingEnv = cos.filter((c) => !environments.some((e) => e.companyId === c.id && e.ok));
      set("environments", missingEnv.length === 0, cos.length === 0 ? "No organizations yet; each gets one when it's created" : missingEnv.length ? `Needed for: ${missingEnv.map((c) => c.name).slice(0, 3).join(", ")}` : undefined);
      const ex = await this.eng<Record<string, unknown>>("GET", "/api/instance/settings/experimental");
      set("enforce", ex.enableManagedSandboxOnly === true, ex.enableManagedSandboxOnly === true ? undefined : "The engine would still run agents on the host");
    } catch (e) {
      checkError = checkError ?? `Couldn't check the engine. ${errText(e)}`;
      for (const id of ["plugin", "environments", "enforce"] as StepId[]) set(id, false, "Not checked");
    }
    const done = steps.filter((s) => s.done).length;
    // "Not set up" means none of the real work is there (a lone enforcement flag or an empty list of organizations isn't).
    const core = steps.filter((s) => ["access", "key", "template", "grant", "plugin"].includes(s.id) && s.done).length;
    let state: ContainersState = done === steps.length ? "ready" : core === 0 ? "not_set_up" : "partial";
    if (state !== "ready" && (checkError || (st.lastJob?.kind === "setup" && st.lastJob.status === "failed" && st.lastJob.finishedAt !== undefined))) state = "error";
    if (state === "not_set_up" && checkError) state = "error";
    if (this.stored().lastState !== state) this.save({ lastState: state });
    return {
      ...base,
      state,
      steps,
      pluginInstalled,
      environments,
      template,
      token: { exists: tokenExists },
      storageFacts: Object.values(st.storageFacts ?? {}),
      templateAttempts: st.templateAttempts ?? 0,
      arch: this.arch(),
      grantMissing: grantGaps.map((g) => ({ path: g.path, role: g.role, who: g.who, why: g.why, lacking: g.lacking })),
      ...(state !== "ready" && st.lastJob?.kind === "setup" && st.lastJob.status === "failed" && st.lastJob.diagnosis ? { diagnosis: st.lastJob.diagnosis } : {}),
      params: st.params ?? null,
      options: await this.options(pve, st.params ?? null),
      ...(checkError ? { error: checkError } : state === "error" && st.lastJob?.error ? { error: st.lastJob.error } : {}),
    };
  }

  /**
   * What this node can actually offer for the three host choices, and the pick to start from. The form shows these as
   * lists, so nobody has to know that their default "local-lvm" isn't on this host. A saved choice that is still valid
   * stays; otherwise: local-lvm or local-zfs when present for disks, "local" for templates, vmbr0 for the bridge, then
   * whatever comes first.
   */
  private async options(pve: ProxmoxClient, saved: Params | null) {
    try {
      const node = this.d.node;
      const [disks, tpl, net] = await Promise.all([pve.nodeStorages(node, "rootdir"), pve.nodeStorages(node, "vztmpl"), pve.network(node)]);
      const storages = disks.map((x) => x.storage);
      const templateStorages = tpl.map((x) => x.storage);
      const bridges = net.interfaces.filter((i) => /bridge/i.test(i.type)).map((i) => i.iface);
      const pick = (list: string[], saved: string | undefined, prefer: string[]) => (saved && list.includes(saved) ? saved : prefer.find((x) => list.includes(x)) ?? list[0] ?? null);
      return {
        storages,
        templateStorages,
        bridges,
        suggested: { storage: pick(storages, saved?.storage, ["local-lvm", "local-zfs"]), templateStorage: pick(templateStorages, saved?.templateStorage, ["local"]), bridge: pick(bridges, saved?.bridge, ["vmbr0"]) },
      };
    } catch {
      return null;
    }
  }

  private wantedAcls(p: Params, vmid: number | undefined): [string, string][] {
    const out: [string, string][] = [[`/pool/${p.pool}`, "EPCSandbox"]];
    for (const g of Object.values(this.pools())) out.push([`/pool/${g.pool}`, "EPCSandbox"]);
    if (vmid !== undefined) out.push([`/vms/${vmid}`, "EPCSandboxTemplate"]);
    out.push([`/storage/${p.storage}`, "EPCSandboxStorage"], [`/sdn/zones/localnetwork/${p.bridge}`, "EPCSandboxNetwork"], [`/nodes/${this.d.node}`, "EPCSandboxNode"]);
    const seen = new Set<string>();
    return out.filter(([a, b]) => !seen.has(a + b) && seen.add(a + b));
  }

  private envMatches(e: EngineEnv, companyId: string, p: Params, vmid: number | undefined): boolean {
    const want = this.envConfig(companyId, p, vmid, this.stored().secrets?.[companyId], this.limits(companyId, p));
    if (!want) return false;
    const have = e.config ?? {};
    return Object.entries(want).every(([k, v]) => have[k] === v);
  }

  /** Container size for an organization: its resource group's limits, capped by the chosen size. */
  private limits(companyId: string, p: Params): Size {
    const rg = this.d.state.getSetting<Record<string, { cores?: number; memoryMb?: number; diskGb?: number }>>("resourceGroups")?.[companyId];
    const min = (a: number | undefined, b: number) => (typeof a === "number" && a > 0 ? Math.min(a, b) : b);
    return { cores: min(rg?.cores, p.size.cores), memoryMb: Math.max(1024, min(rg?.memoryMb, p.size.memoryMb)), diskGb: Math.max(TEMPLATE_DISK_GB, min(rg?.diskGb, p.size.diskGb)) };
  }

  /** What an environment's config must contain. Secrets are referenced by Paperclip secret id, never by value. */
  private envConfig(companyId: string, p: Params, vmid: number | undefined, sec: OrgSecrets | undefined, size: Size): Record<string, unknown> | null {
    if (vmid === undefined || !sec) return null;
    // An organization gets a container environment only for its own resource group's pool. There is deliberately no
    // shared, unrestricted pool to fall back to: that would look like isolation while giving every organization the same
    // boundary.
    const pool = this.poolFor(companyId);
    if (!pool) return null;
    const cfg: Record<string, unknown> = {
      provider: "proxmox",
      apiUrl: new URL(this.d.pveUrl).origin,
      node: this.d.node,
      apiTokenId: TOKEN_ID,
      apiTokenSecret: sec.tokenSecretId,
      template: String(vmid),
      pool,
      storage: p.storage,
      bridge: p.bridge,
      cores: size.cores,
      memoryMb: size.memoryMb,
      diskGb: size.diskGb,
      unprivileged: true,
      sshPrivateKey: sec.keySecretId,
      sshUser: AGENT_USER,
      reuseLease: false,
    };
    // The organization's resource group is an aggregate limit over everything in its pool; the provider enforces it when it allocates.
    const group = this.pools()[companyId];
    if (group) { cfg.quotaGuests = group.maxGuests; cfg.quotaCores = group.cores; cfg.quotaMemoryMb = group.memoryMb; }
    if (this.d.caPem) cfg.caCert = this.d.caPem.trim();
    return cfg;
  }

  // ---- jobs

  getJob(id: string): JobView | null {
    const j = this.jobs.get(id) ?? (this.stored().lastJob?.id === id ? this.stored().lastJob! : null);
    return j ? JSON.parse(JSON.stringify(j)) : null;
  }

  /** Starts a setup job (or returns the one already running). Checks that need no Proxmox call happen first. */
  async startSetup(getPve: () => Promise<ProxmoxClient>, who: string, over: Partial<Params>, actor: EngineActor | null = null, force = false): Promise<{ jobId: string; alreadyRunning: boolean }> {
    if (this.job?.status === "running") return { jobId: this.job.id, alreadyRunning: true };
    await this.assertEngineReady();
    const job = this.newJob("setup", who, JOB_STEPS);
    this.job = job;
    this.actor = actor;
    this.force = force;
    void this.runSetup(job, getPve, over, force).catch((e) => this.fail(job, e));
    return { jobId: job.id, alreadyRunning: false };
  }

  /**
   * Runs one step again on its own, as the signed-in administrator, for when a single step is what's left (the rights,
   * the provider, the organizations' environments, the template after an explicit retry). Needs a full setup to have
   * chosen the host settings first.
   */
  async startStep(getPve: () => Promise<ProxmoxClient>, who: string, id: unknown, actor: EngineActor | null = null, force = false): Promise<{ jobId: string; alreadyRunning: boolean }> {
    if (id !== "grant" && id !== "plugin" && id !== "environments" && id !== "template") throw new HttpError(400, "bad_request", "Only the rights, provider, environments and template steps can be run alone");
    if (id === "template" && !force) throw new HttpError(400, "force_required", 'Rebuilding the container template needs an explicit confirmation. Send force: true after fixing the cause of the last failure.');
    if (this.job?.status === "running") return { jobId: this.job.id, alreadyRunning: true };
    if (!this.stored().params) throw new HttpError(409, "not_set_up", "Run the full setup once first so the host settings are known");
    await this.assertEngineReady();
    const label = STEPS.find((x) => x.id === id)!;
    const job = this.newJob("setup", who, [label]);
    this.job = job;
    this.actor = actor;
    this.force = force;
    const params = this.params();
    void (async () => {
      const pve = await getPve();
      await this.step(job, id, () => (id === "grant" ? this.stepGrant(job, pve, params) : id === "plugin" ? this.stepPlugin(job) : id === "template" ? this.stepTemplate(job, pve, params) : this.stepEnvironments(job, params)));
      job.status = "done";
      job.finishedAt = this.now();
      this.log(job, "info", `${label.label}: done.`);
      this.finish(job);
    })().catch((e) => this.fail(job, e));
    return { jobId: job.id, alreadyRunning: false };
  }

  /**
   * Applies new host settings (container storage, template storage, bridge, size) to an installation that is already
   * partly or fully set up, without rebuilding the template or discarding what worked. It validates the new storage the
   * same way the full setup does, saves the choice, then re-grants the token's rights on the new storage and updates every
   * organization's environment. A change to the template storage takes effect the next time the template is built.
   */
  async startSettings(getPve: () => Promise<ProxmoxClient>, who: string, over: Partial<Params>, actor: EngineActor | null = null): Promise<{ jobId: string; alreadyRunning: boolean }> {
    if (this.job?.status === "running") return { jobId: this.job.id, alreadyRunning: true };
    if (!this.stored().params) throw new HttpError(409, "not_set_up", "Run the full setup once first so the host settings are known");
    if (!Object.keys(over).length) throw new HttpError(400, "bad_request", "Nothing to change");
    await this.assertEngineReady();
    const job = this.newJob("setup", who, [
      { id: "check", label: "Check the new storage" },
      { id: "grant", label: "Give the token rights on the new storage" },
      { id: "environments", label: "Point each organization's environment at it" },
    ]);
    this.job = job;
    this.actor = actor;
    const merged = this.params(over);
    void (async () => {
      const pve = await getPve();
      await this.step(job, "check", () => this.check(job, pve, merged));
      this.save({ params: merged });
      await this.step(job, "grant", () => this.stepGrant(job, pve, merged));
      await this.step(job, "environments", () => this.stepEnvironments(job, merged));
      job.status = "done";
      job.finishedAt = this.now();
      this.log(job, "info", "The new settings are in place. The template storage, if it changed, is used the next time the template is built.");
      this.finish(job);
    })().catch((e) => this.fail(job, e));
    return { jobId: job.id, alreadyRunning: false };
  }

  private newJob(kind: "setup" | "teardown", who: string, steps: { id: StepId | "teardown"; label: string }[]): JobView {
    const job: JobView = { id: randomBytes(6).toString("hex"), kind, status: "running", startedAt: this.now(), startedBy: who, steps: steps.map((s) => ({ ...s, state: "pending" as StepState })), log: [] };
    this.jobs.set(job.id, job);
    if (this.jobs.size > 8) this.jobs.delete(this.jobs.keys().next().value!);
    return job;
  }

  private fail(job: JobView, e: unknown) {
    const msg = this.clean(e instanceof StepError || e instanceof HttpError ? e.message : errText(e));
    const running = job.steps.find((s) => s.state === "running");
    if (running) {
      running.state = "failed";
      running.detail = msg;
    }
    job.status = "failed";
    job.error = msg;
    if (e instanceof DiagError) job.diagnosis = { ...e.diagnosis, step: e.what };
    job.finishedAt = this.now();
    this.log(job, "error", msg);
    this.finish(job);
  }

  private finish(job: JobView) {
    this.scrub = new Set();
    this.actor = null;
    this.force = false;
    this.save({ lastJob: { ...job, log: job.log.slice(-200) } });
  }

  private async step(job: JobView, id: StepId, fn: () => Promise<string | void>) {
    const s = job.steps.find((x) => x.id === id)!;
    s.state = "running";
    this.log(job, "info", `${s.label}`);
    const detail = await fn();
    s.state = "done";
    if (detail) s.detail = detail;
  }

  private async runSetup(job: JobView, getPve: () => Promise<ProxmoxClient>, over: Partial<Params>, force: boolean) {
    const pve = await getPve();
    const before = this.stored().params;
    const params = this.params(over);
    this.force = force;
    // A changed host setting invalidates the grants/environment checks, so it is never a resume.
    const changed = (Object.keys(over) as (keyof Params)[]).some((k) => over[k] !== undefined && JSON.stringify(over[k]) !== JSON.stringify(before?.[k]));
    await this.step(job, "check", () => this.check(job, pve, params));
    this.save({ params, createdBy: this.stored().createdBy ?? job.startedBy, createdAt: this.stored().createdAt ?? this.now() });
    // Resume from the first valid unfinished step: what Proxmox and the engine already have is not redone. The check step
    // always runs (it is the validation); a force rebuild only affects the template.
    const resumed = new Set<StepId>();
    if (!changed && before) {
      const snap = await this.status(pve, true).catch(() => null);
      if (snap) for (const s of snap.steps) if (s.done) resumed.add(s.id as StepId);
    }
    const skip = (id: StepId, why: string) => {
      const s = job.steps.find((x) => x.id === id)!;
      s.state = "done";
      s.detail = why;
      this.log(job, "info", `${s.label}: already in place`);
    };
    if (resumed.has("access")) skip("access", "Already in place"); else await this.step(job, "access", () => this.stepAccess(job, pve, params));
    if (resumed.has("key")) skip("key", "Already in place"); else await this.step(job, "key", async () => this.stepKey(job));
    // Rights on the pool, storage, bridge and node need no template; the template's own right is added when it is built.
    if (resumed.has("grant")) skip("grant", "Already in place"); else await this.step(job, "grant", () => this.stepGrant(job, pve, params));
    // The provider install doesn't depend on the template, so a template that fails to build doesn't hide whether it works.
    let templateError: unknown = null;
    if (resumed.has("template") && !force) skip("template", "Already in place");
    else {
      try {
        await this.step(job, "template", () => this.stepTemplate(job, pve, params));
      } catch (e) {
        templateError = e;
        const running = job.steps.find((x) => x.state === "running");
        if (running) {
          running.state = "failed";
          running.detail = this.clean(e instanceof StepError || e instanceof HttpError ? e.message : errText(e));
        }
        this.save({ templateAttempts: (this.stored().templateAttempts ?? 0) + 1, lastTemplateError: running?.detail });
      }
    }
    if (resumed.has("plugin")) skip("plugin", "Already in place"); else await this.step(job, "plugin", () => this.stepPlugin(job));
    if (templateError) {
      for (const id of ["environments", "enforce"] as StepId[]) {
        const s = job.steps.find((x) => x.id === id)!;
        s.state = "skipped";
        s.detail = "Waits for the template";
      }
      throw templateError;
    }
    if (resumed.has("environments")) skip("environments", "Already in place"); else await this.step(job, "environments", () => this.stepEnvironments(job, params));
    await this.step(job, "enforce", async () => {
      const r = await this.enforce();
      if (!r.ok) throw new StepError(`The engine wouldn't turn on its managed-sandbox-only policy: ${r.error}`);
      this.log(job, "info", "The engine now refuses to run agents anywhere but in a container.");
    });
    job.status = "done";
    job.finishedAt = this.now();
    this.log(job, "info", "Agent containers are ready.");
    this.save({ lastState: "ready" });
    this.finish(job);
  }

  // ---- steps

  private async check(job: JobView, pve: ProxmoxClient, p: Params): Promise<string> {
    const node = this.d.node;
    const ssh = await this.ssh.available();
    if (!ssh.ok) throw new StepError(ssh.reason);
    this.log(job, "info", `ssh: ${ssh.version}`);
    try {
      const pl = JSON.parse(readFileSync(join(this.pluginDir, "package.json"), "utf8")) as { version?: string };
      readFileSync(join(this.pluginDir, "dist", "manifest.js"));
      readFileSync(join(this.pluginDir, "template", "provision.sh"));
      this.log(job, "info", `provider plugin ${pl.version ?? "?"} found in ${this.pluginDir}`);
    } catch {
      throw new StepError(`The Proxmox provider plugin isn't installed on this host (expected a built copy in ${this.pluginDir}). Reinstall or upgrade ePaperclip.`);
    }
    const ver = await pve.version().catch(() => null);
    const major = Number(/^(\d+)/.exec(ver?.version ?? "")?.[1]);
    if (ver) this.log(job, "info", `Proxmox VE ${ver.version}`);
    if (Number.isFinite(major) && major < 8) throw new StepError(`This is Proxmox VE ${ver!.version}. Agent containers need Proxmox VE 8 or later: the network permission they use (SDN.Use) doesn't exist before it. Upgrade Proxmox, or set the provider up by hand (docs/PROXMOX-SANDBOX.md).`);
    const storages = await pve.nodeStorages(node, "rootdir").catch((e) => {
      throw new StepError(`Couldn't list the node's storage: ${errText(e)}`);
    });
    if (!storages.some((s) => s.storage === p.storage)) throw new StepError(`Storage "${p.storage}" can't hold container disks on this node. Choose one of: ${storages.map((s) => s.storage).join(", ") || "(none)"}.`);
    // What Proxmox can say about the storage, including the filesystem and mount options behind a directory storage.
    const facts = await this.storageFacts(pve, p.storage);
    const tplFacts = await this.storageFacts(pve, p.templateStorage);
    this.save({ storageFacts: { [p.storage]: facts, [p.templateStorage]: tplFacts } });
    if (facts.verdict === "unsupported") throw new StepError(`${facts.reason}${facts.hostCheck ? ` On the host: ${facts.hostCheck}` : ""}`);
    if (facts.verdict === "warning") this.log(job, "warn", facts.reason!);
    if (facts.verdict === "unknown") this.log(job, "warn", `${facts.reason}${facts.hostCheck ? ` On the host: ${facts.hostCheck}` : ""}`);
    this.log(job, "info", `Container storage "${p.storage}": ${facts.type ?? "unknown type"}${facts.filesystem ? ` on ${facts.filesystem}` : ""}${typeof facts.availBytes === "number" ? `, ${(facts.availBytes / 1024 ** 3).toFixed(1)} GiB free` : ""}${facts.verdict === "ok" ? "" : ` (${facts.verdict})`}`);
    const tpl = await pve.nodeStorages(node, "vztmpl");
    if (!tpl.some((s) => s.storage === p.templateStorage)) throw new StepError(`Storage "${p.templateStorage}" can't hold container templates on this node. Choose one of: ${tpl.map((s) => s.storage).join(", ") || "(none)"}.`);
    if (tplFacts.verdict === "unsupported" && tplFacts.active === false) throw new StepError(tplFacts.reason!);
    const net = await pve.network(node);
    if (!net.interfaces.some((i) => i.iface === p.bridge && /bridge/i.test(i.type))) throw new StepError(`There is no bridge named "${p.bridge}" on this node. Choose one of: ${net.interfaces.filter((i) => /bridge/i.test(i.type)).map((i) => i.iface).join(", ") || "(none)"}.`);
    return "Host looks ready";
  }

  /**
   * Waits for a Proxmox task, relaying its log lines to the job log as they appear (downloads and container creation
   * can take minutes). When it fails, the full task log, the container's config and the host journal are read and
   * matched against the known causes, so the error says why and what to do instead of "Proxmox reported an error".
   */
  private async task(pve: ProxmoxClient, upid: string | null | undefined, what: string, timeoutMs = 600_000, ctx: { vmid?: number; diagnose?: boolean } = {}) {
    if (!upid || typeof upid !== "string" || !upid.startsWith("UPID:")) return;
    const node = this.d.node;
    const job = this.job;
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    let shown = 0;
    let lastDecile = -1;
    const relay = async () => {
      if (!job) return;
      const lines = await pve.taskLog(node, upid, 200, seen).catch(() => []);
      for (const l of lines) {
        if (l.n <= seen) continue;
        seen = l.n;
        const pct = /\b(\d{1,3})(?:\.\d+)?%/.exec(l.t)?.[1];
        if (pct !== undefined) {
          const decile = Math.floor(Number(pct) / 10);
          if (decile === lastDecile) continue;
          lastDecile = decile;
        }
        if (++shown > 80) {
          if (shown === 81) this.log(job, "info", "(more of this task's log is in Proxmox: Node, Tasks)");
          continue;
        }
        this.log(job, "info", `  ${redactLines([l.t.slice(0, 300)])[0]}`);
      }
    };
    for (;;) {
      let st: Awaited<ReturnType<ProxmoxClient["taskStatus"]>>;
      try {
        st = await pve.taskStatus(node, upid);
      } catch (e) {
        throw new StepError(`${what} failed: ${errText(e)}`);
      }
      await relay();
      if (st.status === "stopped") {
        if (st.exitstatus === "OK" || st.exitstatus?.startsWith("WARNINGS")) return;
        throw await this.explainTaskFailure(pve, upid, what, st.exitstatus, ctx);
      }
      if (Date.now() > deadline) throw new StepError(`${what} didn't finish within ${Math.round(timeoutMs / 60_000)} minutes. It may still be running: see Node, Tasks in Proxmox.`);
      await this.pace(1000);
    }
  }

  /** Reads what Proxmox will tell us about a failed task and turns it into a diagnosis the person can act on. */
  private async explainTaskFailure(pve: ProxmoxClient, upid: string, what: string, exitstatus: string | undefined, ctx: { vmid?: number; diagnose?: boolean }): Promise<StepError> {
    const node = this.d.node;
    const lines = await pve.taskLog(node, upid, 1000).catch(() => []);
    const ev = ctx.vmid !== undefined ? await this.gatherEvidence(pve, ctx.vmid) : {};
    const input: LxcDiagnoseInput = { exitstatus, log: lines.map((l) => l.t), vmid: ctx.vmid, hostArch: this.arch() ?? undefined, ...ev };
    if (ctx.diagnose === false) return new StepError(`${what} failed: ${exitstatus ?? "unknown"}`);
    const d = diagnoseLxc(input);
    const job = this.job;
    if (job) {
      this.log(job, "warn", `${what} failed${exitstatus ? ` (Proxmox: ${redactLines([exitstatus])[0]})` : ""}. Evidence:`);
      for (const l of d.evidence) this.log(job, "warn", `  ${l.slice(0, 300)}`);
      this.log(job, "error", `${d.title}. ${d.plain}`);
      for (const f of d.fix) this.log(job, "info", `  Fix: ${f}`);
    }
    return new DiagError(this.clean(`${what} failed. ${summarizeDiagnosis(d)}`), d, input, what);
  }

  /** The equivalent of `pct config`, the node journal and `pvesm status` for a container, each best effort. */
  private async gatherEvidence(pve: ProxmoxClient, vmid: number): Promise<Pick<LxcDiagnoseInput, "config" | "journal" | "storage">> {
    const node = this.d.node;
    const [config, journal] = await Promise.all([pve.lxcConfig(node, vmid).catch(() => undefined), pve.nodeJournal(node, 300).catch(() => [])]);
    const sname = typeof config?.rootfs === "string" ? config.rootfs.split(":")[0] : this.stored().params?.storage;
    const status = sname ? await pve.storageStatus(node, sname).catch(() => undefined) : undefined;
    const safe = config ? Object.fromEntries(Object.entries(config).filter(([k]) => !/ssh-public-keys|password|description/i.test(k))) : undefined;
    if (safe && this.job) this.log(this.job, "info", `Container ${vmid} config: ${redactLines([Object.entries(safe).map(([k, v]) => `${k}=${String(v)}`).join(" ")])[0]}`);
    return {
      config: safe,
      journal,
      storage: sname ? { name: sname, type: status?.type, active: status ? status.active === 1 : undefined, availBytes: status?.avail } : undefined,
    };
  }

  private async stepAccess(job: JobView, pve: ProxmoxClient, p: Params): Promise<string> {
    for (const [name, privs] of Object.entries(ROLES)) {
      const have = await pve.call<{ privs?: string }>("GET", `/access/roles/${name}`).then((r) => r, () => null);
      if (!have) {
        await pve.call("POST", "/access/roles", { roleid: name, privs: privs.join(",") });
        this.log(job, "info", `Created role ${name}`);
      } else if (!privs.every((x) => (have.privs ?? "").split(",").includes(x))) {
        await pve.call("PUT", `/access/roles/${name}`, { privs: privs.join(","), append: true });
        this.log(job, "info", `Added missing privileges to role ${name}`);
      }
    }
    const userKnown = await pve.call("GET", `/access/users/${encodeURIComponent(SANDBOX_USER)}`).then(() => true, () => false);
    if (!userKnown) {
      // No password: this user can't sign in. It only owns the token.
      await pve.call("POST", "/access/users", { userid: SANDBOX_USER, comment: "ePaperclip agent containers (never signs in; owns the API token)", enable: true });
      this.log(job, "info", `Created user ${SANDBOX_USER} (no password)`);
    }
    // The pool for organizations without a resource group.
    const pools = await pve.pools();
    if (!pools.some((x) => x.poolid === p.pool)) {
      await pve.call("POST", "/pools", { poolid: p.pool, comment: "ePaperclip agent containers" });
      this.save({ poolCreated: true });
      this.log(job, "info", `Created pool ${p.pool}`);
    }
    // The token: its secret is shown once, so it goes to the vault before anything else happens.
    const tokens = await pve.call<{ tokenid: string }[]>("GET", `/access/users/${encodeURIComponent(SANDBOX_USER)}/token`).catch(() => []);
    const exists = tokens.some((t) => t.tokenid === TOKEN_NAME);
    const kept = this.tokenSecret();
    if (exists && kept) {
      this.addSecret(kept, kept.split("=").pop());
      this.log(job, "info", `API token ${TOKEN_ID} already exists`);
      return "Reused";
    }
    if (exists) {
      await pve.call("DELETE", `/access/users/${encodeURIComponent(SANDBOX_USER)}/token/${TOKEN_NAME}`);
      this.log(job, "warn", "The token's secret wasn't in the vault, so the token was replaced");
    }
    const made = await pve.call<{ "full-tokenid"?: string; value?: string }>("POST", `/access/users/${encodeURIComponent(SANDBOX_USER)}/token/${TOKEN_NAME}`, { privsep: true, comment: "ePaperclip agent containers", expire: 0 });
    const value = made?.value;
    if (!value) throw new StepError("Proxmox created the token but didn't return its secret");
    this.addSecret(value);
    try {
      this.d.state.setSecret("agentContainers.apiToken", `${TOKEN_ID}=${value}`);
    } catch (e) {
      await pve.call("DELETE", `/access/users/${encodeURIComponent(SANDBOX_USER)}/token/${TOKEN_NAME}`).catch(() => {});
      throw new StepError(`The token's secret couldn't be saved in the vault, so the token was removed: ${errText(e)}`);
    }
    this.log(job, "info", `Created API token ${TOKEN_ID} (privilege separated; its secret is in the vault)`);
    return "Created";
  }

  private stepKey(job: JobView): string {
    if (this.sshKey() && this.stored().publicKey) {
      this.addSecret(this.sshKey());
      this.log(job, "info", "SSH key already exists");
      return "Reused";
    }
    const k = generateSshKey();
    this.addSecret(k.privateKey, ...k.privateKey.split("\n").filter((l) => l.length > 20));
    this.d.state.setSecret("agentContainers.sshKey", k.privateKey);
    this.save({ publicKey: k.publicKey });
    this.log(job, "info", "Generated an ed25519 SSH key (private half in the vault)");
    return "Created";
  }

  private async guests(pve: ProxmoxClient): Promise<Guest[]> {
    return (await pve.clusterResources()) as Guest[];
  }

  /** The architecture Proxmox unpacked, from the create task's own log ("Detected container architecture: arm64"). */
  private async detectedArch(pve: ProxmoxClient, upid: string): Promise<HostArch | null> {
    const lines = await pve.taskLog(this.d.node, upid, 1000).catch(() => []);
    for (const l of lines) {
      const m = /Detected container architecture:\s*(amd64|arm64)/i.exec(l.t);
      if (m) return m[1].toLowerCase() as HostArch;
    }
    return null;
  }

  private versions(): Record<string, string> {
    const text = readFileSync(join(this.pluginDir, "template", "versions.sh"), "utf8");
    const out: Record<string, string> = {};
    for (const m of text.matchAll(/^([A-Z0-9_]+)="([^"\n]*)"$/gm)) out[m[1]] = m[2];
    for (const k of ["NODE_VERSION", "NODE_SHA256_X64", "NODE_SHA256_ARM64", "CLAUDE_CODE_VERSION", "CODEX_VERSION", "GEMINI_CLI_VERSION", "OPENCODE_VERSION", "MIMO_CLI_VERSION", "PI_VERSION", "GROK_CLI_VERSION", "CLAUDE_AGENT_ACP_VERSION", "CODEX_ACP_VERSION"]) if (!out[k]) throw new StepError(`versions.sh doesn't define ${k}`);
    return out;
  }

  private async stepTemplate(job: JobView, pve: ProxmoxClient, p: Params): Promise<string> {
    const node = this.d.node;
    const arch = this.arch();
    if (!arch) throw new StepError("This host's processor architecture couldn't be determined, so ePaperclip can't pick a matching container template. Run the setup from the Proxmox node itself.");
    const st = this.stored();
    if ((st.templateAttempts ?? 0) >= 3 && !this.force) {
      throw new StepError(`Building the template has failed ${st.templateAttempts} times in a row${st.lastTemplateError ? ` (last: ${st.lastTemplateError})` : ""}. Fix the cause shown above, then press "Try the template again" so ePaperclip knows it is safe to retry.`);
    }
    const pub = st.publicKey;
    const key = this.sshKey();
    if (!pub || !key || !/^ssh-ed25519 [A-Za-z0-9+/=]+( [\w.-]+)?$/.test(pub)) throw new StepError("The SSH key is missing; run the setup again");
    let vmid = st.templateVmid;
    let guests = await this.guests(pve);
    let g = vmid !== undefined ? guests.find((x) => x.vmid === vmid) : undefined;
    if (g && g.type === "lxc" && g.template === 1 && hasTag(g.tags, TEMPLATE_TAG)) {
      if (st.templateArch && st.templateArch !== arch) {
        this.log(job, "warn", `Template ${vmid} was built for ${st.templateArch}, but this host is ${arch}; removing it and building the matching one`);
        await this.destroy(pve, vmid!);
        g = undefined;
      } else {
        this.log(job, "info", `Template ${vmid} already exists${st.templateArch ? ` (built for ${st.templateArch})` : ""}`);
        this.save({ templateAttempts: 0, lastTemplateError: undefined }); // a usable template ends the failure streak
        return `Template ${vmid}`;
      }
    }
    if (g && g.type === "lxc" && hasTag(g.tags, TEMPLATE_TAG) && g.template !== 1) {
      this.log(job, "warn", `Container ${vmid} is an unfinished template build from an earlier run; removing it`);
      await this.destroy(pve, vmid!);
      guests = await this.guests(pve);
    } else if (g) {
      // The id now belongs to something that isn't ours. Never touch it.
      vmid = undefined;
    }
    if (vmid === undefined) {
      vmid = await pve.nextId();
      this.save({ templateVmid: vmid });
    }
    // 1. The Debian base template for this host's processor. A catalog can list both architectures; picking by version
    // alone is what unpacked an arm64 template on an amd64 host and made the container's init die.
    const catalog = await pve.templateCatalog(node);
    const file = newestDebian(catalog.map((c) => c.template), arch);
    if (!file) {
      const all = catalog.map((c) => c.template).filter((t) => /^debian-\d+-standard_/.test(t));
      throw new StepError(`Proxmox's template catalog has no Debian standard template for this ${arch} host${all.length ? ` (it lists: ${all.slice(0, 4).join(", ")})` : ""}. Run 'pveam update' on the host (or check its internet access), then try again.`);
    }
    this.log(job, "info", `Using ${arch} template ${file}`);
    const volid = `${p.templateStorage}:vztmpl/${file}`;
    await this.ensureBaseTemplate(job, pve, p, file, volid, catalog.find((c) => c.template === file)?.sha512sum, false);
    // 2. An unprivileged container from it, with our key. nesting and keyctl are what systemd (Debian 13 has 257) needs
    // inside an unprivileged container.
    this.log(job, "info", `Creating unprivileged container ${vmid}`);
    let created = false;
    try {
      // Proxmox lets only root@pam set features other than nesting, so another administrator's request for keyctl is refused.
      let features = "nesting=1,keyctl=1";
      const create = async () => {
        const spec = {
          vmid,
          ostemplate: volid,
          hostname: TEMPLATE_HOSTNAME,
          unprivileged: true,
          features,
          ostype: "debian",
          cores: 2,
          memory: 2048,
          swap: 512,
          rootfs: `${p.storage}:${TEMPLATE_DISK_GB}`,
          net0: `name=eth0,bridge=${p.bridge},ip=dhcp`,
          onboot: false,
          start: false,
          tags: `${TAG};${TEMPLATE_TAG}`,
          "ssh-public-keys": pub,
          description: "Agent template for the ePaperclip Proxmox sandbox provider. Built by ePaperclip's guided setup.",
        };
        let upid: string;
        try {
          upid = await pve.createLxc(node, spec);
        } catch (e) {
          if (!/only allowed for root@pam/.test(String((e as Error).message))) throw e;
          this.log(job, "warn", "Proxmox lets only root@pam set keyctl; creating the container with nesting=1 only");
          features = "nesting=1";
          upid = await pve.createLxc(node, { ...spec, features });
        }
        await this.task(pve, upid, "Creating the container", 600_000, { vmid });
        // Proxmox records the template's own architecture in this task's log. Verify it rather than trusting the name.
        const unpacked = await this.detectedArch(pve, upid);
        if (unpacked) this.save({ templateArch: unpacked });
        if (unpacked && unpacked !== arch) throw new StepError(`Proxmox unpacked a template for ${unpacked}, but this host is ${arch}. ePaperclip removes it; run setup again to build from the ${arch} template.`);
        // A create can succeed with the features we asked for; confirm they are on the container, since systemd 257 needs
        // nesting (and keyctl for its session keyring).
        const cfg = await pve.lxcConfig(node, vmid).catch(() => ({}) as Record<string, string | number | undefined>);
        if (!String(cfg.features ?? "").includes("nesting")) {
          this.log(job, "warn", `Proxmox created ${vmid} without nesting; setting ${features}`);
          await pve.setLxcConfig(node, vmid, { features });
        }
        return upid;
      };
      try {
        await create();
      } catch (e) {
        // A damaged base template (an interrupted earlier download) is replaced once, automatically.
        if (!(e instanceof DiagError) || e.diagnosis.id !== "template-corrupt") throw e;
        this.log(job, "warn", `${file} looks damaged; removing it and downloading it again`);
        await this.destroy(pve, vmid).catch(() => {});
        await this.ensureBaseTemplate(job, pve, p, file, volid, catalog.find((c) => c.template === file)?.sha512sum, true);
        await create();
      }
      created = true;
      await this.startWithProbe(job, pve, vmid);
      const ip = await this.waitIp(job, pve, vmid);
      const target = { host: ip, user: "root", privateKey: key };
      this.log(job, "info", `Container is up at ${ip}; waiting for SSH`);
      let ok = false;
      let why = "";
      for (let i = 0; i < 40 && !ok; i++) {
        const r = await this.ssh.probe(target, 15_000);
        ok = r.ok;
        why = r.error ?? "";
        if (!ok) await this.pace(3000);
      }
      if (!ok) throw new StepError(`SSH to the container never became available${why ? ` (${why})` : ""}`);
      this.log(job, "info", "Provisioning the container (packages, Node.js, agent tools); this takes several minutes");
      const v = this.versions();
      const script = [
        "set -e",
        ...Object.entries({ ...v, AGENT_USER }).map(([k, val]) => `export ${k}='${val}'`),
        `umask 077; printf '%s\\n' '${pub}' > /root/engine_key.pub`,
        readFileSync(join(this.pluginDir, "template", "provision.sh"), "utf8"),
      ].join("\n");
      const r = await this.ssh.run(target, script, (line) => this.log(job, "info", line), 40 * 60_000);
      if (r.timedOut) throw new StepError("Provisioning took too long and was stopped");
      if (r.exitCode !== 0) throw new StepError(`Provisioning failed (exit ${r.exitCode ?? "none"}); see the log above`);
      // 3. Stop it and make it a template.
      this.log(job, "info", "Shutting the container down");
      await this.task(pve, await pve.call<string>("POST", `/nodes/${node}/lxc/${vmid}/status/shutdown`, { timeout: 60, forceStop: true }), "Shutting the container down", 180_000);
      const cfg = await pve.lxcConfig(node, vmid);
      if (Number(cfg.unprivileged) !== 1) throw new StepError("The template container isn't unprivileged; refusing to use it");
      await this.task(pve, await pve.convertToTemplate(node, "lxc", vmid), "Converting to a template");
      let done = await pve.lxcConfig(node, vmid);
      // Observed on the physical host: the task had finished and the template flag was set, yet this first read missed it.
      for (let i = 0; i < 10 && Number(done.template) !== 1; i++) {
        await this.pace(1000);
        done = await pve.lxcConfig(node, vmid);
      }
      if (Number(done.template) !== 1) throw new StepError("Proxmox didn't mark the container as a template");
      this.log(job, "info", `Template ${vmid} is ready`);
      this.save({ templateAttempts: 0, lastTemplateError: undefined });
      // Proxmox's cluster-resource view can lag the conversion task by a moment. Grant the template's own right
      // directly, then let stepGrant verify everything (and add anything else that is missing). Without this, setup
      // finished with the template built but `/vms/<id>` still missing, leaving the UI "Partly set up".
      for (const who of ["user", "token"] as const) await this.setAcl(pve, `/vms/${vmid}`, "EPCSandboxTemplate", who);
      await this.stepGrant(job, pve, p);
      return `Template ${vmid}`;
    } catch (e) {
      if (created) {
        this.log(job, "warn", `Removing the half-made container ${vmid}`);
        await this.destroy(pve, vmid).catch((x) => this.log(job, "warn", `Couldn't remove container ${vmid}: ${errText(x)}`));
      }
      throw e;
    }
  }

  /**
   * Makes sure the Debian base template is in the template storage. Proxmox itself checks a download against the sha512
   * from its catalog and deletes a file that doesn't match; a file that was already there is only checked for a plausible
   * size (a cut-off download is a few kilobytes), and a damaged one is caught when the container is created.
   */
  private async ensureBaseTemplate(job: JobView, pve: ProxmoxClient, p: Params, file: string, volid: string, sha512: string | undefined, force: boolean) {
    const node = this.d.node;
    const MIN = 20 * 1024 * 1024;
    const have = async () => (await pve.storageContent(node, p.templateStorage, "vztmpl")).find((x) => x.volid === volid);
    let cur = await have();
    if (cur && (force || (typeof cur.size === "number" && cur.size < MIN))) {
      this.log(job, "warn", `${file} in ${p.templateStorage} ${force ? "is being replaced" : `is only ${cur.size} bytes, so it was cut off`}; removing it`);
      await this.task(pve, await pve.deleteVolume(node, p.templateStorage, volid), "Removing the damaged template", 120_000);
      cur = await have();
      if (cur) throw new StepError(`${volid} is damaged and Proxmox wouldn't remove it. Remove it on the host: pveam remove ${volid}`);
    }
    if (cur) {
      this.log(job, "info", `Using ${file} already in ${p.templateStorage}`);
      return;
    }
    this.log(job, "info", `Downloading ${file} to ${p.templateStorage}${sha512 ? ` (Proxmox checks it against sha512 ${sha512.slice(0, 12)}…)` : ""}`);
    await this.task(pve, await pve.downloadTemplate(node, p.templateStorage, file), "The template download", 900_000);
    cur = await have();
    if (!cur) throw new StepError(`${file} didn't appear in ${p.templateStorage} after the download`);
    if (typeof cur.size === "number" && cur.size < MIN) throw new StepError(`${file} is only ${cur.size} bytes after the download; the storage may be full or the download was cut off. Check 'df -h' for ${p.templateStorage} and try again.`);
    this.log(job, "info", `Downloaded ${file}${typeof cur.size === "number" ? ` (${(cur.size / 1024 ** 2).toFixed(0)} MiB)` : ""}`);
  }

  /**
   * Starts the template container. If it fails with a cause the logs don't explain, it is started once more without its
   * features (the container is ours and throwaway) to learn whether nesting is what the host refuses, then the features
   * are put back and the answer goes into the diagnosis.
   */
  private async startWithProbe(job: JobView, pve: ProxmoxClient, vmid: number) {
    const node = this.d.node;
    try {
      await this.task(pve, await pve.startLxc(node, vmid), "Starting the container", 120_000, { vmid });
    } catch (e) {
      if (!(e instanceof DiagError) || !(e.diagnosis.confidence === "generic" || e.diagnosis.id === "features")) throw e;
      const features = String((await pve.lxcConfig(node, vmid).catch(() => ({}) as Record<string, string | number | undefined>)).features ?? "");
      if (!features) throw e;
      this.log(job, "info", `Trying once without the container features (${features}) to find out whether the host refuses them`);
      let starts = false;
      try {
        await pve.setLxcConfig(node, vmid, { delete: "features" });
        await this.task(pve, await pve.startLxc(node, vmid), "Starting the container without features", 120_000, { diagnose: false });
        starts = true;
        await this.task(pve, await pve.stopLxc(node, vmid), "Stopping the container", 120_000, { diagnose: false }).catch(() => {});
      } catch {
        starts = false;
      } finally {
        await pve.setLxcConfig(node, vmid, { features }).catch(() => {});
      }
      this.log(job, starts ? "warn" : "info", starts ? "It starts without the features: the host refuses them." : "It fails the same way without the features, so they are not the cause.");
      const d = diagnoseLxc({ ...e.input, startsWithoutFeatures: starts });
      this.log(job, "error", `${d.title}. ${d.plain}`);
      for (const f of d.fix) this.log(job, "info", `  Fix: ${f}`);
      throw new DiagError(this.clean(`Starting the container failed. ${summarizeDiagnosis(d)}`), d, { ...e.input, startsWithoutFeatures: starts }, e.what);
    }
  }

  private async waitIp(job: JobView, pve: ProxmoxClient, vmid: number): Promise<string> {
    for (let i = 0; i < 60; i++) {
      const ifs = await pve.lxcInterfaces(this.d.node, vmid).catch(() => []);
      for (const f of ifs) {
        const m = /^(\d+\.\d+\.\d+\.\d+)\//.exec(f.inet ?? "");
        if (f.name !== "lo" && m && !m[1].startsWith("127.")) return m[1];
      }
      await this.pace(3000);
    }
    throw new StepError("The container never got an IPv4 address. Does the bridge have a DHCP server?");
  }

  /** Destroys a container only if it is ours (tagged as an agent template). */
  private async destroy(pve: ProxmoxClient, vmid: number) {
    const g = (await this.guests(pve)).find((x) => x.vmid === vmid);
    if (!g) return;
    if (g.type !== "lxc" || !hasTag(g.tags, TEMPLATE_TAG)) throw new StepError(`Container ${vmid} isn't one ePaperclip made; leaving it alone`);
    if (g.status === "running") await this.task(pve, await pve.stopLxc(this.d.node, vmid), "Stopping the container", 120_000).catch(() => {});
    await this.task(pve, await pve.destroyGuest(this.d.node, "lxc", vmid), "Removing the container", 300_000);
  }

  /** One grant, for the sandbox user or for its token. */
  private async setAcl(pve: ProxmoxClient, path: string, role: string, who: "user" | "token") {
    await pve.call("PUT", "/access/acl", { path, roles: role, ...(who === "user" ? { users: SANDBOX_USER } : { tokens: TOKEN_ID }), propagate: true });
  }

  private async removeAcl(pve: ProxmoxClient, path: string, role: string) {
    for (const who of ["user", "token"] as const) await pve.call("PUT", "/access/acl", { path, roles: role, ...(who === "user" ? { users: SANDBOX_USER } : { tokens: TOKEN_ID }), propagate: true, delete: true });
  }

  /** Which of the privileges a role holds Proxmox does not give this user or token on this path; null if Proxmox can't say. */
  private async lackingPrivs(pve: ProxmoxClient, path: string, role: string, id: string): Promise<string[] | null> {
    try {
      const have = await pve.effectivePrivileges(path, id);
      return (ROLES[role] ?? []).filter((x) => !have[x]);
    } catch {
      return null;
    }
  }

  /**
   * Exactly which grants are missing: for each wanted path and role, for the user and for the token. A grant counts as
   * present when its entry exists (and, on a pool, reaches the pool's members), or when Proxmox says the rights are
   * effective anyway (given through a group or a parent path). `strict` asks Proxmox for the effective rights even when
   * the entry exists, which is how a fresh grant is verified. Rights on the pool propagate, so containers created later
   * (new vmids) are covered; the template is the only single guest with its own entry.
   */
  private async grantGaps(pve: ProxmoxClient, p: Params, templateReady: boolean, strict = false): Promise<{ gaps: GrantGap[] }> {
    const [pools, acls] = await Promise.all([pve.pools(), pve.call<{ path: string; ugid: string; type: string; roleid: string; propagate?: number }[]>("GET", "/access/acl")]);
    const vmid = templateReady ? this.stored().templateVmid : undefined;
    const want = this.wantedAcls(p, vmid).filter(([path]) => {
      const pool = /^\/pool\/(.+)$/.exec(path)?.[1];
      return !pool || pools.some((x) => x.poolid === pool);
    });
    const gaps: GrantGap[] = [];
    for (const [path, role] of want) {
      for (const [who, id] of [["user", SANDBOX_USER], ["token", TOKEN_ID]] as const) {
        const hit = acls.find((a) => a.path === path && a.roleid === role && a.ugid === id && a.type === who);
        const reaches = hit && (!path.startsWith("/pool/") || hit.propagate !== 0);
        if (reaches && !strict) continue;
        if (hit && !reaches) {
          gaps.push({ path, role, who, why: "not-inherited" });
          continue;
        }
        const lacking = await this.lackingPrivs(pve, path, role, id);
        if (lacking === null ? reaches : lacking.length === 0) continue;
        gaps.push({ path, role, who, why: hit ? "ineffective" : "absent", ...(hit && lacking?.length ? { lacking } : {}) });
      }
    }
    return { gaps };
  }

  private async templateReady(pve: ProxmoxClient): Promise<boolean> {
    const vmid = this.stored().templateVmid;
    const g = vmid !== undefined ? (await this.guests(pve)).find((x) => x.vmid === vmid) : undefined;
    return Boolean(g && g.template === 1 && hasTag(g.tags, TEMPLATE_TAG));
  }

  private async stepGrant(job: JobView, pve: ProxmoxClient, p: Params): Promise<string> {
    const ready = await this.templateReady(pve);
    const { gaps } = await this.grantGaps(pve, p, ready);
    for (const g of gaps) {
      await this.setAcl(pve, g.path, g.role, g.who);
      this.log(job, "info", `Granted ${g.role} on ${g.path} to the ${g.who === "user" ? SANDBOX_USER : TOKEN_ID}`);
    }
    // Verify with what Proxmox will really allow, not only that the entries exist. A privilege-separated token gets the overlap of its own and its user's rights.
    const after = await this.grantGaps(pve, p, ready, true);
    if (after.gaps.length) throw new StepError(`Proxmox still doesn't give the token these rights: ${describeGaps(after.gaps)}. Check that the signed-in account may change permissions (Permissions.Modify on /), and that no role was edited.`);
    this.log(job, "info", gaps.length ? `Granted ${gaps.length} missing right${gaps.length === 1 ? "" : "s"} and checked them in Proxmox${ready ? "" : "; the template's own right follows once it is built"}` : `All rights were already in place${ready ? "" : "; the template's own right follows once it is built"}`);
    return gaps.length ? `${gaps.length} granted` : "In place";
  }

  private async stepPlugin(job: JobView): Promise<string> {
    const list = await this.eng<{ id: string; pluginKey: string; status: string; lastError?: string | null }[]>("GET", "/api/plugins");
    let pl = list.find((x) => x.pluginKey === PLUGIN_KEY);
    if (pl?.status === "ready") {
      this.save({ pluginId: pl.id });
      this.log(job, "info", "The provider is already installed and ready");
      return "Already installed";
    }
    if (pl && pl.status === "disabled") {
      pl = await this.eng("POST", `/api/plugins/${encodeURIComponent(pl.id)}/enable`, {});
    }
    if (!pl || pl.status !== "ready") {
      this.log(job, "info", `Installing the provider from ${this.pluginDir}`);
      pl = await this.eng("POST", "/api/plugins/install", { packageName: this.pluginDir, isLocalPath: true });
    }
    if (!pl || pl.status !== "ready") throw new StepError(`The engine installed the provider but it isn't ready (${pl?.status ?? "unknown"}${pl?.lastError ? `: ${pl.lastError}` : ""})`);
    this.save({ pluginId: pl.id });
    this.log(job, "info", "The provider is installed and ready");
    return "Installed";
  }

  private async stepEnvironments(job: JobView, p: Params): Promise<string> {
    const cos = await this.companies();
    const warnings: string[] = [];
    for (const c of cos) warnings.push(...(await this.ensureOrg(c.id, c.name, p, job)));
    for (const w of warnings) this.log(job, "warn", w);
    return cos.length ? `${cos.length} organization${cos.length === 1 ? "" : "s"}` : "No organizations yet";
  }

  // ---- per-organization environments

  /** Makes sure the organization's secrets and environment exist and match, and its agents default to it. */
  private async ensureOrg(companyId: string, name: string, p: Params, job?: JobView): Promise<string[]> {
    const warnings: string[] = [];
    // No resource group, no container environment. An organization uses only the Proxmox pool allocated to it; handing it
    // the shared agent pool would present a shared boundary as an isolated one.
    if (!this.pools()[companyId]) {
      return [`${name}: no resource group yet, so its agents have no container environment. Create one in the organization's settings (Resources); ePaperclip then gives that pool the sandbox rights and points the organization's agents at it.`];
    }
    const st = this.stored();
    const token = this.tokenSecret();
    const key = this.sshKey();
    if (!token || !key || st.templateVmid === undefined) throw new StepError("Agent containers aren't set up yet");
    const bare = token.slice(token.indexOf("=") + 1);
    this.addSecret(bare, token, key);
    const cid = encodeURIComponent(companyId);
    await this.ensureMember(companyId);
    // Secrets: created once per organization and rotated when the value changes. Environments reference them by id.
    const secrets = { ...(st.secrets ?? {}) };
    let sec = secrets[companyId];
    const ensureSecret = async (existingId: string | undefined, oldFp: string | undefined, value: string, label: string): Promise<{ id: string; fp: string }> => {
      const f = fp(value);
      if (existingId) {
        if (oldFp === f) return { id: existingId, fp: f };
        await this.eng("POST", `/api/secrets/${encodeURIComponent(existingId)}/rotate`, { value });
        return { id: existingId, fp: f };
      }
      const made = await this.eng<{ id: string }>("POST", `/api/companies/${cid}/secrets`, { name: `epaperclip-agent-containers-${label}-${randomBytes(3).toString("hex")}`, value, description: "Created by ePaperclip's agent containers setup" });
      return { id: made.id, fp: f };
    };
    const t = await ensureSecret(sec?.tokenSecretId, sec?.tokenFp, bare, "token");
    const k = await ensureSecret(sec?.keySecretId, sec?.keyFp, key, "ssh-key");
    sec = { tokenSecretId: t.id, tokenFp: t.fp, keySecretId: k.id, keyFp: k.fp };
    secrets[companyId] = sec;
    this.save({ secrets });

    const cfg = this.envConfig(companyId, p, st.templateVmid, sec, this.limits(companyId, p))!;
    const envs = await this.engineEnvs(companyId);
    let env = envs.find((e) => this.ours(e) === companyId);
    const label = `Agent containers (${name.slice(0, 60)})`;
    if (!env) {
      const taken = new Set(envs.map((e) => e.name));
      const envName = taken.has(label) ? `${label} ${companyId.slice(0, 8)}` : label;
      env = await this.eng<EngineEnv>("POST", `/api/companies/${cid}/environments`, { name: envName, description: "Runs this organization's agents in unprivileged Proxmox containers. Managed by ePaperclip.", driver: "sandbox", status: "active", config: cfg, metadata: { epaperclip: "agent-containers", companyId } });
      this.log2(job, `Created environment "${env.name}"`);
    } else if (env.status !== "active" || !Object.entries(cfg).every(([k2, v]) => (env!.config ?? {})[k2] === v)) {
      env = await this.eng<EngineEnv>("PATCH", `/api/environments/${encodeURIComponent(env.id)}`, { config: cfg, status: "active" });
      this.log2(job, `Updated environment "${env.name}"`);
    }
    this.save({ environments: { ...(this.stored().environments ?? {}), [companyId]: { environmentId: env.id } } });

    // The organization's agents default to it, unless someone chose a different non-local environment on purpose.
    const agents = await this.eng<{ id: string; name: string; status?: string; adapterType?: string; adapterConfig?: Record<string, unknown> | null; defaultEnvironmentId?: string | null }[]>("GET", `/api/companies/${cid}/agents`).catch(() => []);
    const known = new Map(envs.map((e) => [e.id, e]));
    // Pin's own identity in this organization is only a subject for tool policy (src/pin-apps.ts). It never runs, so it must
    // not be given the organization's container environment, which would let a wake-up allocate a container for it.
    const pinIdentity = (this.d.state.getSetting<Record<string, string>>("pin.appIdentities") ?? {})[companyId];
    for (const a of agents) {
      if (a.status === "terminated" || a.id === pinIdentity) continue;
      // Paperclip's default lane for these harnesses is ACP, which over ssh polls the container about ten times a second.
      // The direct command-line lane needs no bridge and is quiet, so an agent that has not chosen a lane gets it. A chosen
      // lane (including "acp") is never touched.
      if (a.adapterType && CLI_LANE.has(a.adapterType) && a.adapterConfig?.engine === undefined) {
        try {
          await this.eng("PATCH", `/api/agents/${encodeURIComponent(a.id)}`, { adapterConfig: { ...(a.adapterConfig ?? {}), engine: "cli" } });
        } catch (e) {
          warnings.push(`${name}: couldn't set ${a.name}'s engine: ${errText(e)}`);
        }
      }
      if (a.defaultEnvironmentId === env.id) continue;
      const cur = a.defaultEnvironmentId ? known.get(a.defaultEnvironmentId) : undefined;
      // No default, or one that points at the (hidden) local environment, is replaced. A deliberate other choice stays.
      if (a.defaultEnvironmentId && cur && cur.driver !== "local" && !this.ours(cur)) continue;
      try {
        await this.eng("PATCH", `/api/agents/${encodeURIComponent(a.id)}`, { defaultEnvironmentId: env.id });
      } catch (e) {
        warnings.push(`${name}: couldn't set ${a.name}'s environment: ${errText(e)}`);
      }
    }
    return warnings;
  }
  /**
   * The engine lets an instance admin read and manage an organization's secrets and agents only through a membership in
   * it. So the service account joins each organization (an invitation, accepted as itself) the first time it needs to.
   */
  private async ensureMember(companyId: string) {
    const me = await this.eng<{ companyIds?: string[]; memberships?: { companyId: string; status: string }[] }>("GET", "/api/cli-auth/me");
    if ((me.companyIds ?? []).includes(companyId) || (me.memberships ?? []).some((m) => m.companyId === companyId && m.status === "active")) return;
    if (!this.actor) throw new StepError("The service account isn't a member of this organization yet, and adding it needs an organization owner or a Proxmox administrator signed in. Open Agent containers in the console and press Set up again.");
    const invite = (await this.actor("POST", `/api/companies/${encodeURIComponent(companyId)}/invites`, { allowedJoinTypes: "human", humanRole: "admin" })) as { token?: string };
    if (!invite?.token) throw new StepError("The engine didn't return an invitation for the service account");
    await this.eng("POST", `/api/invites/${encodeURIComponent(invite.token)}/accept`, { requestType: "human" });
  }

  private log2(job: JobView | undefined, text: string) {
    if (job) this.log(job, "info", text);
  }

  /** Engine-side reconciliation for every organization (new ones, new agents, resized groups). Needs no Proxmox session. */
  async reconcile(actor: EngineActor | null = null): Promise<string[]> {
    if (!this.d.gateway || this.stored().lastState !== "ready" || this.job?.status === "running") return [];
    if (this.reconciling) {
      await this.reconciling;
      return [];
    }
    const out: string[] = [];
    this.reconciling = (async () => {
      this.actor = actor;
      try {
        const p = this.params();
        for (const c of await this.companies()) {
          try {
            out.push(...(await this.ensureOrg(c.id, c.name, p)));
          } catch (e) {
            out.push(`${c.name}: ${errText(e)}`);
          }
        }
      } catch (e) {
        out.push(errText(e));
      } finally {
        this.scrub = new Set();
        this.actor = null;
      }
    })().finally(() => (this.reconciling = null));
    await this.reconciling;
    return out;
  }

  /** A resource group was created or resized: give the pool its rights (as the person who made it) and update the environment. */
  async onResourceGroup(pve: ProxmoxClient, companyId: string, actor: EngineActor | null = null): Promise<string[]> {
    if (this.stored().lastState !== "ready" && !this.stored().templateVmid) return [];
    const warnings: string[] = [];
    const pool = this.pools()[companyId]?.pool;
    if (pool) {
      try {
        for (const who of ["user", "token"] as const) await this.setAcl(pve, `/pool/${pool}`, "EPCSandbox", who);
      } catch (e) {
        warnings.push(`Agent containers can't use the pool ${pool} until a Proxmox administrator re-runs the agent containers setup (${errText(e)}).`);
      }
    }
    this.actor = actor;
    try {
      const c = (await this.companies()).find((x) => x.id === companyId);
      if (c) warnings.push(...(await this.ensureOrg(companyId, c.name, this.params())));
    } catch (e) {
      warnings.push(`The agent containers environment wasn't updated: ${errText(e)}`);
    } finally {
      this.scrub = new Set();
      this.actor = null;
    }
    return warnings;
  }

  // ---- teardown

  async startTeardown(getPve: () => Promise<ProxmoxClient>, who: string, confirm: unknown): Promise<{ jobId: string }> {
    if (confirm !== CONFIRM_PHRASE) throw new HttpError(400, "confirm_required", `Type "${CONFIRM_PHRASE}" to confirm`);
    if (this.job?.status === "running") throw new HttpError(409, "job_running", "Another agent containers job is running");
    await this.assertEngineReady();
    const job = this.newJob("teardown", who, [{ id: "teardown", label: "Remove what agent containers created" }]);
    this.job = job;
    void this.runTeardown(job, getPve).catch((e) => this.fail(job, e));
    return { jobId: job.id };
  }

  private async runTeardown(job: JobView, getPve: () => Promise<ProxmoxClient>) {
    const pve = await getPve();
    const st = this.stored();
    job.steps[0].state = "running";
    const token = this.tokenSecret();
    this.addSecret(token, token?.slice(token.indexOf("=") + 1), this.sshKey());
    // Engine: agents stop pointing at our environments, then the environments, secrets and provider go.
    const envIds = new Map<string, string>(Object.entries(st.environments ?? {}).map(([c, e]) => [e.environmentId, c]));
    for (const c of await this.companies()) {
      for (const e of await this.engineEnvs(c.id)) if (this.ours(e)) envIds.set(e.id, this.ours(e)!);
      const agents = await this.eng<{ id: string; defaultEnvironmentId?: string | null }[]>("GET", `/api/companies/${encodeURIComponent(c.id)}/agents`).catch(() => []);
      for (const a of agents) if (a.defaultEnvironmentId && envIds.has(a.defaultEnvironmentId)) await this.eng("PATCH", `/api/agents/${encodeURIComponent(a.id)}`, { defaultEnvironmentId: null }).catch((e) => this.log(job, "warn", `Couldn't reset an agent's environment: ${errText(e)}`));
    }
    for (const id of envIds.keys()) {
      await this.eng("DELETE", `/api/environments/${encodeURIComponent(id)}`).then(
        () => this.log(job, "info", "Removed an environment"),
        (e) => this.log(job, "warn", `Couldn't remove an environment: ${errText(e)}`),
      );
    }
    for (const s of Object.values(st.secrets ?? {})) {
      for (const id of [s.tokenSecretId, s.keySecretId]) await this.eng("DELETE", `/api/secrets/${encodeURIComponent(id)}`).catch((e) => this.log(job, "warn", `Couldn't remove a secret: ${errText(e)}`));
    }
    if (st.pluginId) await this.eng("DELETE", `/api/plugins/${encodeURIComponent(st.pluginId)}`).then(() => this.log(job, "info", "Uninstalled the provider"), (e) => this.log(job, "warn", `Couldn't uninstall the provider: ${errText(e)}`));
    // Proxmox: rights, token, user, roles, our template, and the pool if we made it and it is empty.
    const p = this.params();
    for (const [path, role] of this.wantedAcls(p, st.templateVmid)) await this.removeAcl(pve, path, role).catch(() => {});
    await pve.call("DELETE", `/access/users/${encodeURIComponent(SANDBOX_USER)}/token/${TOKEN_NAME}`).then(() => this.log(job, "info", `Removed token ${TOKEN_ID}`), () => {});
    await pve.call("DELETE", `/access/users/${encodeURIComponent(SANDBOX_USER)}`).then(() => this.log(job, "info", `Removed user ${SANDBOX_USER}`), (e) => this.log(job, "warn", `Couldn't remove ${SANDBOX_USER}: ${errText(e)}`));
    for (const name of Object.keys(ROLES)) await pve.call("DELETE", `/access/roles/${name}`).then(() => this.log(job, "info", `Removed role ${name}`), () => {});
    if (st.templateVmid !== undefined) {
      await this.destroy(pve, st.templateVmid).then(() => this.log(job, "info", `Removed template ${st.templateVmid}`), (e) => this.log(job, "warn", `Couldn't remove template ${st.templateVmid}: ${errText(e)}`));
    }
    if (st.poolCreated) {
      const info = await pve.call<{ members?: unknown[] }>("GET", `/pools/${encodeURIComponent(p.pool)}`).catch(() => null);
      if (info && !(info.members ?? []).length) await pve.call("DELETE", `/pools/${encodeURIComponent(p.pool)}`).then(() => this.log(job, "info", `Removed pool ${p.pool}`), () => {});
    }
    this.d.state.deleteSecret("agentContainers.apiToken");
    this.d.state.deleteSecret("agentContainers.sshKey");
    this.d.state.setSetting("agentContainers", undefined);
    this.log(job, "info", "Agents stay blocked from running on the host. Set agent containers up again to run them.");
    job.steps[0].state = "done";
    job.status = "done";
    job.finishedAt = this.now();
    this.scrub = new Set();
    this.save({ lastJob: { ...job, log: job.log.slice(-200) }, lastState: "not_set_up" });
  }
}
