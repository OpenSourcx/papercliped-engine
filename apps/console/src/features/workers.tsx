import { Server } from "lucide-react";
import { WorkerDetailPage } from "../pages/workers/WorkerDetail.tsx";
import { WorkersPage } from "../pages/workers/Workers.tsx";
import type { Feature } from "./registry.ts";

/**
 * Worker Fabric: computers the person owns, adopted as persistent places for agents to run (docs/WORKER-FABRIC.md).
 * One list and one detail page under Datacenter; adopting and assigning are modals (?modal=adopt-worker, use-worker).
 * Live only: the demo has no host to adopt into.
 */
export const workersFeature: Feature = {
  id: "workers",
  routes: [
    { path: "datacenter/workers", element: <WorkersPage /> },
    { path: "datacenter/workers/:id", element: <WorkerDetailPage /> },
  ],
  nav: [{ section: "Datacenter", to: "datacenter/workers", label: "Workers", icon: Server, order: 8, liveOnly: true }],
};
