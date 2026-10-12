import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import type { EngineGateway } from "./engine.ts";
import { HttpError } from "./http.ts";
import type { Session, SessionStore } from "./sessions.ts";
import type { StateStore } from "./state.ts";

/**
 * Integrated Access Control. ePaperclip has no user database of its own: people are Proxmox users, and what they may
 * do is Proxmox ACLs. Every change made here is made in Proxmox first, as the signed-in administrator (so Proxmox's own
 * permission checks decide whether they may make it), and the engine is then brought in line:
 *
 *   - creating a user creates the Proxmox user; deleting one deletes it and removes them from every organization;
 *   - a device role is a set of Proxmox ACLs (admin, operator, viewer), and device admins are engine instance admins;
 *   - an organization role is an engine membership plus Proxmox roles on that organization's pool (its resource group),
 *     so access to its machines in Proxmox follows access to the organization in the engine;
 *   - disabling a user, or taking their access away, ends their open ePaperclip sessions.
 */

export type DeviceRole = "admin" | "operator" | "viewer" | "none";
export type OrgRole = "owner" | "admin" | "operator" | "viewer";

/** Device roles as Proxmox ACLs, using Proxmox's built-in roles only. */
export const DEVICE_ROLES: Record<DeviceRole, { path: string; role: string }[]> = {
  admin: [{ path: "/", role: "Administrator" }],
  operator: [
    { path: "/", role: "PVEAuditor" },
    { path: "/vms", role: "PVEVMAdmin" },
    { path: "/storage", role: "PVEDatastoreUser" },
  ],
  viewer: [{ path: "/", role: "PVEAuditor" }],
  none: [],
};

/** What an organization role grants on the organization's Proxmox pool. Pool ACLs reach every machine in the pool. */
export const ORG_POOL_ROLES: Record<OrgRole, string[]> = {
  owner: ["PVEVMAdmin", "PVEPoolAdmin"],
  admin: ["PVEVMAdmin", "PVEPoolAdmin"],
  operator: ["PVEVMUser"],
  viewer: ["PVEAuditor"],
};

const MANAGED_DEVICE = new Set(Object.values(DEVICE_ROLES).flat().map((a) => `${a.path} ${a.role}`));
const MANAGED_POOL_ROLES = new Set(Object.values(ORG_POOL_ROLES).flat());
const ORG_ROLES = new Set<OrgRole>(["owner", "admin", "operator", "viewer"]);
const DEVICE_ROLE_NAMES = new Set<DeviceRole>(["admin", "operator", "viewer", "none"]);

/** Proxmox user ids: name@realm, no whitespace or colons. */
export const USERID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const GROUPID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface PveUser {
  userid: string;
  enable?: number;
  expire?: number;
  firstname?: string;
  lastname?: string;
  email?: string;
  comment?: string;
  groups?: string | string[];
  "realm-type"?: string;
}
interface Acl {
  path: string;
  ugid: string;
  type: string;
  roleid: string;
  propagate?: number;
}
interface EngineMember {
  id: string;
  principalType: string;
  principalId: string;
  membershipRole: string;
  status: string;
}
interface ResourceGroup {
  pool: string;
  name?: string;
}

export interface UserSpec {
  userid?: string;
  password?: string;
  email?: string;
  firstname?: string;
  lastname?: string;
  comment?: string;
  groups?: string[];
  enable?: boolean;
  expire?: number;
  deviceRole?: DeviceRole;
  orgs?: { companyId: string; role: OrgRole }[];
}

export interface UserRow {
  userid: string;
  realm: string;
  realmType: string | null;
  name: string;
  email: string | null;
  enabled: boolean;
  expire: number | null;
  groups: string[];
  comment: string | null;
  deviceRole: DeviceRole | "custom";
  orgs: { companyId: string; role: string }[];
  hasEngineAccount: boolean;
}

const groupsOf = (g: PveUser["groups"]) => (Array.isArray(g) ? g : (g ?? "").split(",")).map((x) => x.trim()).filter(Boolean);
const userAcls = (userid: string, acls: Acl[]) => acls.filter((a) => a.type === "user" && a.ugid === userid);

