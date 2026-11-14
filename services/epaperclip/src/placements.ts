import type { StateStore } from "./state.ts";

/**
 * Where a run happened. The engine owns the run and its environment lease; the provider owns the container or worker.
 * This ledger keeps the one link between them on the host, so a run can be followed to the machine it used and a machine
 * back to the runs it served, including after an ephemeral container has been removed.
 *
 * Rules (docs/PLACEMENTS.md):
 * - A placement is taken from the engine's own lease row (run id, company, provider, provider lease id and the provider's
 *   metadata). It is never inferred from a display name, a chat transcript or a VMID that may since have been reused.
 * - Once a lease names its resource that reference never changes, and a lease never moves back from a later state.
 * - Retired placements are kept (bounded) as history, with the time window they covered, so a reused VMID is a separate
 *   placement with its own window and never silently inherits an older run.
 * - Queries take a visibility test for companies. What a caller may not see is withheld entirely, and only a count of it is
 *   returned.
 * - Nothing here stores an address, a user name or a key: the provider's metadata is read for the node and guest id (or the
 *   worker id) and dropped.
 */

export type ResourceRef = { kind: "lxc"; device: string; node: string; vmid: number } | { kind: "worker"; device: string; workerId: string };

/** The engine's lease statuses are active, released, expired, failed, retained and pending_cleanup (paperclipai 2026.1023.0). */
export type PlacementState = "active" | "retained" | "cleanup_pending" | "failed" | "retired";

export interface Placement {
  /** The engine's lease row id: the key of this record. */
  leaseId: string;
  /** The engine's run (heartbeat run) the lease belonged to, when it had one. */
  runId: string | null;
  companyId: string;
  issueId: string | null;
  provider: "proxmox" | "remote-worker";
  providerLeaseId: string | null;
  /** Null when the lease does not name a resource we can verify: the placement is then reported as unplaced. */
  resource: ResourceRef | null;
  state: PlacementState;
  acquiredAt: number;
  releasedAt: number | null;
  /** When the ledger last saw this lease in the engine. */
  syncedAt: number;
}

/** What a caller is told about where a run or a machine stands. */
export type Presence = "unplaced" | "active" | "retained" | "cleanup_pending" | "failed" | "retired" | "stale" | "unavailable" | "restricted";

interface Stored {
  v: 1;
  items: Record<string, Placement>;
  /** Per device: when every environment's leases were last read successfully. */
  syncedAt: Record<string, number>;
}

const SETTING = "placements.v1";
export const MAX_PLACEMENTS = 5000;
/** A live placement not confirmed by the engine for this long is reported as stale, not as running. */
export const STALE_AFTER_MS = 10 * 60_000;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const NODE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const WORKER = /^[A-Za-z0-9_.-]{1,64}$/;
const LEASE_ID = /^([A-Za-z0-9][A-Za-z0-9-]*)[/_](\d+)$/;
const RANK: Record<PlacementState, number> = { active: 0, retained: 1, cleanup_pending: 2, failed: 3, retired: 4 };

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const when = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(t) ? t : null;
};

function stateOf(status: string | null, cleanup: string | null, releasedAt: number | null): PlacementState {
  switch (status) {
    case "active": return "active";
    case "retained": return "retained";
    case "pending_cleanup": return "cleanup_pending";
    case "failed": return "failed";
    case "released":
    case "expired": return cleanup === "pending" || cleanup === "failed" ? "cleanup_pending" : "retired";
    default: return releasedAt !== null ? "retired" : "active";
  }
}

/** Reads one engine lease row. Returns null for another provider's lease, or a row without the facts to place it. */
export function placementFromLease(device: string, raw: unknown, now: number): Placement | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Record<string, unknown>;
  const leaseId = str(l.id);
  const companyId = str(l.companyId);
  const provider = l.provider;
  if (!leaseId || !ID.test(leaseId) || !companyId || !ID.test(companyId)) return null;
  if (provider !== "proxmox" && provider !== "remote-worker") return null;
  const meta = l.metadata && typeof l.metadata === "object" ? (l.metadata as Record<string, unknown>) : {};
  const providerLeaseId = str(l.providerLeaseId);

  let resource: ResourceRef | null = null;
  if (provider === "proxmox") {
    // The provider lease id is the provider's own cleanup reference (`node/vmid`), so it wins over the metadata.
    const m = providerLeaseId ? LEASE_ID.exec(providerLeaseId) : null;
    if (m && NODE.test(m[1]!)) resource = { kind: "lxc", device, node: m[1]!, vmid: Number(m[2]) };
    else if (typeof meta.node === "string" && NODE.test(meta.node) && Number.isInteger(meta.vmid) && (meta.vmid as number) > 0) resource = { kind: "lxc", device, node: meta.node, vmid: meta.vmid as number };
  } else if (typeof meta.workerId === "string" && WORKER.test(meta.workerId)) {
    resource = { kind: "worker", device, workerId: meta.workerId };
  }

  const releasedAt = when(l.releasedAt);
  return {
    leaseId,
    runId: str(l.heartbeatRunId),
    companyId,
    issueId: str(l.issueId),
    provider,
    providerLeaseId,
    resource,
    state: stateOf(str(l.status), str(l.cleanupStatus), releasedAt),
    acquiredAt: when(l.acquiredAt) ?? now,
    releasedAt,
    syncedAt: now,
  };
}

