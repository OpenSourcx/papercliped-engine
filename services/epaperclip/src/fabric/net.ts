import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import type { NetInfo } from "@papercliped-engine/worker-fabric";

/** What this machine's network looks like, for transport detection. Tailscale is only asked, never required. */
export function realNetInfo(customUrl: string | null): NetInfo {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync("tailscale", args, { timeout: 4000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
  const interfaces: NetInfo["interfaces"] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) for (const a of list ?? []) if (!a.internal) interfaces.push({ name, address: a.address, family: a.family as "IPv4" | "IPv6" });
  return { tailscaleStatus: run(["status", "--json"]), tailscaleIp: run(["ip", "-4"])?.split("\n")[0]?.trim() || null, interfaces, customUrl };
}