/** The device role a user's ACLs amount to: one of ours when they match exactly, "custom" when they don't. */
export function deviceRoleOf(userid: string, acls: Acl[]): DeviceRole | "custom" {
  const mine = userAcls(userid, acls).filter((a) => !a.path.startsWith("/pool/") && MANAGED_DEVICE.has(`${a.path} ${a.roleid}`));
  const others = userAcls(userid, acls).filter((a) => !a.path.startsWith("/pool/") && !MANAGED_DEVICE.has(`${a.path} ${a.roleid}`));
  if (others.length) return "custom";
  const have = new Set(mine.map((a) => `${a.path} ${a.roleid}`));
  for (const name of ["admin", "operator", "viewer"] as const) {
    const want = DEVICE_ROLES[name].map((a) => `${a.path} ${a.role}`);
    if (want.length === have.size && want.every((w) => have.has(w))) return name;
  }
  return have.size ? "custom" : "none";
}

export function validateSpec(spec: Record<string, unknown>, creating: boolean): UserSpec {
  const out: UserSpec = {};
  const str = (k: string, max: number) => {
    const v = spec[k];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.length > max || /[\r\n\0]/.test(v)) throw new HttpError(400, "bad_request", `Invalid ${k}`);
    return v.trim();
  };
  if (creating) {
    const id = str("userid", 97);
    if (!id || !USERID.test(id)) throw new HttpError(400, "bad_request", "A user id looks like name@realm, for example sam@pve");
    out.userid = id;
  }
  const password = spec.password;
  if (password !== undefined) {
    if (typeof password !== "string" || password.length < 8 || password.length > 256) throw new HttpError(400, "bad_request", "Passwords need at least 8 characters");
    out.password = password;
  }
  out.email = str("email", 254);
  if (out.email && !/^[^\s@]+@[^\s@]+$/.test(out.email)) throw new HttpError(400, "bad_request", "That email address doesn't look right");
  out.firstname = str("firstname", 64);
  out.lastname = str("lastname", 64);
  out.comment = str("comment", 256);
  if (spec.groups !== undefined) {
    if (!Array.isArray(spec.groups) || spec.groups.length > 32 || !spec.groups.every((g) => typeof g === "string" && GROUPID.test(g))) throw new HttpError(400, "bad_request", "Invalid groups");
    out.groups = spec.groups as string[];
  }
  if (spec.enable !== undefined) {
    if (typeof spec.enable !== "boolean") throw new HttpError(400, "bad_request", "enable must be true or false");
    out.enable = spec.enable;
  }
  if (spec.expire !== undefined) {
    if (typeof spec.expire !== "number" || !Number.isInteger(spec.expire) || spec.expire < 0) throw new HttpError(400, "bad_request", "expire is a Unix time in seconds, or 0 for never");
    out.expire = spec.expire;
  }
  if (spec.deviceRole !== undefined) {
    if (!DEVICE_ROLE_NAMES.has(spec.deviceRole as DeviceRole)) throw new HttpError(400, "bad_request", "deviceRole is admin, operator, viewer or none");
    out.deviceRole = spec.deviceRole as DeviceRole;
  }
  if (spec.orgs !== undefined) {
    if (!Array.isArray(spec.orgs) || spec.orgs.length > 100) throw new HttpError(400, "bad_request", "Invalid orgs");
    out.orgs = spec.orgs.map((o) => {
      const x = o as { companyId?: unknown; role?: unknown };
      if (typeof x.companyId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(x.companyId) || !ORG_ROLES.has(x.role as OrgRole)) throw new HttpError(400, "bad_request", "Each organization needs a companyId and a role: owner, admin, operator or viewer");
      return { companyId: x.companyId, role: x.role as OrgRole };
    });
  }
  return out;
}

export class Iac {
  private readonly gateway: EngineGateway | null;
  private readonly state: StateStore;
  private readonly sessions: SessionStore;

  constructor(opts: { gateway: EngineGateway | null; state: StateStore; sessions: SessionStore }) {
    this.gateway = opts.gateway;
    this.state = opts.state;
    this.sessions = opts.sessions;
  }

  private pools(): Record<string, ResourceGroup> {
    return this.state.getSetting<Record<string, ResourceGroup>>("resourceGroups") ?? {};
  }

  // ---- Engine side, as the service account when it can (it is the engine's instance admin), else as the caller.

