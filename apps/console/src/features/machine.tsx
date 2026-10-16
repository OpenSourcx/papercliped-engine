import { Cpu } from "lucide-react";
import { CpuModelsPage } from "../pages/machines/CpuModels.tsx";
import type { Feature } from "./registry.ts";

/** Datacenter screens for machines: custom CPU models and what the device's virtualization supports. See docs/MACHINE.md. */
export const machineFeature: Feature = {
  id: "machine",
  routes: [{ path: "datacenter/cpu-models", element: <CpuModelsPage /> }],
  nav: [{ section: "Datacenter", to: "datacenter/cpu-models", label: "CPU models", icon: Cpu, order: 14 }],
};
