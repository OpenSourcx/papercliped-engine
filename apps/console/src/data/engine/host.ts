/**
 * The host service's own engine-side endpoints (docs/ENGINE.md, "Contracts between the parts"): whether the engine is
 * ready, the system-wide connectors, and each organization's resource group. Everything else about organizations goes
 * through the engine client.
 */

export interface EngineStatus {
  installed: boolean;
  reachable: boolean;
  ready: boolean;
  version: string | null;
  bootstrap: "pending" | "ready";
  error?: string;
}

export interface ConnectorState {
  id: string;
  kind: string;
  configured: boolean;
  last4?: string;
  testedAt?: string;
  ok?: boolean;
  /** Some services name their connectors; when they don't, the console names them from the id. */
  name?: string;
}

/** A resource group: the organization's Proxmox pool and the limits its agents' containers live within. */
export interface ResourceGroupSize {
  cores: number;
  memoryMb: number;
  diskGb: number;
  maxGuests: number;
}
export interface ResourceGroupState extends ResourceGroupSize {
  pool: string;
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
    list: () => call<ConnectorState[] | { connectors: ConnectorState[] }>("GET", "/api/connectors").then((r) => (Array.isArray(r) ? r : r?.connectors ?? [])),
    setKey: (id: string, apiKey: string) => call<ConnectorState | null>("PUT", `/api/connectors/${enc(id)}/credential`, { apiKey }),
    test: (id: string) => call<{ ok: boolean; message?: string; error?: string; testedAt?: string } | null>("POST", `/api/connectors/${enc(id)}/test`, {}),
    remove: (id: string) => call<unknown>("DELETE", `/api/connectors/${enc(id)}/credential`),
  },
  resourceGroups: {
    /** Null when the organization has no resource group yet. */
    get: (companyId: string) =>
      call<ResourceGroupState | null>("GET", `/api/resource-groups/${enc(companyId)}`).catch((e) => {
        if (e instanceof HostError && e.status === 404) return null;
        throw e;
      }),
    put: (companyId: string, size: ResourceGroupSize) => call<ResourceGroupState | null>("PUT", `/api/resource-groups/${enc(companyId)}`, size),
  },
};