  private async engine<T>(caller: Session, method: string, path: string, body?: unknown): Promise<T> {
    const g = this.gateway;
    if (!g) throw new HttpError(503, "engine_unavailable", "The engine isn't set up on this host.");
    const viaService = await g.serviceJson<T>(method, path, body).catch((e) => {
      if (e instanceof HttpError && e.status === 403) return null;
      throw e;
    });
    if (viaService !== null) return viaService;
    return g.userJson<T>(caller, method, path, body);
  }

  private async members(caller: Session, companyId: string): Promise<EngineMember[]> {
    const r = await this.engine<{ members?: EngineMember[] } | EngineMember[]>(caller, "GET", `/api/companies/${encodeURIComponent(companyId)}/members`);
    return Array.isArray(r) ? r : r.members ?? [];
  }

  /** May the caller change who is in this organization? Device admins may; so may its owners and admins. */
  private async assertOrgManager(caller: Session, companyId: string, callerIsNodeAdmin: boolean) {
    if (callerIsNodeAdmin) return;
    const m = await this.gateway?.membership(caller, companyId).catch(() => null);
    if (!m || (m.role !== "owner" && m.role !== "admin")) throw new HttpError(403, "forbidden", "Only this organization's owners and admins, or a Proxmox administrator, can change who is in it");
  }

  // ---- Proxmox side, always as the caller

  private async acls(pve: ProxmoxClient): Promise<Acl[]> {
    return (await pve.call<Acl[]>("GET", "/access/acl")) ?? [];
  }

  private async setAcl(pve: ProxmoxClient, userid: string, path: string, roles: string[], remove: boolean) {
    if (!roles.length) return;
    await pve.call("PUT", "/access/acl", { path, roles: roles.join(","), users: userid, propagate: 1, ...(remove ? { delete: 1 } : {}) });
  }

  private async applyDeviceRole(pve: ProxmoxClient, userid: string, role: DeviceRole, acls?: Acl[]) {
    const current = userAcls(userid, acls ?? (await this.acls(pve))).filter((a) => !a.path.startsWith("/pool/") && MANAGED_DEVICE.has(`${a.path} ${a.roleid}`));
    const want = new Set(DEVICE_ROLES[role].map((a) => `${a.path} ${a.role}`));
    for (const a of current) if (!want.has(`${a.path} ${a.roleid}`)) await this.setAcl(pve, userid, a.path, [a.roleid], true);
    const have = new Set(current.map((a) => `${a.path} ${a.roleid}`));
    for (const a of DEVICE_ROLES[role]) if (!have.has(`${a.path} ${a.role}`)) await this.setAcl(pve, userid, a.path, [a.role], false);
  }

  private async applyPoolRole(pve: ProxmoxClient, userid: string, pool: string, role: OrgRole | null, acls?: Acl[]) {
    const path = `/pool/${pool}`;
    const current = userAcls(userid, acls ?? (await this.acls(pve))).filter((a) => a.path === path && MANAGED_POOL_ROLES.has(a.roleid)).map((a) => a.roleid);
    const want = role ? ORG_POOL_ROLES[role] : [];
    const drop = current.filter((r) => !want.includes(r));
    const add = want.filter((r) => !current.includes(r));
    await this.setAcl(pve, userid, path, drop, true);
    await this.setAcl(pve, userid, path, add, false);
  }

  // ---- What people see

