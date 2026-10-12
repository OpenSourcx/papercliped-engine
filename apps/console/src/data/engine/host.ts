/**
 * The host service's own engine-side endpoints (services/epaperclip): whether the engine is ready, the system-wide
 * connectors, and each organization's resource group. Everything else about organizations goes through the engine
 * client.
 */

export interface EngineStatus {
  installed: boolean;
  reachable: boolean;
  ready: boolean;
  version: string | null;
  bootstrap: "pending" | "ready";
  serviceAccount?: "ours" | "other" | "pending" | "error";
  error?: string;
}

export interface ConnectorState {
  id: string;
  kind: string;
  label?: string;
  configured: boolean;
  last4?: string;
  updatedAt?: string;
  updatedBy?: string;
  testedAt?: string;
  ok?: boolean;
  error?: string;
}

export interface ConnectorList {
  connectors: ConnectorState[];
  /** Only Proxmox administrators may set, test or remove keys. */
  canManage: boolean;
}

/** A resource group: the organization's Proxmox pool and the limits its agents' containers live within. */
export interface ResourceGroupSize {
  cores: number;
  memoryMb: number;
  diskGb: number;
  maxGuests: number;
}
export interface ResourceGroupState extends ResourceGroupSize {
  companyId: string;
  name: string;
  pool: string;
  updatedAt?: string;
  updatedBy?: string;
}

/** Agent containers: agents run in unprivileged Proxmox containers, set up once by a Proxmox administrator. */
export type ContainersState = "not_set_up" | "partial" | "ready" | "error";
export interface ContainersStep { id: string; label: string; done: boolean; detail?: string }
export interface ContainersParams { storage: string; templateStorage: string; bridge: string; pool: string; size: { cores: number; memoryMb: number; diskGb: number } }
export interface ContainersStatus {
  state: ContainersState;
  steps: ContainersStep[];
  pluginInstalled: boolean;
  environments: { companyId: string; environmentId: string; ok: boolean }[];
  template: { vmid?: number; name?: string; exists: boolean };
  token: { exists: boolean };
  canManage: boolean;
  job: { id: string; status: "running" | "done" | "failed" } | null;
  params?: ContainersParams | null;
  error?: string;
}
export interface ContainersJob {
  id: string;
  kind: "setup" | "teardown";
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  startedBy: string;
  steps: { id: string; label: string; state: "pending" | "running" | "done" | "failed" | "skipped"; detail?: string }[];
  log: { t: number; level: "info" | "warn" | "error"; text: string }[];
  error?: string;
}

export class HostError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string };
    throw new HostError(res.status, d.error ?? (res.status === 404 ? "The host service doesn't offer this yet" : `Request failed (${res.status})`), d.code ?? null);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const host = {
  engineStatus: () => call<EngineStatus>("GET", "/api/engine/status"),
  connectors: {
    list: () => call<ConnectorList>("GET", "/api/connectors").then((r) => ({ connectors: r?.connectors ?? [], canManage: r?.canManage === true })),
    setKey: (id: string, apiKey: string) => call<{ connector: ConnectorState }>("PUT", `/api/connectors/${enc(id)}/credential`, { apiKey }).then((r) => r.connector),
    test: (id: string) => call<{ connector: ConnectorState }>("POST", `/api/connectors/${enc(id)}/test`, {}).then((r) => r.connector),
    remove: (id: string) => call<unknown>("DELETE", `/api/connectors/${enc(id)}/credential`),
  },
  agentContainers: {
    get: () => call<ContainersStatus>("GET", "/api/agent-containers"),
    setup: (choices: Partial<ContainersParams>) => call<{ jobId: string; alreadyRunning: boolean }>("POST", "/api/agent-containers/setup", choices),
    job: (id: string) => call<ContainersJob>("GET", `/api/agent-containers/jobs/${enc(id)}`),
    teardown: (confirm: string) => call<{ jobId: string }>("DELETE", "/api/agent-containers", { confirm }),
  },
  resourceGroups: {
    /** The groups of every organization the person belongs to. One without an entry has no resource group yet. */
    list: () => call<{ groups: ResourceGroupState[] }>("GET", "/api/resource-groups").then((r) => r?.groups ?? []),
    /** Creates or resizes the group; the host service makes the Proxmox pool as the signed-in person. Owners and admins only. */
    put: (companyId: string, spec: ResourceGroupSize & { name: string }) => call<{ group: ResourceGroupState }>("PUT", `/api/resource-groups/${enc(companyId)}`, spec).then((r) => r.group),
  },
};

/** Integrated Access Control: people and permissions are Proxmox users and ACLs; the host service keeps the engine in step. */
export type DeviceRole = "admin" | "operator" | "viewer" | "none";
export type OrgRole = "owner" | "admin" | "operator" | "viewer";

export interface IacUser {
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

export interface IacOverview {
  users: IacUser[];
  orgs: { companyId: string; name: string; pool: string | null }[];
  realms: { realm: string; type: string; comment?: string; default?: number }[];
  groups: { groupid: string; comment?: string }[];
  canManageUsers: boolean;
  warnings: string[];
}

export interface IacUserSpec {
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

export interface IacResult {
  userid: string;
  warnings: string[];
}

export const iac = {
  get: () => call<IacOverview>("GET", "/api/iac"),
  createUser: (spec: IacUserSpec) => call<IacResult>("POST", "/api/iac/users", spec),
  updateUser: (userid: string, spec: IacUserSpec) => call<IacResult>("PUT", `/api/iac/users/${enc(userid)}`, spec),
  deleteUser: (userid: string) => call<IacResult>("DELETE", `/api/iac/users/${enc(userid)}`),
  setPassword: (userid: string, password: string, confirmationPassword: string) => call<{ ok: true }>("PUT", `/api/iac/users/${enc(userid)}/password`, { password, confirmationPassword }),
  setOrgRole: (companyId: string, userid: string, role: OrgRole) => call<{ ok: true }>("PUT", `/api/iac/orgs/${enc(companyId)}/members/${enc(userid)}`, { role }),
  removeFromOrg: (companyId: string, userid: string) => call<{ ok: true }>("DELETE", `/api/iac/orgs/${enc(companyId)}/members/${enc(userid)}`),
};
