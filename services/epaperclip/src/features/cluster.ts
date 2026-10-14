import { HttpError } from "../http.ts";
import { clusterCephRoutes } from "./clusterCeph.ts";
import { clusterCephWriteRoutes } from "./clusterCephWrite.ts";
import { clusterExtraRoutes } from "./clusterExtra.ts";
import { clusterSdnRoutes } from "./clusterSdn.ts";
import { clusterConfigRoutes } from "./clusterConfig.ts";
import { clusterHaRoutes } from "./clusterHa.ts";
import { clusterMigrateRoutes } from "./clusterMigrate.ts";
import { clusterReplRoutes } from "./clusterRepl.ts";
import type { FeatureHandler } from "./index.ts";
import type { Route } from "./nodeCommon.ts";

/**
 * The cluster: create and join, nodes and quorum, high availability, replication, migration, backups across nodes
 * and Ceph. Everything runs as the signed-in person; Proxmox decides permissions. Single devices get calm answers
 * (`clustered: false`), never errors. See docs/CLUSTER.md.
 */
export function createClusterFeature(): FeatureHandler {
  const routes: Route[] = [...clusterConfigRoutes(), ...clusterHaRoutes(), ...clusterReplRoutes(), ...clusterMigrateRoutes(), ...clusterCephRoutes(), ...clusterCephWriteRoutes(), ...clusterExtraRoutes(), ...clusterSdnRoutes()];
  return async (ctx) => {
    if (!ctx.path.startsWith("/api/cluster/")) return false;
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

export const handleCluster = createClusterFeature();
