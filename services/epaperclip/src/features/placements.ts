import type { FeatureCtx } from "./index.ts";
import { classify, current, PlacementLedger, type Placement, type Presence, type ResourceRef, type Visible } from "../placements.ts";

/**
 * Follow a run to the machine it used, and a machine to the runs it served (docs/PLACEMENTS.md). Any signed-in person may
 * ask; what comes back is limited to the organizations they belong to, so nothing about another organization's run or
 * its container is shown (only that something is hidden).
 *
 *   GET /api/placements/runs/<runId>
 *   GET /api/placements/resources?kind=lxc&node=<node>&vmid=<id>
 *   GET /api/placements/resources?kind=worker&workerId=<id>
 */

const RUN = /^[A-Za-z0-9_-]{1,64}$/;
const NODE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const WORKER = /^[A-Za-z0-9_.-]{1,64}$/;

const view = (p: Placement) => ({
  leaseId: p.leaseId, runId: p.runId, companyId: p.companyId, issueId: p.issueId, provider: p.provider, resource: p.resource,
  state: p.state, acquiredAt: p.acquiredAt, releasedAt: p.releasedAt,
});

async function visibleCompanies(ctx: FeatureCtx): Promise<(id: string) => boolean> {
  const { HttpError } = ctx;
  if (!ctx.gateway) throw new HttpError(503, "engine_unavailable", "The engine isn't set up on this host.");
  const rows = await ctx.gateway.userJson<{ id?: string }[]>(ctx.session(), "GET", "/api/companies");
  const ids = new Set((Array.isArray(rows) ? rows : []).map((c) => c?.id).filter((x): x is string => typeof x === "string"));
  return (id) => ids.has(id);
}

function answer(ctx: FeatureCtx, ledger: PlacementLedger, found: Visible, subject: Record<string, unknown>) {
  const lastSync = ledger.lastSync(ctx.node);
  const live = current(found.placements) ?? found.placements[found.placements.length - 1] ?? null;
  let status: Presence;
  if (!live) status = found.hidden > 0 ? "restricted" : lastSync === null ? "unavailable" : "unplaced";
  else status = classify(live, { now: ctx.now(), lastSync });
  ctx.json(200, { ...subject, status, placements: found.placements.map(view), hidden: found.hidden, lastSyncAt: lastSync });
}

export async function handlePlacements(ctx: FeatureCtx): Promise<boolean> {
  const run = /^\/api\/placements\/runs\/([^/]+)$/.exec(ctx.path);
  if (!run && ctx.path !== "/api/placements/resources") return false;
  const { HttpError, method } = ctx;
  if (method !== "GET") throw new HttpError(405, "method", "Method not allowed");
  ctx.session();
  const ledger = new PlacementLedger(ctx.state, { now: ctx.now });

  if (run) {
    const runId = decodeURIComponent(run[1]!);
    if (!RUN.test(runId)) throw new HttpError(400, "bad_run", "That isn't a run id");
    answer(ctx, ledger, ledger.forRun(runId, await visibleCompanies(ctx)), { runId });
    return true;
  }

  const q = ctx.url.searchParams;
  const kind = q.get("kind");
  let ref: ResourceRef;
  if (kind === "lxc") {
    const node = q.get("node") ?? "";
    const vmid = Number(q.get("vmid"));
    if (!NODE.test(node) || !Number.isInteger(vmid) || vmid < 100 || vmid > 999_999_999) throw new HttpError(400, "bad_resource", "Give a node and a container id");
    ref = { kind: "lxc", device: ctx.node, node, vmid };
  } else if (kind === "worker") {
    const workerId = q.get("workerId") ?? "";
    if (!WORKER.test(workerId)) throw new HttpError(400, "bad_resource", "Give a worker id");
    ref = { kind: "worker", device: ctx.node, workerId };
  } else throw new HttpError(400, "bad_resource", "kind must be lxc or worker");
  answer(ctx, ledger, ledger.forResource(ref, await visibleCompanies(ctx)), { resource: ref });
  return true;
}