const sameResource = (a: ResourceRef, b: ResourceRef): boolean =>
  a.device === b.device && a.kind === b.kind && (a.kind === "lxc" && b.kind === "lxc" ? a.node === b.node && a.vmid === b.vmid : a.kind === "worker" && b.kind === "worker" && a.workerId === b.workerId);

/** How a placement reads right now. `sourceDown` means the engine could not be asked. */
export function classify(p: Placement | null, o: { now: number; lastSync: number | null; sourceDown?: boolean; staleAfterMs?: number }): Presence {
  if (!p) return o.sourceDown ? "unavailable" : "unplaced";
  if (!p.resource) return "unplaced";
  const live = p.state === "active" || p.state === "retained" || p.state === "cleanup_pending";
  if (live && (o.sourceDown || o.lastSync === null || o.now - o.lastSync > (o.staleAfterMs ?? STALE_AFTER_MS))) return o.sourceDown ? "unavailable" : "stale";
  return p.state;
}

export interface Visible {
  placements: Placement[];
  /** How many matching placements belong to companies the caller cannot see. Nothing else about them is returned. */
  hidden: number;
}

export class PlacementLedger {
  private readonly state: StateStore;
  private readonly now: () => number;
  private readonly max: number;

  constructor(state: StateStore, opts: { now?: () => number; max?: number } = {}) {
    this.state = state;
    this.now = opts.now ?? Date.now;
    this.max = opts.max ?? MAX_PLACEMENTS;
  }

  private read(): Stored {
    const s = this.state.getSetting<Stored>(SETTING);
    return s && s.v === 1 && s.items && typeof s.items === "object" ? { v: 1, items: s.items, syncedAt: s.syncedAt ?? {} } : { v: 1, items: {}, syncedAt: {} };
  }

  private write(s: Stored) {
    const keys = Object.keys(s.items);
    if (keys.length > this.max) {
      // Drop the oldest finished placements first; a live one is never dropped.
      const finished = keys.filter((k) => s.items[k]!.state === "retired").sort((a, b) => s.items[a]!.acquiredAt - s.items[b]!.acquiredAt);
      for (const k of finished.slice(0, keys.length - this.max)) delete s.items[k];
    }
    this.state.setSetting(SETTING, s);
  }

  private merge(old: Placement | undefined, next: Placement): Placement {
    if (!old) return next;
    // The company is fixed by the first sighting, so a later row cannot move a placement into another company.
    if (old.companyId !== next.companyId) return old;
    const state = RANK[next.state] >= RANK[old.state] && old.state !== "retired" ? next.state : old.state;
    return {
      ...old,
      runId: old.runId ?? next.runId,
      issueId: old.issueId ?? next.issueId,
      providerLeaseId: old.providerLeaseId ?? next.providerLeaseId,
      resource: old.resource ?? next.resource,
      state,
      releasedAt: old.releasedAt ?? next.releasedAt,
      syncedAt: next.syncedAt,
    };
  }

  /**
   * Records the leases the engine reported for this device. `complete` says every environment was read; only then is the
   * device marked as freshly synced, so a partial read can't make older placements look confirmed.
   */
  sync(device: string, leases: unknown[], opts: { complete: boolean }): { recorded: number; ignored: number } {
    const t = this.now();
    const s = this.read();
    let recorded = 0;
    let ignored = 0;
    for (const raw of leases) {
      const p = placementFromLease(device, raw, t);
      if (!p) {
        ignored++;
        continue;
      }
      s.items[p.leaseId] = this.merge(s.items[p.leaseId], p);
      recorded++;
    }
    if (opts.complete) s.syncedAt[device] = t;
    this.write(s);
    return { recorded, ignored };
  }

  lastSync(device: string): number | null {
    return this.read().syncedAt[device] ?? null;
  }

  private split(list: Placement[], visible: (companyId: string) => boolean): Visible {
    const placements = list.filter((p) => visible(p.companyId)).sort((a, b) => a.acquiredAt - b.acquiredAt);
    return { placements, hidden: list.length - placements.length };
  }

  /** The placements of one run, as far as the caller may see them. */
  forRun(runId: string, visible: (companyId: string) => boolean): Visible {
    return this.split(Object.values(this.read().items).filter((p) => p.runId === runId), visible);
  }

  /** Every run a machine has served (oldest first), as far as the caller may see them. A reused VMID shows as separate entries. */
  forResource(ref: ResourceRef, visible: (companyId: string) => boolean): Visible {
    return this.split(Object.values(this.read().items).filter((p) => p.resource !== null && sameResource(p.resource, ref)), visible);
  }
}

/** The placement that is current for a resource: the newest one still live, else none (a retired one is history). */
export function current(list: Placement[]): Placement | null {
  const live = list.filter((p) => p.state === "active" || p.state === "retained" || p.state === "cleanup_pending");
  return live.length ? live[live.length - 1]! : null;
}