  async overview(pve: ProxmoxClient, caller: Session, callerIsNodeAdmin: boolean) {
    const [users, acls, realms, groups, perms] = await Promise.all([
      pve.call<PveUser[]>("GET", "/access/users", { full: 1 }),
      this.acls(pve).catch(() => [] as Acl[]),
      pve.call<{ realm: string; type: string; comment?: string; default?: number }[]>("GET", "/access/domains").catch(() => []),
      pve.call<{ groupid: string; comment?: string }[]>("GET", "/access/groups").catch(() => []),
      pve.call<Record<string, Record<string, number>>>("GET", "/access/permissions", { path: "/access" }).catch(() => ({}) as Record<string, Record<string, number>>),
    ]);
    const canManageUsers = Object.values(perms ?? {}).some((p) => p["User.Modify"] === 1);
    const byEngineId = this.gateway?.accountsByEngineId() ?? new Map<string, string>();
    const accounts = this.state.getSetting<Record<string, unknown>>("engine.accounts") ?? {};
    const pools = this.pools();
    let orgs: { companyId: string; name: string; pool: string | null }[] = [];
    const orgRoles = new Map<string, { companyId: string; role: string }[]>();
    const warnings: string[] = [];
    if (this.gateway) {
      try {
        const companies = await this.engine<{ id: string; name: string; status?: string }[]>(caller, "GET", "/api/companies");
        orgs = companies.filter((c) => c.status !== "archived").map((c) => ({ companyId: c.id, name: c.name, pool: pools[c.id]?.pool ?? null }));
        await Promise.all(
          orgs.map(async (o) => {
            const ms = await this.members(caller, o.companyId).catch(() => [] as EngineMember[]);
            for (const m of ms) {
              if (m.principalType !== "user" || m.status !== "active") continue;
              const u = byEngineId.get(m.principalId);
              if (!u) continue;
              orgRoles.set(u, [...(orgRoles.get(u) ?? []), { companyId: o.companyId, role: m.membershipRole }]);
            }
          }),
        );
      } catch (e) {
        warnings.push(`Organizations couldn't be read from the engine: ${(e as Error).message}`);
      }
    }
    const rows: UserRow[] = (users ?? []).map((u) => {
      const realm = u.userid.slice(u.userid.lastIndexOf("@") + 1);
      return {
        userid: u.userid,
        realm,
        realmType: u["realm-type"] ?? null,
        name: [u.firstname, u.lastname].filter(Boolean).join(" ") || u.userid.slice(0, u.userid.lastIndexOf("@")),
        email: u.email ?? null,
        enabled: u.enable !== 0,
        expire: u.expire ? u.expire : null,
        groups: groupsOf(u.groups),
        comment: u.comment ?? null,
        deviceRole: deviceRoleOf(u.userid, acls),
        orgs: orgRoles.get(u.userid) ?? [],
        hasEngineAccount: u.userid in accounts,
      };
    });
    // Engine members whose Proxmox user is gone: their access was removed in Proxmox, so remove it in the engine too.
    if (callerIsNodeAdmin && this.gateway) {
      const present = new Set(rows.map((r) => r.userid));
      for (const [u, list] of orgRoles) {
        if (present.has(u)) continue;
        for (const o of list) await this.engineRemove(caller, o.companyId, u).catch((e: Error) => warnings.push(`Couldn't remove ${u} from an organization: ${e.message}`));
        await this.gateway.syncAdminUser(u, false).catch(() => {});
      }
    }
    return { users: rows, orgs, realms, groups, canManageUsers, deviceRoles: DEVICE_ROLES, orgPoolRoles: ORG_POOL_ROLES, warnings };
  }

  // ---- Changes

  private async engineRemove(caller: Session, companyId: string, userid: string) {
    const id = await this.gateway!.accountId(userid);
    const m = (await this.members(caller, companyId)).find((x) => x.principalType === "user" && x.principalId === id && x.status === "active");
    if (m) await this.engine(caller, "POST", `/api/companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(m.id)}/archive`, {});
  }

  private async engineSetRole(caller: Session, companyId: string, userid: string, role: OrgRole) {
    const g = this.gateway!;
    const id = await g.accountId(userid);
    const m = (await this.members(caller, companyId)).find((x) => x.principalType === "user" && x.principalId === id);
    if (m && m.status === "active") {
      if (m.membershipRole !== role) await this.engine(caller, "PATCH", `/api/companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(m.id)}`, { membershipRole: role });
      return;
    }
    // Not a member (or archived): an invitation with the role, accepted at once on their behalf.
    const invite = await this.engine<{ token?: string }>(caller, "POST", `/api/companies/${encodeURIComponent(companyId)}/invites`, { allowedJoinTypes: "human", humanRole: role });
    if (!invite?.token) throw new HttpError(502, "engine_error", "The engine didn't return an invitation");
    await g.accountJson(userid, "POST", `/api/invites/${encodeURIComponent(invite.token)}/accept`, { requestType: "human" });
  }

