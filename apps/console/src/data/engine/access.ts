import { HostError } from "./host.ts";

/**
 * The host service's access-control endpoints (/api/access/*): groups, roles, permissions, API tokens, two-factor,
 * realms and resource pools. Everything is done in Proxmox as the signed-in person; Proxmox decides.
 */

async function call<T>(method: "GET" | "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: method === "GET" ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json", "X-EPC-Request": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new HostError(0, "Can't reach this device", "offline");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string };
    throw new HostError(res.status, d.error ?? (res.status === 404 ? "The host service doesn't offer this yet" : `Request failed (${res.status})`), d.code ?? null);
  }
  return data as T;
}

const enc = encodeURIComponent;

export interface Group { groupid: string; comment: string | null; members: string[] }
export interface Privilege { name: string; group: string; description: string }
export interface Role { roleid: string; builtin: boolean; privileges: string[] }
export interface Acl { path: string; ugid: string; type: "user" | "group" | "token"; roleid: string; propagate: boolean; preset: string | null }
export interface GroupPermission { path: string; roleid: string; propagate: boolean; privileges: string[] }
export interface PathChoice { path: string; label: string; kind: string }
export interface PveToken {
  tokenid: string;
  fullTokenid: string;
  comment: string | null;
  expire: number | null;
  privsep: boolean;
  epaperclip: { id: string; name: string; readOnly: boolean; expiresAt: number; lastUsedAt: number | null } | null;
}
export interface EpcToken {
  id: string;
  name: string;
  userid: string;
  createdAt: number;
  expiresAt: number;
  readOnly: boolean;
  privsep: boolean;
  pveName: string;
  lastUsedAt: number | null;
}
export interface TfaEntry { id: string; type: string; description: string; created: number | null; enabled: boolean }
export interface UserDetail {
  userid: string;
  realmType: string | null;
  realmTfa: string | null;
  firstname: string;
  lastname: string;
  email: string;
  comment: string;
  enabled: boolean;
  expire: number | null;
  groups: string[];
  keys: string;
  tokens: number;
  tfa: TfaEntry[] | null;
}
export interface RealmField {
  name: string;
  label: string;
  kind: "string" | "integer" | "boolean" | "enum" | "secret";
  required?: boolean;
  max?: number;
  min?: number;
  options?: string[];
  default?: string | number | boolean;
  help?: string;
  secret?: boolean;
  group: "connection" | "login" | "sync" | "general";
  pattern?: string;
  createOnly?: boolean;
}
export interface Realm {
  realm: string;
  type: string;
  comment: string | null;
  default: boolean;
  tfa: string | null;
  config: Record<string, unknown>;
  canSync: boolean;
}
export interface RealmList { realms: Realm[]; canManage: boolean; schema: Record<string, RealmField[]>; types: string[]; creatable: string[] }
export interface PoolMember { kind: "machine" | "storage"; id: string; name: string | null; type?: string }
export interface Pool { poolid: string; comment: string | null; members: PoolMember[]; organization: { companyId: string; name: string } | null; orgPool: boolean }
export interface PoolOverview { pools: Pool[]; candidates: { machines: { vmid: number; name: string | null; type: string }[]; storage: string[] }; canManage: boolean }
export interface AuditEntry { at: number; actor: string; action: string; target?: string; detail?: string; ip?: string }

