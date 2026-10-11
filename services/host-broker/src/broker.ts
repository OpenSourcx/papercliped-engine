import type { ClusterResource, GuestType, PowerAction, ProxmoxClient, RrdCf, RrdPoint, RrdTimeframe } from "@papercliped-engine/proxmox-client";
import type { BrokerConfig, Principal, Profile, ResourceGroup } from "./config.ts";

/**
 * The broker is the only component that holds the Proxmox token. Everything else asks it.
 *
 * Company agents (group scope) can create, read and destroy containers inside their own resource group, and nothing
 * else. A guest belongs to a group only if it is in the group's pool, inside its vmid range, and carries its tag.
 * Pin (system scope) can also read the whole host and power-manage guests, except protected guests. No caller can
 * destroy a guest outside a resource group. Every call is audited.
 */

export class BrokerError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface Lease {
  id: string;
  group: string;
  vmid: number;
  status: string;
  hostname: string;
  ip: string | null;
  profile: string | null;
  expiresAt: string | null;
  runId: string | null;
}

export interface CreateLeaseRequest {
  profile: string;
  sshPublicKey?: string;
  runId?: string;
  requestedExpiresAt?: string;
}

export type GuestActionName = PowerAction | "snapshot";

export type AuditWriter = (entry: Record<string, unknown>) => void;

export interface BrokerDeps {
  config: BrokerConfig;
  pve: Pick<ProxmoxClient, "version" | "nodeStatus" | "clusterResources" | "checkVmidFree" | "createLxc" | "cloneLxc" | "setLxcConfig" | "lxcConfig" | "lxcInterfaces" | "startLxc" | "destroyLxc" | "guestPower" | "guestSnapshot" | "waitTask" | "guestRrd" | "nodeRrd">;
  audit: AuditWriter;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  ipTimeoutMs?: number;
}

const SSH_KEY = /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}( [ -~]{0,200})?$/;
const RUN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MiB = 1024 * 1024;

export function isValidSshPublicKey(key: string): boolean {
  const k = key.trim();
  return !k.includes("\n") && SSH_KEY.test(k);
}

const splitTags = (tags: unknown) => (typeof tags === "string" ? tags.split(/[;, ]+/).filter(Boolean) : []);

/** The broker's marker in a guest's description. It survives broker restarts, so expiry still holds after a crash. */
export function encodeMarker(m: { profile: string; expiresAt: string; runId?: string }): string {
  return `papercliped-lease profile=${m.profile} expires=${m.expiresAt}${m.runId ? ` run=${m.runId}` : ""}`;
}

export function decodeMarker(description: unknown): { profile: string | null; expiresAt: string | null; runId: string | null } {
  let text = typeof description === "string" ? description : "";
  try {
    text = decodeURIComponent(text);
  } catch {
    // not percent-encoded
  }
  const line = text.split("\n").find((l) => l.startsWith("papercliped-lease ")) ?? "";
  const get = (k: string) => line.match(new RegExp(`(?:^| )${k}=(\\S+)`))?.[1] ?? null;
  return { profile: get("profile"), expiresAt: get("expires"), runId: get("run") };
}

type Guest = ClusterResource & { vmid: number };

export class Broker {
  private readonly c: BrokerConfig;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly protectedVmids: Set<number>;
  private readonly d: BrokerDeps;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(d: BrokerDeps) {
    this.d = d;
    this.c = d.config;
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.protectedVmids = new Set(d.config.protectedVmids);
  }

  // ---- access ----

  /** Throws unless the caller may act on this group: Pin may act on any group, a company only on its own. */
  groupFor(principal: Principal, groupName: string): ResourceGroup {
    const group = Object.hasOwn(this.c.groups, groupName) ? this.c.groups[groupName] : undefined;
    if (!group) throw new BrokerError("Unknown resource group", 404, "group_not_found");
    if (principal.scope === "group" && principal.group !== groupName) throw new BrokerError("This caller cannot use that resource group", 403, "forbidden");
    return group;
  }

