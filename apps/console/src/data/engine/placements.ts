import { useQuery } from "@tanstack/react-query";

/**
 * Where runs ran (docs/PLACEMENTS.md): the host's ledger of which container or worker served which run. Read-only and open
 * to any signed-in person, but limited by the host to that person's organizations. Nothing here is guessed: a run with no
 * recorded machine is "unplaced", and a host that has not yet read the engine's leases answers "unavailable".
 */

export type ResourceRef = { kind: "lxc"; device: string; node: string; vmid: number } | { kind: "worker"; device: string; workerId: string };
export type PlacementState = "active" | "retained" | "cleanup_pending" | "failed" | "retired";
export type Presence = "unplaced" | PlacementState | "stale" | "unavailable" | "restricted";

export interface Placement {
  leaseId: string;
  runId: string | null;
  companyId: string;
  issueId: string | null;
  provider: "proxmox" | "remote-worker";
  resource: ResourceRef | null;
  state: PlacementState;
  acquiredAt: number;
  releasedAt: number | null;
}

export interface PlacementAnswer {
  status: Presence;
  placements: Placement[];
  /** Matches in organizations the person can't see. Only a count; nothing else about them is sent. */
  hidden: number;
  lastSyncAt: number | null;
}

export class PlacementError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } });
  } catch {
    throw new PlacementError(0, "Can't reach this device");
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new PlacementError(res.status, ((data ?? {}) as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

const enc = encodeURIComponent;

export const placementsApi = {
  run: (runId: string) => get<PlacementAnswer & { runId: string }>(`/api/placements/runs/${enc(runId)}`),
  resource: (ref: { kind: "lxc"; node: string; vmid: number } | { kind: "worker"; workerId: string }) =>
    get<PlacementAnswer>(ref.kind === "lxc" ? `/api/placements/resources?kind=lxc&node=${enc(ref.node)}&vmid=${ref.vmid}` : `/api/placements/resources?kind=worker&workerId=${enc(ref.workerId)}`),
};

/** Refreshed while open: a run moves from queued to placed to cleaned up within a minute or two. */
const POLL_MS = 20_000;

export function useRunPlacement(runId: string, enabled = true) {
  return useQuery({ queryKey: ["host", "placements", "run", runId], queryFn: () => placementsApi.run(runId), enabled, refetchInterval: POLL_MS, retry: false });
}

export function useResourcePlacements(ref: { kind: "lxc"; node: string; vmid: number } | { kind: "worker"; workerId: string } | null) {
  return useQuery({
    queryKey: ["host", "placements", "resource", ref],
    queryFn: () => placementsApi.resource(ref!),
    enabled: ref !== null,
    refetchInterval: POLL_MS,
    retry: false,
  });
}
