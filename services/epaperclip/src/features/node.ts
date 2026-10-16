import { HttpError } from "../http.ts";
import type { FeatureHandler } from "./index.ts";
import { certRoutes } from "./nodeCerts.ts";
import type { Deps, Route } from "./nodeCommon.ts";
import { backupRoutes } from "./dcBackup.ts";
import { mappingRoutes } from "./dcMapping.ts";
import { sdnRoutes } from "./dcSdn.ts";
import { datacenterRoutes } from "./nodeDatacenter.ts";
import { nodeHardwareRoutes } from "./nodeHardware.ts";
import { systemRoutes } from "./nodeSystem.ts";
import { serverOf, TlsReloader } from "./nodeTls.ts";

/**
 * Node and datacenter operations that replace Proxmox's own screens: services, time, logs, power, subscription,
 * updates and repositories, certificates and ACME, datacenter options, notifications, metric servers, mappings, tags,
 * the cluster summary and tasks across nodes. Everything runs as the signed-in person; Proxmox decides permissions.
 * Node-scoped routes take an optional `node` (query or body) that is checked against the cluster. See docs/NODE.md.
 */
export function createNodeFeature(opts: { tls?: TlsReloader; pollMs?: number } = {}): FeatureHandler {
  const deps: Deps = { tls: opts.tls ?? new TlsReloader(), pollMs: opts.pollMs ?? 3000 };
  const routes: Route[] = [...systemRoutes(deps), ...certRoutes(deps), ...datacenterRoutes(deps), ...nodeHardwareRoutes(deps), ...backupRoutes(deps), ...sdnRoutes(deps), ...mappingRoutes(deps)];
  return async (ctx) => {
    if (!ctx.path.startsWith("/api/node/")) return false;
    // Learn which TLS server we are on so a changed node certificate can be swapped in (see nodeTls.ts).
    deps.tls.attach(serverOf(ctx.req));
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

export const nodeFeature = createNodeFeature();