  requireSystem(principal: Principal) {
    if (principal.scope !== "system") throw new BrokerError("Only Pin can do this", 403, "forbidden");
  }

  // ---- helpers ----

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private log(action: string, principal: Principal | "system:reaper", fields: Record<string, unknown>) {
    // Fixed keys go last so a field can never overwrite what the entry records.
    this.d.audit({ ...fields, ts: new Date(this.now()).toISOString(), action, by: typeof principal === "string" ? principal : principal.name });
  }

  private inRange(g: ResourceGroup, vmid: number) {
    return vmid >= g.vmidRange[0] && vmid <= g.vmidRange[1];
  }

  private belongs(g: ResourceGroup, r: ClusterResource): r is Guest {
    return r.type === "lxc" && typeof r.vmid === "number" && this.inRange(g, r.vmid) && r.pool === g.pool && splitTags(r.tags).includes(g.tag) && (r.node === undefined || r.node === this.c.proxmox.node);
  }

  private async members(g: ResourceGroup): Promise<Guest[]> {
    return (await this.d.pve.clusterResources()).filter((r) => this.belongs(g, r));
  }

  private async ipOf(vmid: number): Promise<string | null> {
    const ifaces = await this.d.pve.lxcInterfaces(this.c.proxmox.node, vmid).catch(() => []);
    const eth = ifaces.find((i) => i.name === "eth0") ?? ifaces.find((i) => i.name !== "lo" && i.inet);
    return eth?.inet ? eth.inet.split("/")[0] : null;
  }

  private async describe(g: ResourceGroup, r: Guest): Promise<Lease> {
    const cfg = await this.d.pve.lxcConfig(this.c.proxmox.node, r.vmid);
    const m = decodeMarker(cfg.description);
    return {
      id: String(r.vmid),
      group: g.name,
      vmid: r.vmid,
      status: r.status ?? "unknown",
      hostname: typeof cfg.hostname === "string" ? cfg.hostname : (r.name ?? ""),
      ip: r.status === "running" ? await this.ipOf(r.vmid) : null,
      profile: m.profile,
      expiresAt: m.expiresAt,
      runId: m.runId,
    };
  }

  private parseLeaseId(g: ResourceGroup, id: string): number {
    const vmid = Number(id);
    if (!/^\d+$/.test(id) || !this.inRange(g, vmid)) throw new BrokerError("Unknown lease", 404, "lease_not_found");
    return vmid;
  }

  // ---- system scope (Pin) ----

  async hostStatus(principal: Principal) {
    this.requireSystem(principal);
    const [version, node, all] = await Promise.all([this.d.pve.version(), this.d.pve.nodeStatus(this.c.proxmox.node), this.d.pve.clusterResources()]);
    return {
      proxmox: version.version,
      node: this.c.proxmox.node,
      cpu: { usage: node.cpu, cpus: node.cpuinfo?.cpus ?? null, model: node.cpuinfo?.model ?? null },
      memory: { totalBytes: node.memory.total, usedBytes: node.memory.used },
      guests: all.filter((r) => r.type === "lxc" || r.type === "qemu").length,
      groups: Object.values(this.c.groups).map((g) => ({ name: g.name, leases: all.filter((r) => this.belongs(g, r)).length, maxLeases: g.limits.maxLeases })),
      protectedVmids: [...this.protectedVmids],
    };
  }

  /** Every guest with its metrics. This is the snapshot the automations engine reads. */
  async listGuests(principal: Principal): Promise<ClusterResource[]> {
    this.requireSystem(principal);
    return (await this.d.pve.clusterResources()).filter((r) => r.type === "lxc" || r.type === "qemu");
  }

