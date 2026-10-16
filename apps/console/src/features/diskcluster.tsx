import { Archive, LayoutGrid, Waypoints } from "lucide-react";
import { BackupJobsPage } from "../pages/backups/BackupJobs.tsx";
import { ClusterResourcesPage } from "../pages/cluster/ResourcesPage.tsx";
import { SdnRoutedPage } from "../pages/cluster/SdnRouted.tsx";
import type { Feature } from "./registry.ts";

/** Backup jobs with every option, cluster-wide resources, and routed networks (EVPN, fabrics). See docs/DISKS.md and docs/CLUSTER.md. */
export const diskClusterFeature: Feature = {
  id: "diskcluster",
  routes: [
    { path: "datacenter/backup-jobs", element: <BackupJobsPage /> },
    { path: "datacenter/resources", element: <ClusterResourcesPage /> },
    { path: "datacenter/routed-networks", element: <SdnRoutedPage /> },
  ],
  nav: [
    { section: "Datacenter", to: "datacenter/backup-jobs", label: "Backup jobs", icon: Archive, order: 45, liveOnly: true },
    { section: "Datacenter", to: "datacenter/resources", label: "Resources", icon: LayoutGrid, order: 8, liveOnly: true },
    { section: "Datacenter", to: "datacenter/routed-networks", label: "Routed networks", icon: Waypoints, order: 46, liveOnly: true },
  ],
};