export const access = {
  groups: {
    list: () => call<{ groups: Group[]; canManage: boolean }>("GET", "/api/access/groups"),
    create: (g: { groupid: string; comment?: string; members?: string[] }) => call<{ ok: true; warnings: string[] }>("POST", "/api/access/groups", g),
    update: (id: string, g: { comment?: string; members?: string[] }) => call<{ ok: true; warnings: string[] }>("PUT", `/api/access/groups/${enc(id)}`, g),
    remove: (id: string) => call<{ ok: true }>("DELETE", `/api/access/groups/${enc(id)}`),
    permissions: (id: string) => call<{ entries: GroupPermission[] }>("GET", `/api/access/groups/${enc(id)}/permissions`),
  },
  roles: {
    list: () => call<{ roles: Role[]; privileges: Privilege[]; canManage: boolean }>("GET", "/api/access/roles"),
    create: (roleid: string, privileges: string[]) => call<{ ok: true }>("POST", "/api/access/roles", { roleid, privileges }),
    update: (roleid: string, privileges: string[]) => call<{ ok: true }>("PUT", `/api/access/roles/${enc(roleid)}`, { privileges }),
    remove: (roleid: string, removeAcls = false) => call<{ ok: true; removedAcls?: number }>("DELETE", `/api/access/roles/${enc(roleid)}`, removeAcls ? { removeAcls: true } : undefined),
  },
  acl: {
    list: () => call<{ acls: Acl[]; canModify: boolean }>("GET", "/api/access/acl"),
    set: (a: { path: string; roles: string[]; users?: string[]; groups?: string[]; tokens?: string[]; propagate?: boolean; remove?: boolean }) => call<{ ok: true }>("POST", "/api/access/acl", a),
    permissions: (userid: string, path: string) => call<{ permissions: Record<string, Record<string, number>> }>("GET", `/api/access/permissions?userid=${enc(userid)}&path=${enc(path)}`),
    paths: () => call<{ paths: PathChoice[] }>("GET", "/api/access/paths"),
  },
  users: {
    detail: (userid: string) => call<UserDetail>("GET", `/api/access/users/${enc(userid)}`),
    tokens: (userid: string) => call<{ tokens: PveToken[] }>("GET", `/api/access/users/${enc(userid)}/tokens`),
    createToken: (userid: string, t: { tokenid: string; comment?: string; expire?: number; privsep: boolean }) => call<{ fullTokenid: string; value: string; privsep: boolean }>("POST", `/api/access/users/${enc(userid)}/tokens`, t),
    updateToken: (userid: string, tokenid: string, t: { comment?: string; expire?: number; privsep?: boolean; regenerate?: boolean }) => call<{ ok: true; value?: string }>("PUT", `/api/access/users/${enc(userid)}/tokens/${enc(tokenid)}`, t),
    removeToken: (userid: string, tokenid: string) => call<{ ok: true }>("DELETE", `/api/access/users/${enc(userid)}/tokens/${enc(tokenid)}`),
    unlockTfa: (userid: string) => call<{ ok: true }>("PUT", `/api/access/users/${enc(userid)}/tfa-unlock`, {}),
  },
  epcTokens: {
    list: (all = false) => call<{ tokens: EpcToken[]; scope: "mine" | "all"; maxDays: number; defaultDays: number }>("GET", `/api/access/epc-tokens${all ? "?all=1" : ""}`),
    create: (t: { name: string; expiresInDays: number; readOnly: boolean; privsep: boolean }) => call<{ token: string; record: EpcToken; proxmoxTokenId: string; note: string }>("POST", "/api/access/epc-tokens", t),
    revoke: (id: string) => call<{ ok: true; warnings: string[] }>("DELETE", `/api/access/epc-tokens/${enc(id)}`),
  },
  tfa: {
    all: () => call<{ users: { userid: string; entries: TfaEntry[]; lockedUntil: number | null; totpLocked: boolean }[] }>("GET", "/api/access/tfa"),
    forUser: (userid: string) => call<{ userid: string; entries: TfaEntry[] }>("GET", `/api/access/tfa/${enc(userid)}`),
    addTotp: (userid: string, p: { totp: string; value: string; description?: string; password?: string }) => call<{ ok: true; id: string }>("POST", `/api/access/tfa/${enc(userid)}`, { type: "totp", ...p }),
    addRecovery: (userid: string, p: { description?: string; password?: string }) => call<{ ok: true; id: string; recovery: string[] }>("POST", `/api/access/tfa/${enc(userid)}`, { type: "recovery", ...p }),
    update: (userid: string, id: string, p: { enable?: boolean; description?: string; password?: string }) => call<{ ok: true }>("PUT", `/api/access/tfa/${enc(userid)}/${enc(id)}`, p),
    remove: (userid: string, id: string, password?: string) => call<{ ok: true }>("DELETE", `/api/access/tfa/${enc(userid)}/${enc(id)}`, password ? { password } : undefined),
  },
  realms: {
    list: () => call<RealmList>("GET", "/api/access/realms"),
    create: (r: Record<string, unknown>) => call<{ ok: true }>("POST", "/api/access/realms", r),
    update: (realm: string, r: Record<string, unknown>) => call<{ ok: true }>("PUT", `/api/access/realms/${enc(realm)}`, r),
    remove: (realm: string) => call<{ ok: true }>("DELETE", `/api/access/realms/${enc(realm)}`),
    sync: (realm: string, o: { scope: "users" | "groups" | "both"; dryRun: boolean; enableNew: boolean; removeVanished: string[] }) => call<{ task: string; dryRun: boolean }>("POST", `/api/access/realms/${enc(realm)}/sync`, o),
    task: (upid: string) => call<{ status: string; exitstatus: string | null; log: string[] }>("GET", `/api/tasks/${enc(upid)}`),
  },
  pools: {
    list: () => call<PoolOverview>("GET", "/api/access/pools"),
    create: (poolid: string, comment?: string) => call<{ ok: true }>("POST", "/api/access/pools", { poolid, comment }),
    update: (poolid: string, p: { comment?: string; addVms?: string[]; removeVms?: string[]; addStorage?: string[]; removeStorage?: string[]; move?: boolean }) => call<{ ok: true }>("PUT", `/api/access/pools/${enc(poolid)}`, p),
    remove: (poolid: string) => call<{ ok: true }>("DELETE", `/api/access/pools/${enc(poolid)}`),
  },
  audit: () => call<{ entries: AuditEntry[] }>("GET", "/api/access/audit"),
};
