import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { MachineError, type Cfg, type Change } from "@papercliped-engine/proxmox-client/machine-schema";
import { digest } from "./disksCheck.ts";
import type { FeatureCtx } from "./index.ts";

/** Pieces the machine features share: finding the machine, the digest and lock guard, and writing a planned change. */

export const seg = encodeURIComponent;
export type Found = { node: string; type: "qemu" | "lxc"; status: string; name: string; template: boolean; pool: string | null };

export async function findGuest(ctx: FeatureCtx, pve: ProxmoxClient, vmid: number): Promise<Found> {
  const g = (await pve.clusterResources()).find((r) => r.vmid === vmid);
  if (!g || (g.type !== "lxc" && g.type !== "qemu")) throw new ctx.HttpError(404, "not_found", "Unknown machine");
  return { node: g.node ?? ctx.node, type: g.type as "qemu" | "lxc", status: g.status ?? "unknown", name: g.name ?? String(vmid), template: g.template === 1, pool: g.pool ?? null };
}

export const guestUrl = (g: Found, vmid: number, tail = "") => `/nodes/${seg(g.node)}/${g.type}/${vmid}${tail ? `/${tail}` : ""}`;

/** Reads the configuration and checks the digest from the page and that nothing else is busy with the machine. */
export async function guardedConfig(ctx: FeatureCtx, pve: ProxmoxClient, g: Found, vmid: number, body: Record<string, unknown>): Promise<{ cfg: Cfg; digest: string }> {
  const dg = digest(body.digest);
  const cfg = await pve.call<Cfg>("GET", guestUrl(g, vmid, "config"));
  if (cfg.digest !== dg) throw new ctx.HttpError(409, "stale", "This machine changed since the page loaded. Reload and try again.");
  if (typeof cfg.lock === "string") throw new ctx.HttpError(409, "busy", `This machine is busy (${cfg.lock}). Try again when it's done.`);
  return { cfg, digest: dg };
}

/** Writes a planned change as one configuration update (with the digest), and says whether it waits for a restart. */
export async function writeChange(pve: ProxmoxClient, g: Found, vmid: number, change: Change, dg: string): Promise<{ ok: true; pending: boolean; warnings: string[] }> {
  const params: Record<string, string> = { ...change.set, digest: dg };
  if (change.delete.length) params.delete = [...new Set(change.delete)].join(",");
  await pve.call("PUT", guestUrl(g, vmid, "config"), params);
  return { ok: true, pending: g.status === "running", warnings: change.warnings };
}

/** A shared-check failure becomes a 400 with its sentence. */
export function asBadRequest(ctx: FeatureCtx, e: unknown): never {
  if (e instanceof MachineError) throw new ctx.HttpError(400, "bad_request", e.message);
  throw e;
}

export const isRoot = (username: string) => username === "root@pam";

/** Choices the editors offer; each read is allowed to fail for a person without the privilege. */
export const soft = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ProxmoxError) return null;
    throw e;
  }
};
