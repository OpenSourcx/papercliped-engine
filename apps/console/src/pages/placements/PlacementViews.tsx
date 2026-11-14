import { Link } from "react-router-dom";
import { useEngine } from "../../data/store.tsx";
import { type Placement, type PlacementAnswer, type Presence, type ResourceRef, useResourcePlacements, useRunPlacement } from "../../data/engine/placements.ts";
import { Card, Notice, SectionTitle, Status, type StatusKind } from "../../ui/primitives.tsx";
import { ago } from "../workers/util.ts";

/**
 * Where a run ran, and what a machine has run. The wording lives in plain functions so it can be tested and so every place
 * says the same thing. Rules it keeps (docs/PLACEMENTS.md): a finished container is never linked (its id may be reused), a
 * stale answer says so instead of claiming the run is still going, and what the host withheld is only ever a count.
 */

export const machineName = (r: ResourceRef): string => (r.kind === "lxc" ? `container ${r.vmid}` : `worker ${r.workerId}`);

export const PRESENCE: Record<Presence, [StatusKind, string]> = {
  unplaced: ["idle", "No machine recorded"],
  active: ["working", "Running"],
  retained: ["good", "Kept for reuse"],
  cleanup_pending: ["warning", "Cleaning up"],
  failed: ["critical", "Failed to start"],
  retired: ["off", "Finished"],
  stale: ["paused", "Not confirmed lately"],
  unavailable: ["idle", "Not checked yet"],
  restricted: ["off", "Another organization"],
};

/** One plain sentence about a run's placement. */
export function runSentence(status: Presence, p: Placement | null, now = Date.now()): string {
  const at = p?.resource ? machineName(p.resource) : "a machine";
  switch (status) {
    case "unplaced": return "No machine is recorded for this run. It may not have started yet, or its lease doesn't name one.";
    case "unavailable": return "The device hasn't read where runs ran yet. This fills in within a minute of the engine starting.";
    case "restricted": return "This run belongs to an organization you can't see.";
    case "active": return `Running in ${at}.`;
    case "retained": return `Ran in ${at}, which is kept for the next run.`;
    case "cleanup_pending": return `Finished in ${at}. Its cleanup hasn't completed yet.`;
    case "failed": return `The sandbox couldn't be made ready (${at}).`;
    case "retired": return `Ran in ${at}${p?.releasedAt ? `, released ${ago(p.releasedAt, now)}` : ""}.`;
    case "stale": return `Was running in ${at}, but the device hasn't heard from the engine for a while, so this may be out of date.`;
  }
}

/** Where to open a machine from. Not offered for a finished container: its id can belong to something else by now. */
export function machineLink(device: string, p: Placement, status: Presence): string | null {
  const r = p.resource;
  if (!r) return null;
  if (r.kind === "worker") return `/${device}/datacenter/workers/${encodeURIComponent(r.workerId)}`;
  return status === "retired" || status === "failed" ? null : `/${device}/machines/${r.vmid}`;
}

function newest(a: PlacementAnswer): Placement | null {
  const live = a.placements.filter((p) => p.state === "active" || p.state === "retained" || p.state === "cleanup_pending");
  return live[live.length - 1] ?? a.placements[a.placements.length - 1] ?? null;
}

/** On a run: the machine it used. Quiet if the host can't say, since the run itself is still shown. */
export function RunPlacement({ runId }: { runId: string }) {
  const { setup } = useEngine();
  const device = setup?.deviceName ?? "pve";
  const q = useRunPlacement(runId);
  if (q.isPending) return <Card className="p-4"><p className="text-sm text-ink-3" role="status" aria-busy="true">Looking up where this ran</p></Card>;
  if (q.error) return <Card className="p-4"><p className="text-sm text-ink-3">Couldn't look up where this ran.</p></Card>;
  const a = q.data;
  const p = newest(a);
  const [kind, label] = PRESENCE[a.status];
  const link = p ? machineLink(device, p, a.status) : null;
  return (
    <Card className="p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-compact font-semibold uppercase tracking-label text-ink-3 flex-1">Where it ran</h3>
        <Status kind={kind} label={label} />
      </div>
      <p className="text-sm text-ink-2" aria-label="Where this run ran">{runSentence(a.status, p)}</p>
      {link && p?.resource && <Link to={link} className="inline-flex items-center min-h-11 -my-2 text-compact text-ink-2 hover:text-ink underline underline-offset-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2">Open {machineName(p.resource)}</Link>}
      {a.status === "stale" && <Notice tone="warning">Open the engine's activity to confirm; this device last read the engine's leases {ago(a.lastSyncAt)}.</Notice>}
    </Card>
  );
}

/** On a container or worker: the runs it served, oldest first. Shown only when there is something to show. */
export function MachineRuns({ target }: { target: { kind: "lxc"; node: string; vmid: number } | { kind: "worker"; workerId: string } }) {
  const { setup, data } = useEngine();
  const device = setup?.deviceName ?? "pve";
  const q = useResourcePlacements(target);
  const a = q.data;
  if (!a || (a.placements.length === 0 && a.hidden === 0)) return null;
  const orgOf = (companyId: string) => (data?.orgs ?? []).find((o) => o.engine?.companyId === companyId);
  return (
    <Card className="p-5">
      <SectionTitle>Agent runs</SectionTitle>
      {a.placements.length > 0 && <ul className="divide-y divide-line -mx-5" aria-label="Runs this machine served">
        {[...a.placements].reverse().map((p) => {
          const [kind, label] = PRESENCE[p.state === "active" && a.status === "stale" ? "stale" : p.state];
          const org = orgOf(p.companyId);
          const task = org && p.issueId ? `/${device}/${org.slug}/tasks/${encodeURIComponent(p.issueId)}` : null;
          return (
            <li key={p.leaseId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-compact">
              <Status kind={kind} label={label} />
              <span className="flex-1 text-ink-2 min-w-0">{org?.name ?? "An organization"}{task ? <> · <Link to={task} className="underline underline-offset-2 hover:text-ink">open task</Link></> : null}</span>
              <span className="text-ink-3">{p.releasedAt ? `${ago(p.acquiredAt)} to ${ago(p.releasedAt)}` : `since ${ago(p.acquiredAt)}`}</span>
            </li>
          );
        })}
      </ul>}
      {a.hidden > 0 && <p className="mt-3 text-xs text-ink-3">{a.hidden} more {a.hidden === 1 ? "run" : "runs"} in organizations you can't see.</p>}
      {a.status === "stale" && <Notice tone="warning" className="mt-3">The device hasn't heard from the engine lately, so the newest entry may be out of date.</Notice>}
    </Card>
  );
}
