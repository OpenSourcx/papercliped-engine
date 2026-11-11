import type { ContainersStatus } from "../data/engine/host.ts";

/** The device-home status phrase. "running smoothly" is only for when no known condition applies (ERR-CON-001). */
export function deviceCondition(host: { cpuPct: number; memUsed: number; memTotal: number }, containers?: Pick<ContainersStatus, "state" | "job" | "templateAttempts" | "error"> | null): string {
  if (containers) {
    if (containers.state === "error") return "needs attention: Agent Containers is in error";
    if (containers.job?.status === "failed" || (containers.templateAttempts ?? 0) >= 3) return "needs attention: Agent Containers setup failed";
    if (containers.state === "partial") return "needs attention: Agent Containers setup is incomplete";
  }
  if (host.memTotal > 0 && host.memUsed / host.memTotal >= 0.9) return "is low on memory";
  if (host.cpuPct >= 70) return "is busy";
  return "is running smoothly";
}