  /** Power or snapshot any guest. Protected guests and templates are refused. Destroy is not offered here. */
  async guestAction(principal: Principal, vmid: number, action: GuestActionName, source: "pin" | "automation" = "pin") {
    this.requireSystem(principal);
    if (!Number.isInteger(vmid) || vmid < 100) throw new BrokerError("Invalid guest id", 400, "bad_vmid");
    if (!["start", "stop", "shutdown", "reboot", "snapshot"].includes(action)) throw new BrokerError("Unsupported action", 400, "bad_action");
    if (this.protectedVmids.has(vmid)) {
      this.log("guest.action", principal, { ok: false, vmid, op: action, source, error: "protected" });
      throw new BrokerError("That guest is protected", 403, "protected");
    }
    const r = (await this.d.pve.clusterResources()).find((x) => x.vmid === vmid);
    if (!r || (r.type !== "lxc" && r.type !== "qemu")) throw new BrokerError("Unknown guest", 404, "guest_not_found");
    if (r.template) throw new BrokerError("Templates cannot be powered or snapshotted here", 400, "template");
    const node = r.node ?? this.c.proxmox.node;
    const type = r.type as GuestType;
    try {
      const upid = action === "snapshot"
        ? await this.d.pve.guestSnapshot(node, type, vmid, `auto-${new Date(this.now()).toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`, `Taken by ${source}`)
        : await this.d.pve.guestPower(node, type, vmid, action);
      await this.d.pve.waitTask(node, upid);
    } catch (error) {
      this.log("guest.action", principal, { ok: false, vmid, op: action, source, error: error instanceof Error ? error.message : String(error) });
      throw new BrokerError(error instanceof Error ? error.message : String(error), 502, "proxmox_error");
    }
    this.log("guest.action", principal, { ok: true, vmid, op: action, source });
    return { vmid, action, ok: true };
  }

  /** Usage history. Pin can read any guest and the node; a company only its own leases. Read-only, so not audited. */
  async stats(principal: Principal, target: { node: true } | { vmid: number }, timeframe: string, cf: string): Promise<RrdPoint[]> {
    if (!["hour", "day", "week", "month", "year"].includes(timeframe)) throw new BrokerError("timeframe must be hour, day, week, month or year", 400, "bad_timeframe");
    if (cf !== "AVERAGE" && cf !== "MAX") throw new BrokerError("cf must be AVERAGE or MAX", 400, "bad_cf");
    const tf = timeframe as RrdTimeframe;
    if ("node" in target) {
      this.requireSystem(principal);
      return this.d.pve.nodeRrd(this.c.proxmox.node, tf, cf as RrdCf);
    }
    const r = (await this.d.pve.clusterResources()).find((x) => x.vmid === target.vmid);
    if (!r || (r.type !== "lxc" && r.type !== "qemu")) throw new BrokerError("Unknown guest", 404, "guest_not_found");
    if (principal.scope === "group") {
      const g = this.c.groups[principal.group];
      if (!g || !this.belongs(g, r)) throw new BrokerError("Unknown guest", 404, "guest_not_found");
    }
    return this.d.pve.guestRrd(r.node ?? this.c.proxmox.node, r.type as GuestType, target.vmid, tf, cf as RrdCf);
  }

  // ---- group scope (company agents, and Pin) ----

  async listLeases(principal: Principal, groupName: string): Promise<Lease[]> {
    const g = this.groupFor(principal, groupName);
    return Promise.all((await this.members(g)).map((r) => this.describe(g, r)));
  }

  async getLease(principal: Principal, groupName: string, id: string): Promise<Lease> {
    const g = this.groupFor(principal, groupName);
    const vmid = this.parseLeaseId(g, id);
    const r = (await this.members(g)).find((x) => x.vmid === vmid);
    if (!r) throw new BrokerError("Unknown lease", 404, "lease_not_found");
    return this.describe(g, r);
  }

  private expiry(g: ResourceGroup, requested?: string): string {
    const now = this.now();
    const max = now + g.limits.maxTtlMinutes * 60_000;
    let at = now + g.limits.defaultTtlMinutes * 60_000;
    if (requested !== undefined) {
      const t = Date.parse(requested);
      if (!Number.isFinite(t) || t <= now) throw new BrokerError("requestedExpiresAt must be a future ISO 8601 time", 400, "bad_expiry");
      at = t;
    }
    return new Date(Math.min(at, max)).toISOString();
  }

