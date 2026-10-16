import { HttpError } from "../http.ts";
import type { FeatureHandler } from "./index.ts";
import type { Route } from "./nodeCommon.ts";

/**
 * One handler for a table of routes under a path prefix: sign-in is required for every route, a path that exists with
 * another method answers 405, and anything else is left for the next feature (and finally the 404).
 */
export function routeTable(prefix: string, routes: Route[]): FeatureHandler {
  return async (ctx) => {
    if (!ctx.path.startsWith(prefix)) return false;
    let known = false;
    for (const r of routes) {
      const m = ctx.path.match(r.re);
      if (!m) continue;
      known = true;
      if (r.method !== ctx.method) continue;
      ctx.session();
      await r.run(ctx, m);
      return true;
    }
    if (known) throw new HttpError(405, "method", "Method not allowed");
    return false;
  };
}
