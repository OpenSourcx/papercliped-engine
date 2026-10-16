import { HostError } from "./host.ts";

/**
 * The host service's newer access-control endpoints: your own password, signed-in sessions, the audit log, the sign-in
 * policy, security-key registration, the permission explorer, scheduled realm syncs, change previews, templates, CSV
 * import, group-to-organization mapping and routine webhooks. Everything is done in Proxmox as the signed-in person.
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
const qs = (o: Record<string, string | number | undefined>) => {
  const s = Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${enc(String(v))}`).join("&");
  return s ? `?${s}` : "";
};

export interface SessionRow { handle: string; username: string; createdAt: number; lastSeen: number; expiresAt: number; ip: string | null; agent: string | null; via: "password" | "openid" | null; current: boolean }
export interface AuditEntry { at: number; actor: string; action: string; target?: string; detail?: string; ip?: string }
export interface AuditFilter { actor?: string; action?: string; q?: string; from?: number; to?: number; limit?: number; offset?: number }
export interface SigninPolicy {
  webauthn: { rp: string | null; id: string | null; origin: string | null; allowSubdomains: boolean } | null;
  u2f: { appid: string | null; origin: string | null } | null;
  consentText: string;
  canManage: boolean;
}
export interface Explored {
  userid: string;
  isToken: boolean;
  privsep: boolean;
  groups: string[];
  note: string | null;
  entries: { path: string; role: string; propagate: boolean; source: string; privileges: string[] }[];
  effective: { path: string; privileges: string[]; grants: Record<string, { role: string; at: string; source: string }[]> }[];
}
export interface SyncJob { id: string; realm: string | null; schedule: string; scope: string; enabled: boolean; enableNew: boolean; removeVanished: string[]; comment: string | null; nextRun: number | null; lastRun: number | null; status: string | null }
export type Change =
  | { kind: "acl"; op: "add" | "remove"; path: string; role: string; privileges: string[]; reason: string }
  | { kind: "engine"; op: "add" | "change" | "remove"; companyId: string; org: string; from: string | null; to: string | null; text: string }
  | { kind: "effect"; text: string };
export interface Plan { changes: Change[]; warnings: string[] }
export interface Template { id: string; name: string; description?: string; deviceRole?: "admin" | "operator" | "viewer" | "none"; groups: string[]; orgs: { companyId: string; role: string }[] }
export type TemplateBody = Omit<Template, "id">;
export interface ImportOptions { existing: "skip" | "update"; createGroups: boolean; defaultRealm: string; template: string | null; generatePasswords: boolean }
export interface ImportRow {
  line: number;
  userid: string;
  action: "create" | "update" | "skip" | "error";
  errors: string[];
  warnings: string[];
  summary: { name: string; email: string | null; groups: string[]; deviceRole: string | null; orgs: { companyId: string; org: string; role: string }[]; template: string | null; realmType: string | null; passwordKept: boolean };
  changes?: Change[];
}
export interface ImportPreview { rows: ImportRow[]; problems: string[]; newGroups: string[]; counts: { create: number; update: number; skip: number; error: number } }
export interface ImportResult { results: { line: number; userid: string; status: "created" | "updated" | "skipped" | "failed"; warnings: string[]; error?: string; password?: string }[]; counts: { created: number; updated: number; skipped: number; failed: number } }
export interface GroupMapping { id?: string; group: string; companyId: string; role: string }
export interface MapOp { op: "grant" | "raise" | "revoke"; userid: string; companyId: string; org: string; from: string | null; to: string | null; because: string; applied?: boolean; error?: string }
export interface IngressOrg { companyId: string; name: string; enabled: boolean; enabledAt: number | null; by: string | null; error: string | null; hooks: { routineId: string; routine: string; triggerId: string; label: string | null; publicId: string; signingMode: string; enabled: boolean }[] }

export const accessAdmin = {
  changeOwnPassword: (currentPassword: string, password: string) => call<{ ok: true; otherSessionsEnded: number }>("POST", "/api/access/password", { currentPassword, password }),
  sessions: {
    list: (all = false) => call<{ sessions: SessionRow[]; scope: "mine" | "all"; canManageOthers: boolean }>("GET", `/api/access/sessions${all ? "?all=1" : ""}`),
    revoke: (handle: string) => call<{ ok: true }>("DELETE", `/api/access/sessions/${enc(handle)}`),
    revokeOthers: () => call<{ ok: true; ended: number }>("POST", "/api/access/sessions/revoke-others", {}),
    revokeUser: (userid: string) => call<{ ok: true; ended: number }>("POST", "/api/access/sessions/revoke-user", { userid }),
  },
  audit: {
    list: (f: AuditFilter) => call<{ entries: AuditEntry[]; total: number; kept: number; actors: string[]; actions: string[] }>("GET", `/api/access/audit${qs({ ...f })}`),
    exportUrl: (format: "csv" | "json", f: AuditFilter) => `/api/access/audit/export${qs({ ...f, limit: undefined, offset: undefined, format })}`,
  },
  policy: {
    get: () => call<SigninPolicy>("GET", "/api/access/signin-policy"),
    save: (b: { webauthn?: { rp: string; id: string; origin: string; allowSubdomains: boolean } | null; u2f?: { appid?: string; origin?: string } | null; consentText?: string | null }) => call<{ ok: true }>("PUT", "/api/access/signin-policy", b),
  },
  webauthn: {
    begin: (userid: string, p: { description?: string; password?: string }) => call<{ challenge: string }>("POST", `/api/access/webauthn/${enc(userid)}/begin`, p),
    finish: (userid: string, p: { challenge: string; value: string; description?: string; password?: string }) => call<{ ok: true; id?: string }>("POST", `/api/access/webauthn/${enc(userid)}/finish`, p),
  },
  explore: (userid: string) => call<Explored>("GET", `/api/access/explorer?userid=${enc(userid)}`),
  syncJobs: {
    list: () => call<{ jobs: SyncJob[] }>("GET", "/api/access/sync-jobs"),
    preview: (schedule: string) => call<{ times: number[] }>("GET", `/api/access/sync-jobs/preview?schedule=${enc(schedule)}`),
    create: (j: { id: string; realm: string; schedule: string; scope: string; enableNew: boolean; removeVanished: string[]; enabled: boolean; comment?: string }) => call<{ ok: true }>("POST", "/api/access/sync-jobs", j),
    update: (id: string, j: Partial<{ schedule: string; scope: string; enableNew: boolean; removeVanished: string[]; enabled: boolean; comment: string }>) => call<{ ok: true }>("PUT", `/api/access/sync-jobs/${enc(id)}`, j),
    remove: (id: string) => call<{ ok: true }>("DELETE", `/api/access/sync-jobs/${enc(id)}`),
  },
  preview: (b: { userid: string; deviceRole?: string; orgs?: { companyId: string; role: string | null }[]; orgsMode?: "replace" | "merge" }) => call<Plan>("POST", "/api/access/preview", b),
  templates: {
    list: () => call<{ templates: Template[] }>("GET", "/api/access/templates"),
    create: (t: TemplateBody) => call<{ template: Template }>("POST", "/api/access/templates", t),
    update: (id: string, t: TemplateBody) => call<{ template: Template }>("PUT", `/api/access/templates/${enc(id)}`, t),
    remove: (id: string) => call<{ ok: true }>("DELETE", `/api/access/templates/${enc(id)}`),
    apply: (id: string, userids: string[], dryRun: boolean) => call<{ results: (Plan & { userid: string; error?: string; applied?: boolean })[]; dryRun: boolean }>("POST", `/api/access/templates/${enc(id)}/apply`, { userids, dryRun }),
  },
  import: {
    preview: (csv: string, o: Partial<ImportOptions>) => call<ImportPreview>("POST", "/api/access/import/preview", { csv, ...o }),
    apply: (csv: string, o: Partial<ImportOptions>) => call<ImportResult>("POST", "/api/access/import/apply", { csv, ...o }),
  },
  groupMap: {
    get: () => call<{ mappings: GroupMapping[]; groups: string[]; orgs: { companyId: string; name: string }[]; roles: string[] }>("GET", "/api/access/group-map"),
    save: (mappings: GroupMapping[]) => call<{ mappings: GroupMapping[] }>("PUT", "/api/access/group-map", { mappings }),
    sync: (dryRun: boolean) => call<{ operations: MapOp[]; dryRun: boolean }>("POST", "/api/access/group-map/sync", { dryRun }),
  },
  ingress: {
    get: () => call<{ organizations: IngressOrg[]; path: string; maxBodyBytes: number; limits: { perAddressPerMinute: number; perTriggerPerMinute: number; overallPerMinute: number } }>("GET", "/api/access/routine-ingress"),
    set: (companyId: string, enabled: boolean) => call<{ ok: true }>("PUT", `/api/access/routine-ingress/${enc(companyId)}`, { enabled }),
  },
  epcTokens: {
    renew: (id: string, expiresInDays: number) => call<{ record: { id: string; expiresAt: number } }>("POST", `/api/access/epc-tokens/${enc(id)}/renew`, { expiresInDays }),
    rotate: (id: string, expiresInDays: number) => call<{ token: string; record: { id: string; name: string; expiresAt: number; privsep: boolean } }>("POST", `/api/access/epc-tokens/${enc(id)}/rotate`, { expiresInDays }),
  },
};