  private async freeVmid(g: ResourceGroup, all: ClusterResource[]): Promise<number> {
    const used = new Set(all.map((r) => r.vmid).filter((v): v is number => typeof v === "number"));
    for (let v = g.vmidRange[0]; v <= g.vmidRange[1]; v++) {
      if (used.has(v)) continue;
      try {
        await this.d.pve.checkVmidFree(v); // also catches guests this token cannot see
        return v;
      } catch {
        continue;
      }
    }
    throw new BrokerError("No free guest id left in this resource group", 503, "no_vmid");
  }

  async createLease(principal: Principal, groupName: string, req: CreateLeaseRequest): Promise<Lease> {
    const g = this.groupFor(principal, groupName);
    if (!g.profiles.includes(req.profile) || !Object.hasOwn(this.c.profiles, req.profile)) throw new BrokerError(`Profile "${req.profile}" is not allowed in this resource group`, 400, "unknown_profile");
    const profile: Profile = this.c.profiles[req.profile];
    if (req.runId !== undefined && !RUN_ID.test(req.runId)) throw new BrokerError("runId is invalid", 400, "bad_run_id");
    if (profile.kind === "ostemplate" && (!req.sshPublicKey || !isValidSshPublicKey(req.sshPublicKey))) throw new BrokerError("This profile needs one OpenSSH public key in sshPublicKey", 400, "bad_ssh_key");
    const expiresAt = this.expiry(g, req.requestedExpiresAt);

    return this.serial(async () => {
      const all = await this.d.pve.clusterResources();
      const mine = all.filter((r) => this.belongs(g, r));
      const cores = mine.reduce((s, r) => s + (r.maxcpu ?? 0), 0);
      const memMb = mine.reduce((s, r) => s + (r.maxmem ?? 0) / MiB, 0);
      const over = mine.length >= g.limits.maxLeases ? `lease limit (${g.limits.maxLeases})`
        : cores + profile.cores > g.limits.maxCores ? `core limit (${g.limits.maxCores})`
        : memMb + profile.memoryMb > g.limits.maxMemoryMb ? `memory limit (${g.limits.maxMemoryMb} MB)`
        : null;
      if (over) {
        this.log("lease.create", principal, { ok: false, group: g.name, profile: req.profile, error: over });
        throw new BrokerError(`Resource group ${g.name} would exceed its ${over}`, 429, "group_limit");
      }

      const vmid = await this.freeVmid(g, all);
      const node = this.c.proxmox.node;
      const hostname = `${g.tag}-${vmid}`.slice(0, 63);
      const description = encodeMarker({ profile: req.profile, expiresAt, runId: req.runId });
      let created = false;
      try {
        if (profile.kind === "ostemplate") {
          const upid = await this.d.pve.createLxc(node, {
            vmid,
            ostemplate: profile.ostemplate,
            hostname,
            pool: g.pool,
            tags: g.tag,
            description,
            storage: profile.storage,
            rootfs: `${profile.storage}:${profile.diskGb}`,
            cores: profile.cores,
            memory: profile.memoryMb,
            swap: 0,
            net0: `name=eth0,bridge=${profile.bridge},ip=dhcp,firewall=1`,
            unprivileged: true,
            features: "nesting=1",
            onboot: false,
            start: false,
            "ssh-public-keys": req.sshPublicKey!.trim(),
          });
          created = true;
          await this.d.pve.waitTask(node, upid);
        } else {
          const upid = await this.d.pve.cloneLxc(node, profile.template, { newid: vmid, hostname, pool: g.pool, description, full: profile.fullClone, storage: profile.fullClone ? profile.storage : undefined });
          created = true;
          await this.d.pve.waitTask(node, upid);
          await this.d.pve.setLxcConfig(node, vmid, { tags: g.tag, cores: profile.cores, memory: profile.memoryMb, onboot: false });
        }
        await this.d.pve.waitTask(node, await this.d.pve.startLxc(node, vmid));
        const ip = await this.waitForIp(vmid);
        this.log("lease.create", principal, { ok: true, group: g.name, vmid, profile: req.profile, runId: req.runId ?? null, expiresAt });
        return { id: String(vmid), group: g.name, vmid, status: "running", hostname, ip, profile: req.profile, expiresAt, runId: req.runId ?? null };
      } catch (error) {
        this.log("lease.create", principal, { ok: false, group: g.name, vmid, profile: req.profile, error: error instanceof Error ? error.message : String(error) });
        if (created) await this.destroyVmid(vmid).catch(() => undefined);
        throw error instanceof BrokerError ? error : new BrokerError(error instanceof Error ? error.message : String(error), 502, "proxmox_error");
      }
    });
  }