  /** Gives someone a role in an organization (or removes them with role null), in Proxmox and in the engine. */
  async setOrgRole(pve: ProxmoxClient, caller: Session, callerIsNodeAdmin: boolean, companyId: string, userid: string, role: OrgRole | null, acls?: Acl[]) {
    if (!USERID.test(userid)) throw new HttpError(400, "bad_request", "Invalid user id");
    if (role !== null && !ORG_ROLES.has(role)) throw new HttpError(400, "bad_request", "role is owner, admin, operator or viewer");
    if (!this.gateway) throw new HttpError(503, "engine_unavailable", "The engine isn't set up on this host.");
    await this.assertOrgManager(caller, companyId, callerIsNodeAdmin);
    if (role === null && userid === caller.username && !callerIsNodeAdmin) throw new HttpError(400, "bad_request", "You can't remove yourself; ask another owner or a Proxmox administrator");
    await pve.call("GET", `/access/users/${encodeURIComponent(userid)}`); // Proxmox has to know them first.
    const pool = this.pools()[companyId]?.pool;
    if (pool) await this.applyPoolRole(pve, userid, pool, role, acls);
    if (role === null) await this.engineRemove(caller, companyId, userid);
    else await this.engineSetRole(caller, companyId, userid, role);
    if (role === null && userid !== caller.username) this.sessions.destroyUser(userid);
  }

  /** A new pool for an organization: give its current members their roles on it in Proxmox. */
  async syncPool(pve: ProxmoxClient, caller: Session, companyId: string): Promise<string[]> {
    const pool = this.pools()[companyId]?.pool;
    if (!pool || !this.gateway) return [];
    const warnings: string[] = [];
    const byEngineId = this.gateway.accountsByEngineId();
    const acls = await this.acls(pve).catch(() => [] as Acl[]);
    for (const m of await this.members(caller, companyId)) {
      const u = m.principalType === "user" && m.status === "active" ? byEngineId.get(m.principalId) : undefined;
      if (!u || !ORG_ROLES.has(m.membershipRole as OrgRole)) continue;
      await this.applyPoolRole(pve, u, pool, m.membershipRole as OrgRole, acls).catch((e: Error) => warnings.push(`${u}: ${e.message}`));
    }
    return warnings;
  }

  async createUser(pve: ProxmoxClient, caller: Session, callerIsNodeAdmin: boolean, spec: UserSpec) {
    const userid = spec.userid!;
    const warnings: string[] = [];
    await pve.call("POST", "/access/users", {
      userid,
      password: spec.password,
      email: spec.email || undefined,
      firstname: spec.firstname || undefined,
      lastname: spec.lastname || undefined,
      comment: spec.comment || undefined,
      groups: spec.groups?.length ? spec.groups.join(",") : undefined,
      enable: spec.enable === false ? 0 : 1,
      expire: spec.expire ?? undefined,
    });
    const role = spec.deviceRole ?? "none";
    try {
      await this.applyDeviceRole(pve, userid, role);
    } catch (e) {
      warnings.push(`The user was created, but their device role wasn't set: ${(e as Error).message}`);
    }
    if (this.gateway) {
      await this.gateway.syncAdminUser(userid, role === "admin").catch((e: Error) => warnings.push(`Engine administrator status: ${e.message}`));
      for (const o of spec.orgs ?? []) await this.setOrgRole(pve, caller, callerIsNodeAdmin, o.companyId, userid, o.role).catch((e: Error) => warnings.push(`Organization ${o.companyId}: ${e.message}`));
    } else if (spec.orgs?.length) warnings.push("The engine isn't set up, so organization access wasn't given.");
    return { userid, warnings };
  }

