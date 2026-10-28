import type { Router, RouterKeys } from "../router/router.ts";
import type { StateStore } from "../state.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * Managing the Router from the console (docs/ROUTER.md): where it listens, which connections are resting after
 * failures, and its keys. Administrators only; a new key is shown once, in the answer that makes it.
 *
 *   GET    /api/router              status, models a client can name, keys (never the keys themselves)
 *   POST   /api/router/keys         { name } → { key, view }
 *   DELETE /api/router/keys/:id
 */

export interface RouterHandle {
  router: Router;
  keys: RouterKeys;
  /** Where the listener is, or null when it is switched off (EPC_ROUTER_LISTEN=off). */
  listen: () => string | null;
}

const registry = new WeakMap<StateStore, RouterHandle>();
export const registerRouter = (state: StateStore, h: RouterHandle) => void registry.set(state, h);

export async function routerRoutes(ctx: FeatureCtx): Promise<boolean> {
  const { path, method } = ctx;
  if (path !== "/api/router" && !path.startsWith("/api/router/")) return false;
  const E = ctx.HttpError;
  const h = registry.get(ctx.state);
  if (!h) throw new E(503, "router_unavailable", "The Router isn't set up on this host.");
  const s = ctx.session();
  if (s.apiToken) throw new E(403, "ticket_only", "The Router is managed from the console by a signed-in person, not with an API token.");
  if (!(await ctx.asUser((pve) => ctx.isNodeAdmin(pve)))) throw new E(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can manage the Router.");

  if (path === "/api/router" && method === "GET") return ctx.json(200, { listen: h.listen(), models: h.router.models(), resting: h.router.status(), keys: h.keys.list() }), true;
  if (path === "/api/router/keys" && method === "POST") {
    ctx.sameSite();
    const b = await ctx.readJson();
    return ctx.json(201, h.keys.create(b.name, s.username)), true;
  }
  const one = path.match(/^\/api\/router\/keys\/([0-9a-f]{12})$/);
  if (one && method === "DELETE") {
    ctx.sameSite();
    h.keys.revoke(one[1], s.username);
    return ctx.json(200, { ok: true }), true;
  }
  throw new E(404, "not_found", "Not found");
}