  private async waitForIp(vmid: number): Promise<string> {
    const deadline = this.now() + (this.d.ipTimeoutMs ?? 90_000);
    for (;;) {
      const ip = await this.ipOf(vmid);
      if (ip) return ip;
      if (this.now() > deadline) throw new BrokerError("Container started but got no IP address (is DHCP available on the bridge?)", 504, "no_ip");
      await this.sleep(1_000);
    }
  }

  private async destroyVmid(vmid: number) {
    const node = this.c.proxmox.node;
    // force lets Proxmox stop a running container as part of the destroy task.
    await this.d.pve.waitTask(node, await this.d.pve.destroyLxc(node, vmid));
  }

  /** Destroys a lease in a group. A lease that is already gone counts as destroyed, so release is idempotent. */
  async destroyLease(principal: Principal | "system:reaper", groupName: string, id: string): Promise<{ id: string; state: "destroyed"; alreadyGone: boolean }> {
    const g = principal === "system:reaper" ? this.c.groups[groupName] : this.groupFor(principal, groupName);
    if (!g) throw new BrokerError("Unknown resource group", 404, "group_not_found");
    const vmid = this.parseLeaseId(g, id);
    return this.serial(async () => {
      const r = (await this.d.pve.clusterResources()).find((x) => x.vmid === vmid);
      if (!r) {
        this.log("lease.destroy", principal, { ok: true, group: g.name, vmid, alreadyGone: true });
        return { id, state: "destroyed" as const, alreadyGone: true };
      }
      if (!this.belongs(g, r) || this.protectedVmids.has(vmid)) {
        this.log("lease.destroy", principal, { ok: false, group: g.name, vmid, error: "not_in_group" });
        throw new BrokerError("That guest is not a lease in this resource group", 403, "not_in_group");
      }
      try {
        await this.destroyVmid(vmid);
      } catch (error) {
        this.log("lease.destroy", principal, { ok: false, group: g.name, vmid, error: error instanceof Error ? error.message : String(error) });
        throw new BrokerError(error instanceof Error ? error.message : String(error), 502, "proxmox_error");
      }
      this.log("lease.destroy", principal, { ok: true, group: g.name, vmid, alreadyGone: false });
      return { id, state: "destroyed" as const, alreadyGone: false };
    });
  }

  /** Destroys leases past their expiry, in every group. A lease with no readable expiry counts as expired: fail closed. */
  async reapExpired(): Promise<string[]> {
    const reaped: string[] = [];
    const all = await this.d.pve.clusterResources();
    for (const g of Object.values(this.c.groups)) {
      for (const r of all.filter((x) => this.belongs(g, x))) {
        const m = decodeMarker((await this.d.pve.lxcConfig(this.c.proxmox.node, r.vmid)).description);
        const t = m.expiresAt ? Date.parse(m.expiresAt) : NaN;
        if (Number.isFinite(t) && t > this.now()) continue;
        try {
          await this.destroyLease("system:reaper", g.name, String(r.vmid));
          reaped.push(`${g.name}/${r.vmid}`);
        } catch {
          // logged by destroyLease; retried on the next sweep
        }
      }
    }
    return reaped;
  }
}
