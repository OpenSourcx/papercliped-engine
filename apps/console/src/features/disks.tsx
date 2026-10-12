import { Database, HardDrive } from "lucide-react";
import { DisksPage } from "../pages/disks/DisksPage.tsx";
import { StorageDefinitions } from "../pages/disks/StorageDefinitions.tsx";
import type { Feature } from "./registry.ts";

/** Physical disks and storage built on them (Host), and storage definitions (Datacenter). Works in the demo too. */
export const disksFeature: Feature = {
  id: "disks",
  routes: [
    { path: "disks", element: <DisksPage /> },
    { path: "storage-settings", element: <StorageDefinitions /> },
  ],
  nav: [
    { section: "Host", to: "disks", label: "Disks", icon: HardDrive, order: 40 },
    { section: "Datacenter", to: "storage-settings", label: "Storage settings", icon: Database, order: 40 },
  ],
};