  async updateUser(pve: ProxmoxClient, caller: Session, callerIsNodeAdmin: boolean, userid: string, spec: UserSpec) {
    if (!USERID.test(userid)) throw new HttpError(400, "bad_request", "Invalid user id");
    const warnings: string[] = [];
    const fields: Record<string, string | number | undefined> = {};
    if (spec.email !== undefined) fields.email = spec.email;
    if (spec.firstname !== undefined) fields.firstname = spec.firstname;
    if (spec.lastname !== undefined) fields.lastname = spec.lastname;
    if (spec.comment !== undefined) fields.comment = spec.comment;
    if (spec.groups !== undefined) fields.groups = spec.groups.join(",");
    if (spec.enable !== undefined) fields.enable = spec.enable ? 1 : 0;
    if (spec.expire !== undefined) fields.expire = spec.expire;
    if (Object.keys(fields).length) await pve.call("PUT", `/access/users/${encodeURIComponent(userid)}`, fields);
    if (spec.enable === false) this.sessions.destroyUser(userid);
    if (spec.deviceRole !== undefined) {
      if (userid === caller.username && spec.deviceRole !== "admin" && callerIsNodeAdmin) throw new HttpError(400, "bad_request", "You can't take your own administrator role away; ask another administrator");
      await this.applyDeviceRole(pve, userid, spec.deviceRole);
      await this.gateway?.syncAdminUser(userid, spec.deviceRole === "admin").catch((e: Error) => warnings.push(`Engine administrator status: ${e.message}`));
      if (spec.deviceRole === "none") this.sessions.destroyUser(userid);
    }
    if (spec.orgs !== undefined && this.gateway) {
      const want = new Map(spec.orgs.map((o) => [o.companyId, o.role]));
      const current = (await this.overviewRoles(caller, userid)).filter((o) => !want.has(o.companyId));
      for (const [companyId, role] of want) await this.setOrgRole(pve, caller, callerIsNodeAdmin, companyId, userid, role).catch((e: Error) => warnings.push(`Organization ${companyId}: ${e.message}`));
      for (const o of current) await this.setOrgRole(pve, caller, callerIsNodeAdmin, o.companyId, userid, null).catch((e: Error) => warnings.push(`Organization ${o.companyId}: ${e.message}`));
    }
    return { userid, warnings };
  }

  /** The organizations someone is in, from the engine. */
  private async overviewRoles(caller: Session, userid: string): Promise<{ companyId: string; role: string }[]> {
    const g = this.gateway!;
    const id = await g.accountId(userid).catch(() => null);
    if (!id) return [];
    const companies = await this.engine<{ id: string }[]>(caller, "GET", "/api/companies");
    const out: { companyId: string; role: string }[] = [];
    for (const c of companies) {
      const m = (await this.members(caller, c.id).catch(() => [] as EngineMember[])).find((x) => x.principalType === "user" && x.principalId === id && x.status === "active");
      if (m) out.push({ companyId: c.id, role: m.membershipRole });
    }
    return out;
  }

  async deleteUser(pve: ProxmoxClient, caller: Session, userid: string) {
    if (!USERID.test(userid)) throw new HttpError(400, "bad_request", "Invalid user id");
    if (userid === caller.username) throw new HttpError(400, "bad_request", "You can't delete your own account");
    if (userid === "root@pam") throw new HttpError(400, "bad_request", "root@pam can't be deleted");
    const warnings: string[] = [];
    const orgs = this.gateway ? await this.overviewRoles(caller, userid).catch(() => []) : [];
    await pve.call("DELETE", `/access/users/${encodeURIComponent(userid)}`); // Proxmox removes their ACLs with them.
    this.sessions.destroyUser(userid);
    if (this.gateway) {
      for (const o of orgs) await this.engineRemove(caller, o.companyId, userid).catch((e: Error) => warnings.push(`Organization ${o.companyId}: ${e.message}`));
      await this.gateway.syncAdminUser(userid, false).catch(() => {});
    }
    return { userid, warnings };
  }

  async setPassword(pve: ProxmoxClient, userid: string, password: string, confirmation: string) {
    if (!USERID.test(userid)) throw new HttpError(400, "bad_request", "Invalid user id");
    if (typeof password !== "string" || password.length < 8 || password.length > 256) throw new HttpError(400, "bad_request", "Passwords need at least 8 characters");
    if (typeof confirmation !== "string" || !confirmation) throw new HttpError(400, "bad_request", "Enter your own password to confirm");
    await pve.call("PUT", "/access/password", { userid, password, "confirmation-password": confirmation });
  }

  async createGroup(pve: ProxmoxClient, groupid: string, comment?: string) {
    if (!GROUPID.test(groupid)) throw new HttpError(400, "bad_request", "Group names use letters, digits, . _ and -");
    await pve.call("POST", "/access/groups", { groupid, comment: comment || undefined });
  }

  async deleteGroup(pve: ProxmoxClient, groupid: string) {
    if (!GROUPID.test(groupid)) throw new HttpError(400, "bad_request", "Invalid group");
    await pve.call("DELETE", `/access/groups/${encodeURIComponent(groupid)}`);
  }
}
