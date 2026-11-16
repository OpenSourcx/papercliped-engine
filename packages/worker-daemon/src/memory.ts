import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";

export function parseMeminfo(text: string) {
  const value = (key: string) => {
    const n = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(text)?.[1];
    return n === undefined ? null : Math.floor(Number(n) / 1024);
  };
  const totalMb = value("MemTotal");
  const availableMb = value("MemAvailable");
  const swapTotalMb = value("SwapTotal") ?? 0;
  return { totalMb, availableMb, swapTotalMb, swapUsedMb: Math.max(0, swapTotalMb - (value("SwapFree") ?? swapTotalMb)) };
}

/** Also respect a container's physical-memory limit; swap limits are not RAM. */
export function memorySnapshot() {
  let snapshot = { totalMb: Math.floor(totalmem() / 1048576), availableMb: null as number | null, swapTotalMb: 0, swapUsedMb: 0 };
  if (process.platform === "linux") {
    try {
      const m = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
      snapshot = { ...m, totalMb: m.totalMb ?? snapshot.totalMb };
    } catch { /* missing telemetry remains unknown, never total memory */ }
    // Node reports effective cgroup v1/v2 limits, including nested containers.
    const constrained = process.constrainedMemory?.();
    const available = process.availableMemory?.();
    if (constrained && constrained > 0 && constrained < snapshot.totalMb * 1048576) {
      snapshot.totalMb = Math.floor(constrained / 1048576);
      if (available !== undefined && snapshot.availableMb !== null) snapshot.availableMb = Math.min(snapshot.availableMb, Math.floor(available / 1048576));
    }
  } else snapshot.availableMb = Math.floor(freemem() / 1048576);
  return snapshot;
}
