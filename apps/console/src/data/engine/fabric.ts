import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../../auth/session.tsx";

/**
 * The Worker Fabric's console API (docs/WORKER-FABRIC.md section 4): workers the host can run agents on, pairing,
 * adoption, revocation and the environments that point at them. Session auth, Proxmox administrators only. Nothing
 * here is invented: when the host says the Fabric is off or missing, the pages say so.
 */

export interface Capabilities {
  os: { name: string; version: string };
  arch: string;
  hostname: string;
  cpu: { model: string; cores: number };
  memMb: number;
  gpu: { present: boolean; name?: string; kind?: "jetson" | "nvidia" | "other" };
  storage: { path: string; totalGb: number; freeGb: number }[];
  tools: Partial<Record<"git" | "gh" | "node" | "pnpm" | "npm" | "python" | "uv" | "docker" | "make" | "gcc", string>>;
  inference: { runtime: "ollama"; url: string; models: { name: string; sizeMb?: number }[]; maxContext?: number } | null;
  networks: { provider: "tailscale" | "lan" | "other"; address: string }[];
  workspaceRoot: string;
}
export interface Worker {
  id: string;
  name: string;
  state: "pending" | "adopted" | "revoked";
  online: boolean;
  draining: boolean;
  disabled: boolean;
  fingerprint: string;
  version: string;
  lastSeen: number | null;
  connectedSince: number | null;
  transport: { provider: string; address: string };
  companies: string[] | null;
  shellSlots: number;
  inferenceSlots: number;
  usage: { shellLeases: number; inferenceRunning: number; inferenceQueued: number; loadAvg: number | null; freeMemMb: number | null };
  /** null until the worker has made its first report. */
  capabilities: Capabilities | null;
}
export interface Lease { id: string; workerId: string; companyId: string; agentId: string; runId: string; environmentId: string; workspace: string; state: "active" | "released" | "stopped" | "destroyed"; createdAt: number; releasedAt?: number; agentName?: string }
export interface Pending { id: string; name: string; verification: string; fingerprint: string; requestedAt: number; expiresAt: number; capabilities: Capabilities | null; remote: string }
export interface Requirements { arch?: string; tools?: string[]; gpu?: boolean; localModel?: string; minFreeMemMb?: number }
export interface Transport { provider: "tailscale" | "lan" | "custom"; label: string; available: boolean; recommended?: boolean; address?: string; detail: string }
export interface EnvView { id: string; companyId: string; name: string; workerId: string | null; requirements: Requirements; agents: string[] }
export interface AuditEvent { n: number; at: number; actor: string; action: string; workerId?: string; detail?: string }
export interface PairingView { id: string; name: string; createdAt: number; expiresAt: number; state?: "pending" | "used" | "cancelled" | "expired"; workerId?: string }
export interface FabricOverview { enabled: boolean; hostKey: { fingerprint: string }; listen: { url: string; port: number }; transports: Transport[]; workers: Worker[]; pending: Pending[]; pairings: PairingView[]; environments: EnvView[] }
export interface NewPairing { id: string; code: string; expiresAt: number; installCommand: string }
export interface WorkerPatch { name?: string; companies?: string[] | null; shellSlots?: number; inferenceSlots?: number; drain?: boolean; disabled?: boolean }
export interface EnvSpec { companyId: string; name?: string; workerId?: string; requirements?: Requirements; assignAgents?: string[] }

export interface ModelRecommendation {
  spec: { id: string; label: string; sizeGb: number; tags: string[]; note: string };
  fit: "gpu" | "cpu" | "too_big";
  reason: string;
  command: string;
}
export interface WorkerSetup {
  workerId: string;
  name: string;
  online: boolean;
  setupMode: "pin" | "self" | null;
  usable: { vramGb: number; ramGb: number };
  recommendations: ModelRecommendation[];
}
export interface InferenceResult {
  ok?: boolean;
  code?: "guided_only" | "helper_missing" | string;
  command?: string;
  output?: string;
  detail?: string;
}

