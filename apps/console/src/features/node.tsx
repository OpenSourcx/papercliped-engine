import { Activity, Archive, ArrowUpCircle, BellRing, Boxes, Clock, Cog, Cpu, HardDrive, Layers, ListChecks, Network, Palette, Power, ScrollText, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { BackupPage } from "../pages/node/Backup.tsx";
import { BulkPage } from "../pages/node/Bulk.tsx";
import { CertificatesPage } from "../pages/node/Certificates.tsx";
import { ClusterPage, OptionsPage, TagsPage, TasksAllPage } from "../pages/node/Datacenter.tsx";
import { HardwarePage } from "../pages/node/Hardware.tsx";
import { LogsPage } from "../pages/node/Logs.tsx";
import { MappingsManagePage } from "../pages/node/MappingsManage.tsx";
import { MetricsPage } from "../pages/node/Metrics.tsx";
import { NotificationsPage } from "../pages/node/Notifications.tsx";
import { PowerPage } from "../pages/node/Power.tsx";
import { ResourceTreePage } from "../pages/node/ResourceTree.tsx";
import { SdnPage } from "../pages/node/Sdn.tsx";
import { ServicesPage, TimePage } from "../pages/node/Services.tsx";
import { NodeUpdatesPage } from "../pages/node/UpdatesPage.tsx";
import type { Feature } from "./registry.ts";

/**
 * Node and datacenter operations that stand in for Proxmox's own screens: services, time, logs, updates and
 * repositories, certificates and ACME, power and subscription; datacenter summary, options, notifications, metric
 * servers, resource mappings, tags and tasks. Every entry works on a connected device only. See docs/NODE.md.
 */
export const nodeFeature: Feature = {
  id: "node",
  routes: [
    { path: "host/services", element: <ServicesPage /> },
    { path: "host/time", element: <TimePage /> },
    { path: "host/logs", element: <LogsPage /> },
    { path: "host/updates", element: <NodeUpdatesPage /> },
    { path: "host/certificates", element: <CertificatesPage /> },
    { path: "host/hardware", element: <HardwarePage /> },
    { path: "host/bulk", element: <BulkPage /> },
    { path: "host/power", element: <PowerPage /> },
    { path: "datacenter/summary", element: <ClusterPage /> },
    { path: "datacenter/options", element: <OptionsPage /> },
    { path: "datacenter/notifications", element: <NotificationsPage /> },
    { path: "datacenter/metrics", element: <MetricsPage /> },
    { path: "datacenter/mappings", element: <MappingsManagePage /> },
    { path: "datacenter/tags", element: <TagsPage /> },
    { path: "datacenter/backup", element: <BackupPage /> },
    { path: "datacenter/sdn", element: <SdnPage /> },
    { path: "datacenter/resources", element: <ResourceTreePage /> },
    { path: "tasks/all", element: <TasksAllPage /> },
  ],
  nav: [
    { section: "Host", to: "host/services", label: "Services", icon: Cog, order: 60, liveOnly: true },
    { section: "Host", to: "host/time", label: "Time", icon: Clock, order: 61, liveOnly: true },
    { section: "Host", to: "host/logs", label: "Logs", icon: ScrollText, order: 62, liveOnly: true },
    { section: "Host", to: "host/updates", label: "Updates", icon: ArrowUpCircle, order: 63, liveOnly: true },
    { section: "Host", to: "host/certificates", label: "Certificates", icon: ShieldCheck, order: 64, liveOnly: true },
    { section: "Host", to: "host/hardware", label: "Hardware", icon: HardDrive, order: 59, liveOnly: true },
    { section: "Host", to: "host/bulk", label: "All machines", icon: Layers, order: 66, liveOnly: true },
    { section: "Host", to: "host/power", label: "Power and subscription", icon: Power, order: 65, liveOnly: true },
    { section: "Datacenter", to: "datacenter/summary", label: "Datacenter", icon: Boxes, order: 10, liveOnly: true },
    { section: "Datacenter", to: "datacenter/options", label: "Options", icon: SlidersHorizontal, order: 11, liveOnly: true },
    { section: "Datacenter", to: "datacenter/notifications", label: "Notifications", icon: BellRing, order: 12, liveOnly: true },
    { section: "Datacenter", to: "datacenter/metrics", label: "Metric servers", icon: Activity, order: 13, liveOnly: true },
    { section: "Datacenter", to: "datacenter/mappings", label: "Resource mappings", icon: Cpu, order: 14, liveOnly: true },
    { section: "Datacenter", to: "datacenter/tags", label: "Tags", icon: Palette, order: 15, liveOnly: true },
    { section: "Datacenter", to: "datacenter/resources", label: "Resources", icon: Boxes, order: 9, liveOnly: true },
    { section: "Datacenter", to: "datacenter/backup", label: "Backup", icon: Archive, order: 17, liveOnly: true },
    { section: "Datacenter", to: "datacenter/sdn", label: "Virtual networks", icon: Network, order: 18, liveOnly: true },
    { section: "Datacenter", to: "tasks/all", label: "All tasks", icon: ListChecks, order: 16, liveOnly: true },
  ],
};
