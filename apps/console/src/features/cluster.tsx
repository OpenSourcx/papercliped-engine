import { Database, Network, RefreshCw, ShieldCheck } from "lucide-react";
import { CephPage } from "../pages/cluster/CephPage.tsx";
import { ClusterConfigPage } from "../pages/cluster/ClusterPage.tsx";
import { HaPage } from "../pages/cluster/HaPage.tsx";
import { ReplicationPage } from "../pages/cluster/ReplicationPage.tsx";
import type { Feature } from "./registry.ts";

/**
 * The cluster: create and join, nodes and quorum, high availability, replication and Ceph. Migration lives on the
 * machine page. On a single device every screen says so calmly and offers Create cluster. See docs/CLUSTER.md.
 */
export const clusterFeature: Feature = {
  id: "cluster",
  routes: [
    { path: "datacenter/cluster", element: <ClusterConfigPage /> },
    { path: "datacenter/ha", element: <HaPage /> },
    { path: "datacenter/replication", element: <ReplicationPage /> },
    { path: "datacenter/ceph", element: <CephPage /> },
  ],
  nav: [
    { section: "Datacenter", to: "datacenter/cluster", label: "Cluster", icon: Network, order: 9, liveOnly: true },
    { section: "Datacenter", to: "datacenter/ha", label: "High availability", icon: ShieldCheck, order: 20, liveOnly: true },
    { section: "Datacenter", to: "datacenter/replication", label: "Replication", icon: RefreshCw, order: 21, liveOnly: true },
    { section: "Datacenter", to: "datacenter/ceph", label: "Ceph", icon: Database, order: 22, liveOnly: true },
  ],
};