export class FabricError extends Error {
  status: number;
  code: string | null;
  constructor(status: number, message: string, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function req<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: method === "GET" ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json", "X-EPC-Request": "1" },
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new FabricError(0, "Can't reach this device", "offline");
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string };
    throw new FabricError(res.status, d.error ?? (res.status === 404 ? "This device doesn't offer the Worker Fabric" : `Request failed (${res.status})`), d.code ?? null);
  }
  return data as T;
}

const enc = encodeURIComponent;
const ok = () => ({ ok: true as const });

export const fabricApi = {
  overview: () => req<FabricOverview>("GET", "/api/fabric"),
  worker: (id: string) => req<{ worker: Worker; leases: Lease[]; audit: AuditEvent[] }>("GET", `/api/fabric/workers/${enc(id)}`),
  patch: (id: string, patch: WorkerPatch) => req<{ worker?: Worker }>("PATCH", `/api/fabric/workers/${enc(id)}`, patch),
  revoke: (id: string) => req<ReturnType<typeof ok>>("POST", `/api/fabric/workers/${enc(id)}/revoke`, {}),
  remove: (id: string) => req<ReturnType<typeof ok>>("DELETE", `/api/fabric/workers/${enc(id)}`),
  refresh: (id: string) => req<ReturnType<typeof ok>>("POST", `/api/fabric/workers/${enc(id)}/refresh`, {}),
  setup: (id: string) => req<{ setup: WorkerSetup }>("GET", `/api/fabric/workers/${enc(id)}/setup`),
  inference: (id: string, body: { action: "ollama" | "pull"; model?: string }) => req<{ result: InferenceResult }>("POST", `/api/fabric/workers/${enc(id)}/inference`, body),
  pair: (spec: { name?: string; companies?: string[] | null; transport?: string }) => req<NewPairing>("POST", "/api/fabric/pairings", spec),
  cancelPairing: (id: string) => req<unknown>("DELETE", `/api/fabric/pairings/${enc(id)}`),
  approve: (id: string, spec: { name?: string; companies?: string[] | null }) => req<{ worker: Worker }>("POST", `/api/fabric/pending/${enc(id)}/approve`, spec),
  deny: (id: string) => req<unknown>("POST", `/api/fabric/pending/${enc(id)}/deny`, {}),
  createEnvironment: (spec: EnvSpec) => req<{ environment: EnvView }>("POST", "/api/fabric/environments", spec),
  audit: (limit = 50) => req<{ events: AuditEvent[]; latest: number }>("GET", `/api/fabric/audit?limit=${limit}`),
};

const KEY = ["host", "fabric"] as const;
const keys = { overview: KEY, worker: (id: string) => [...KEY, "worker", id] as const };

/** A plain sentence for the person, with the cases the Fabric can be in. */
export function fabricErrorText(e: unknown): string {
  if (e instanceof FabricError) {
    if (e.status === 0) return e.message;
    if (e.status === 401) return "Your session ended. Sign in again.";
    if (e.status === 403) return "Only Proxmox administrators can manage workers.";
    return e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}

/** The overview, kept fresh by polling and by the host's event stream when the browser has one. */
export function useFabric() {
  const live = useSession().session.mode === "live";
  const qc = useQueryClient();
  useEffect(() => {
    if (!live || typeof EventSource === "undefined") return;
    const es = new EventSource("/api/fabric/stream");
    const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
    for (const ev of ["worker", "lease", "pending", "audit"]) es.addEventListener(ev, refresh);
    return () => es.close();
  }, [live, qc]);
  return useQuery({ queryKey: keys.overview, queryFn: fabricApi.overview, enabled: live, retry: false, refetchInterval: 5_000 });
}

export function useWorker(id: string) {
  const live = useSession().session.mode === "live";
  return useQuery({ queryKey: keys.worker(id), queryFn: () => fabricApi.worker(id), enabled: live, retry: false, refetchInterval: 5_000 });
}

/** Any change refreshes the overview and the worker pages. */
export function useFabricAction<A, R>(fn: (arg: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries({ queryKey: KEY }) });
}
