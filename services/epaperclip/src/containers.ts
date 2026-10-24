import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
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
  { id: "template", label: "Build the agent container template" },
  { id: "grant", label: "Give the token rights on the pool, template, storage and bridge" },
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
  publicKey?: string;
  pluginId?: string;
  poolCreated?: boolean;
  environments?: Record<string, { environmentId: string }>;
  secrets?: Record<string, OrgSecrets>;
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

/** A call to the engine as a person who can manage the organization (the signed-in administrator). */
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
  const known = new Set(["storage", "bridge", "pool", "templateStorage", "size"]);
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

/** The newest debian-NN-standard template in a catalog. */
export function newestDebian(files: string[]): string | null {
  const re = /^debian-(\d+)-standard_([\w.+~-]+?)_(amd64|arm64)\.tar\.(zst|gz|xz)$/;
  const ver = (f: string) => {
    const m = re.exec(f)!;
    return [Number(m[1]), ...m[2].split(/[.-]/).map((x) => Number(x) || 0)];
  };
  const list = files.filter((f) => re.test(f));
  list.sort((a, b) => {
    const x = ver(a);
    const y = ver(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
  return list[0] ?? null;
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
}

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
  private pools(): Record<string, { pool: string }> {
    return this.d.state.getSetting<Record<string, { pool: string }>>("resourceGroups") ?? {};
  }
  private poolFor(companyId: string, p: Params) {
    return this.pools()[companyId]?.pool ?? p.pool;
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
    let template: { vmid?: number; name?: string; exists: boolean } = { exists: false };
    let tokenExists = false;
    let pluginInstalled = false;
    const environments: { companyId: string; environmentId: string; ok: boolean }[] = [];
    const tokenSecret = this.tokenSecret();
    try {
      const [roles, acls, guests] = await Promise.all([
        pve.call<{ roleid: string; privs?: string }[]>("GET", "/access/roles"),
        pve.call<{ path: string; ugid: string; type: string; roleid: string }[]>("GET", "/access/acl").catch(() => []),
        pve.clusterResources(),
      ]);
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
      template = { vmid, name: g ? TEMPLATE_HOSTNAME : undefined, exists: Boolean(g && g.template === 1 && hasTag(g.tags, TEMPLATE_TAG)) };
      set("template", template.exists, vmid && !template.exists ? "The template isn't there" : undefined);

      // Rights: for the user and for the token, on each path.
      const want = this.wantedAcls(p, vmid);
      const missing: string[] = [];
      for (const [path, role] of want) {
        for (const [type, id] of [["user", SANDBOX_USER], ["token", TOKEN_ID]] as const) {
          if (!acls.some((a) => a.path === path && a.roleid === role && a.ugid === id && a.type === type)) missing.push(`${path} (${type})`);
        }
      }
      set("grant", vmid !== undefined && missing.length === 0, missing.length ? `Missing: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? "…" : ""}` : undefined);
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
      params: st.params ?? null,
      ...(checkError ? { error: checkError } : state === "error" && st.lastJob?.error ? { error: st.lastJob.error } : {}),
    };
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
    const cfg: Record<string, unknown> = {
      provider: "proxmox",
      apiUrl: new URL(this.d.pveUrl).origin,
      node: this.d.node,
      apiTokenId: TOKEN_ID,
      apiTokenSecret: sec.tokenSecretId,
      template: String(vmid),
      pool: this.poolFor(companyId, p),
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
    if (this.d.caPem) cfg.caCert = this.d.caPem.trim();
    return cfg;
  }

  // ---- jobs

  getJob(id: string): JobView | null {
    const j = this.jobs.get(id) ?? (this.stored().lastJob?.id === id ? this.stored().lastJob! : null);
    return j ? JSON.parse(JSON.stringify(j)) : null;
  }

  /** Starts a setup job (or returns the one already running). Checks that need no Proxmox call happen first. */
  async startSetup(getPve: () => Promise<ProxmoxClient>, who: string, over: Partial<Params>, actor: EngineActor | null = null): Promise<{ jobId: string; alreadyRunning: boolean }> {
    if (this.job?.status === "running") return { jobId: this.job.id, alreadyRunning: true };
    await this.assertEngineReady();
    const job = this.newJob("setup", who, JOB_STEPS);
    this.job = job;
    this.actor = actor;
    void this.runSetup(job, getPve, over).catch((e) => this.fail(job, e));
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
    job.finishedAt = this.now();
    this.log(job, "error", msg);
    this.finish(job);
  }

  private finish(job: JobView) {
    this.scrub = new Set();
    this.actor = null;
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

  private async runSetup(job: JobView, getPve: () => Promise<ProxmoxClient>, over: Partial<Params>) {
    const pve = await getPve();
    const params = this.params(over);
    await this.step(job, "check", () => this.check(job, pve, params));
    this.save({ params, createdBy: this.stored().createdBy ?? job.startedBy, createdAt: this.stored().createdAt ?? this.now() });
    await this.step(job, "access", () => this.stepAccess(job, pve, params));
    await this.step(job, "key", async () => this.stepKey(job));
    await this.step(job, "template", () => this.stepTemplate(job, pve, params));
    await this.step(job, "grant", () => this.stepGrant(job, pve, params));
    await this.step(job, "plugin", () => this.stepPlugin(job));
    await this.step(job, "environments", () => this.stepEnvironments(job, params));
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
    const storages = await pve.nodeStorages(node, "rootdir").catch((e) => {
      throw new StepError(`Couldn't list the node's storage: ${errText(e)}`);
    });
    if (!storages.some((s) => s.storage === p.storage)) throw new StepError(`Storage "${p.storage}" can't hold container disks on this node. Choose one of: ${storages.map((s) => s.storage).join(", ") || "(none)"}.`);
    const tpl = await pve.nodeStorages(node, "vztmpl");
    if (!tpl.some((s) => s.storage === p.templateStorage)) throw new StepError(`Storage "${p.templateStorage}" can't hold container templates on this node. Choose one of: ${tpl.map((s) => s.storage).join(", ") || "(none)"}.`);
    const net = await pve.network(node);
    if (!net.interfaces.some((i) => i.iface === p.bridge && /bridge/i.test(i.type))) throw new StepError(`There is no bridge named "${p.bridge}" on this node. Choose one of: ${net.interfaces.filter((i) => /bridge/i.test(i.type)).map((i) => i.iface).join(", ") || "(none)"}.`);
    return "Host looks ready";
  }

  private async task(pve: ProxmoxClient, upid: string | null | undefined, what: string, timeoutMs = 600_000) {
    if (!upid || typeof upid !== "string" || !upid.startsWith("UPID:")) return;
    try {
      await pve.waitTask(this.d.node, upid, { timeoutMs, pollMs: 1000, sleep: (ms) => this.pace(ms) });
    } catch (e) {
      let tail = "";
      try {
        const lines = await pve.taskLog(this.d.node, upid, 500);
        tail = lines.slice(-4).map((l) => l.t).join(" / ");
      } catch {
        /* the log is a courtesy */
      }
      throw new StepError(`${what} failed: ${errText(e)}${tail ? ` (${tail})` : ""}`);
    }
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

  private versions(): Record<string, string> {
    const text = readFileSync(join(this.pluginDir, "template", "versions.sh"), "utf8");
    const out: Record<string, string> = {};
    for (const m of text.matchAll(/^([A-Z0-9_]+)="([^"\n]*)"$/gm)) out[m[1]] = m[2];
    for (const k of ["NODE_VERSION", "NODE_SHA256_X64", "NODE_SHA256_ARM64", "CLAUDE_CODE_VERSION", "CODEX_VERSION", "GEMINI_CLI_VERSION"]) if (!out[k]) throw new StepError(`versions.sh doesn't define ${k}`);
    return out;
  }

  private async stepTemplate(job: JobView, pve: ProxmoxClient, p: Params): Promise<string> {
    const node = this.d.node;
    const pub = this.stored().publicKey;
    const key = this.sshKey();
    if (!pub || !key || !/^ssh-ed25519 [A-Za-z0-9+/=]+( [\w.-]+)?$/.test(pub)) throw new StepError("The SSH key is missing; run the setup again");
    let vmid = this.stored().templateVmid;
    let guests = await this.guests(pve);
    let g = vmid !== undefined ? guests.find((x) => x.vmid === vmid) : undefined;
    if (g && g.type === "lxc" && g.template === 1 && hasTag(g.tags, TEMPLATE_TAG)) {
      this.log(job, "info", `Template ${vmid} already exists`);
      return `Template ${vmid}`;
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
    // 1. The Debian base template.
    const catalog = await pve.templateCatalog(node);
    const file = newestDebian(catalog.map((c) => c.template));
    if (!file) throw new StepError("Proxmox's template catalog has no Debian standard template. Run 'pveam update' on the host (or check its internet access), then try again.");
    const present = await pve.storageContent(node, p.templateStorage, "vztmpl");
    const volid = `${p.templateStorage}:vztmpl/${file}`;
    if (present.some((x) => x.volid === volid)) this.log(job, "info", `Using ${file} already in ${p.templateStorage}`);
    else {
      this.log(job, "info", `Downloading ${file} to ${p.templateStorage}`);
      await this.task(pve, await pve.downloadTemplate(node, p.templateStorage, file), "The template download", 900_000);
      const after = await pve.storageContent(node, p.templateStorage, "vztmpl");
      if (!after.some((x) => x.volid === volid)) throw new StepError(`${file} didn't appear in ${p.templateStorage} after the download`);
    }
    // 2. An unprivileged container from it, with our key.
    this.log(job, "info", `Creating unprivileged container ${vmid}`);
    let created = false;
    try {
      await this.task(
        pve,
        await pve.createLxc(node, {
          vmid,
          ostemplate: volid,
          hostname: TEMPLATE_HOSTNAME,
          unprivileged: true,
          features: "nesting=1",
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
        }),
        "Creating the container",
      );
      created = true;
      await this.task(pve, await pve.startLxc(node, vmid), "Starting the container", 120_000);
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
      const done = await pve.lxcConfig(node, vmid);
      if (Number(done.template) !== 1) throw new StepError("Proxmox didn't mark the container as a template");
      this.log(job, "info", `Template ${vmid} is ready`);
      return `Template ${vmid}`;
    } catch (e) {
      if (created) {
        this.log(job, "warn", `Removing the half-made container ${vmid}`);
        await this.destroy(pve, vmid).catch((x) => this.log(job, "warn", `Couldn't remove container ${vmid}: ${errText(x)}`));
      }
      throw e;
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

  private async setAcl(pve: ProxmoxClient, path: string, role: string, remove = false) {
    await pve.call("PUT", "/access/acl", { path, roles: role, users: SANDBOX_USER, propagate: true, ...(remove ? { delete: true } : {}) });
    await pve.call("PUT", "/access/acl", { path, roles: role, tokens: TOKEN_ID, propagate: true, ...(remove ? { delete: true } : {}) });
  }

  private async stepGrant(job: JobView, pve: ProxmoxClient, p: Params): Promise<string> {
    const pools = await pve.pools();
    const want = this.wantedAcls(p, this.stored().templateVmid);
    let n = 0;
    for (const [path, role] of want) {
      const pool = /^\/pool\/(.+)$/.exec(path)?.[1];
      if (pool && !pools.some((x) => x.poolid === pool)) {
        this.log(job, "warn", `Pool ${pool} doesn't exist in Proxmox; skipped`);
        continue;
      }
      await this.setAcl(pve, path, role);
      n++;
    }
    this.log(job, "info", `Granted ${n} paths to ${SANDBOX_USER} and its token (the token gets only what both have)`);
    return `${n} paths`;
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
    const agents = await this.eng<{ id: string; name: string; status?: string; defaultEnvironmentId?: string | null }[]>("GET", `/api/companies/${cid}/agents`).catch(() => []);
    const known = new Map(envs.map((e) => [e.id, e]));
    for (const a of agents) {
      if (a.status === "terminated" || a.defaultEnvironmentId === env.id) continue;
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
        await this.setAcl(pve, `/pool/${pool}`, "EPCSandbox");
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
    for (const [path, role] of this.wantedAcls(p, st.templateVmid)) await this.setAcl(pve, path, role, true).catch(() => {});
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
