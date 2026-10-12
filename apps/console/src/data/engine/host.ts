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
  resourceGroups: {
    /** The groups of every organization the person belongs to. One without an entry has no resource group yet. */
    list: () => call<{ groups: ResourceGroupState[] }>("GET", "/api/resource-groups").then((r) => r?.groups ?? []),
    /** Creates or resizes the group; the host service makes the Proxmox pool as the signed-in person. Owners and admins only. */
    put: (companyId: string, spec: ResourceGroupSize & { name: string }) => call<{ group: ResourceGroupState }>("PUT", `/api/resource-groups/${enc(companyId)}`, spec).then((r) => r.group),
  },
};
