import type { StateStore } from "../state.ts";
import type { FabricHub } from "../fabric/hub.ts";
import type { FabricEnvironments } from "../fabric/engine.ts";
import { detectTransports, type Transport } from "@papercliped-engine/worker-fabric";
import type { FeatureCtx } from "./index.ts";

/**
 * The Worker Fabric in the console (docs/WORKER-FABRIC.md section 4). Proxmox administrators only; every change is
 * audited. A pairing code is shown once, in the answer that creates it.
 */

export interface FabricHandle {
  hub: FabricHub;
  envs: FabricEnvironments;
  transports: () => Transport[];
  listen: { url: string | null; port: number | null };
}
const registry = new WeakMap<StateStore, FabricHandle>();
export const registerFabric = (state: StateStore, h: FabricHandle) => void registry.set(state, h);
export { detectTransports };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function fabricRoutes(ctx: FeatureCtx): Promise<boolean> {
  const { path, method } = ctx;
  if (path !== "/api/fabric" && !path.startsWith("/api/fabric/")) return false;
  const E = ctx.HttpError;
  const h = registry.get(ctx.state);
  if (!h) throw new E(503, "fabric_unavailable", "The Worker Fabric isn't enabled on this host.");
  const s = ctx.session();
  if (s.apiToken) throw new E(403, "ticket_only", "The Worker Fabric is managed from the console by a signed-in person, not with an API token.");
  if (!(await ctx.asUser((pve) => ctx.isNodeAdmin(pve)))) throw new E(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can manage workers.");
  const hub = h.hub;
  const by = s.username;
  const change = () => ctx.sameSite();

  if (path === "/api/fabric" && method === "GET") {
    return ctx.json(200, { enabled: true, hostKey: { fingerprint: hub.hostKey().fingerprint }, listen: h.listen, transports: h.transports(), workers: hub.workers(), pending: hub.pendingList(), pairings: hub.pairings(), environments: await h.envs.list() }), true;
  }
  if (path === "/api/fabric/workers" && method === "GET") return ctx.json(200, { workers: hub.workers() }), true;
  if (path === "/api/fabric/transports" && method === "GET") return ctx.json(200, { transports: h.transports() }), true;
  if (path === "/api/fabric/pending" && method === "GET") return ctx.json(200, { pending: hub.pendingList() }), true;
  if (path === "/api/fabric/environments") {
    if (method === "GET") return ctx.json(200, { environments: await h.envs.list() }), true;
    if (method === "POST") {
      change();
      const b = await ctx.readJson();
      if (typeof b.companyId !== "string") throw new E(400, "bad_request", "companyId is required.");
      const env = await h.envs.create({ companyId: b.companyId, name: typeof b.name === "string" ? b.name : undefined, workerId: typeof b.workerId === "string" ? b.workerId : null, requirements: (b.requirements as never) ?? {}, assignAgents: Array.isArray(b.assignAgents) ? b.assignAgents.filter((x): x is string => typeof x === "string") : [] });
      return ctx.json(201, { environment: env }), true;
    }
  }
  if (path === "/api/fabric/audit" && method === "GET") {
    const q = ctx.url.searchParams;
    return ctx.json(200, hub.auditList({ after: Number(q.get("after") ?? 0) || 0, limit: Number(q.get("limit") ?? 200) || 200 })), true;
  }
  if (path === "/api/fabric/stream" && method === "GET") {
    const res = ctx.res;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": ok\n\n");
    const off = hub.subscribe((event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    const ka = setInterval(() => res.write(": keepalive\n\n"), 20_000);
    res.on("close", () => { off(); clearInterval(ka); });
    return true;
  }
  if (path === "/api/fabric/pairings" && method === "POST") {
    change();
    const b = await ctx.readJson();
    const companies = b.companies === null || b.companies === undefined ? null : Array.isArray(b.companies) && b.companies.every((c) => typeof c === "string" && ID.test(c)) ? (b.companies as string[]) : (() => { throw new E(400, "bad_request", "companies is a list of organization ids, or null for all."); })();
    const p = hub.createPairing(by, { name: typeof b.name === "string" ? b.name : undefined, companies, transport: typeof b.transport === "string" ? b.transport : null });
    return ctx.json(201, { id: p.id, code: p.code, expiresAt: p.expiresAt, installCommand: `epaperclip-worker adopt ${p.code}` }), true;
  }
  const pair = path.match(/^\/api\/fabric\/pairings\/([0-9a-f]{16})$/);
  if (pair && method === "DELETE") {
    change();
    hub.cancelPairing(by, pair[1]!);
    return ctx.json(200, { ok: true }), true;
  }
  const pend = path.match(/^\/api\/fabric\/pending\/([0-9a-f]{12})\/(approve|deny)$/);
  if (pend && method === "POST") {
    change();
    const b = await ctx.readJson();
    if (pend[2] === "deny") {
      hub.denyPending(by, pend[1]!);
      return ctx.json(200, { ok: true }), true;
    }
    const companies = b.companies === null || b.companies === undefined ? null : Array.isArray(b.companies) && b.companies.every((c) => typeof c === "string" && ID.test(c)) ? (b.companies as string[]) : (() => { throw new E(400, "bad_request", "companies is a list of organization ids, or null for all."); })();
    hub.approvePending(by, pend[1]!, { name: typeof b.name === "string" ? b.name : undefined, companies });
    // The worker finishes its handshake in the background; give it a moment so the answer can include it.
    await new Promise((r) => setTimeout(r, 150));
    const w = hub.workers().find((x) => x.online && x.fingerprint === hub.pendingFingerprint(pend[1]!));
    return ctx.json(200, { ok: true, worker: w ?? null }), true;
  }
  const one = path.match(/^\/api\/fabric\/workers\/(wrk_[0-9a-f]{12})(?:\/(revoke|refresh))?$/);
  if (one) {
    const id = one[1]!;
    const rec = hub.worker(id);
    if (!rec) throw new E(404, "not_found", "No such worker.");
    const action = one[2];
    if (!action && method === "GET") return ctx.json(200, { worker: hub.workers().find((w) => w.id === id), leases: hub.leases(id), audit: hub.auditList({ workerId: id, limit: 100 }).events }), true;
    if (!action && method === "PATCH") {
      change();
      return ctx.json(200, { worker: hub.updateWorker(by, id, await ctx.readJson()) }), true;
    }
    if (!action && method === "DELETE") {
      change();
      hub.forget(by, id);
      return ctx.json(200, { ok: true }), true;
    }
    if (action === "revoke" && method === "POST") {
      change();
      hub.revoke(by, id);
      return ctx.json(200, { ok: true }), true;
    }
    if (action === "refresh" && method === "POST") {
      change();
      await hub.refresh(id);
      return ctx.json(200, { ok: true }), true;
    }
  }
  throw new E(404, "not_found", "Not found");
}

/** For tests: the hub registered for this state. */
export const __hubFor = (state: StateStore): FabricHub => registry.get(state)!.hub;
