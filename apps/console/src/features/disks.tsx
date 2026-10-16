import { Database, HardDrive, HeartPulse } from "lucide-react";
import { StorageHealthPage } from "../pages/disks/StorageHealth.tsx";
import { DisksPage } from "../pages/disks/DisksPage.tsx";
import { StorageDefinitions } from "../pages/disks/StorageDefinitions.tsx";
import type { Feature } from "./registry.ts";

/** Physical disks and storage built on them (Host), and storage definitions (Datacenter). Works in the demo too. */
export const disksFeature: Feature = {
  id: "disks",
  routes: [
    { path: "disks", element: <DisksPage /> },
    { path: "storage-settings", element: <StorageDefinitions /> },
    { path: "storage-health", element: <StorageHealthPage /> },
  ],
  nav: [
    { section: "Host", to: "disks", label: "Disks", icon: HardDrive, order: 40 },
    { section: "Host", to: "storage-health", label: "Storage health", icon: HeartPulse, order: 41, liveOnly: true },
    { section: "Datacenter", to: "storage-settings", label: "Storage settings", icon: Database, order: 40 },
  ],
};
