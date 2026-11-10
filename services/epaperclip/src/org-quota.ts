import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import type { StateStore } from "./state.ts";

/**
 * Why an organization cannot get another agent container right now, when the answer is its own resource group.
 *
 * The engine hides the real reason: a sandbox provider failure becomes a bare "Internal server error" on the routes that
 * touch secrets (sign-in, credentials). The host knows the organization's resource group and can read its pool, so it
 * says what is full. Same counting as the provider's own quota check (plugins/proxmox-sandbox: templates excluded).
 * Returns null when the pool is not full, or when it cannot be read: no guess is better than a wrong one.
 */
export async function explainOrgQuota(state: StateStore, pve: ProxmoxClient, companyId: string): Promise<string | null> {
  const group = state.getSetting<Record<string, { pool?: string; cores?: number; memoryMb?: number; maxGuests?: number }>>("resourceGroups")?.[companyId];
  if (!group?.pool) return null;
  let members: { type?: string; template?: number; maxcpu?: number; maxmem?: number }[];
  try {
    members = ((await pve.call<{ members?: unknown[] }>("GET", `/pools/${encodeURIComponent(group.pool)}`))?.members ?? []) as typeof members;
  } catch {
    return null;
  }
  const guests = members.filter((m) => (m.type === "lxc" || m.type === "qemu") && Number(m.template ?? 0) !== 1);
  const cores = guests.reduce((n, m) => n + (Number(m.maxcpu) || 0), 0);
  const memoryMb = guests.reduce((n, m) => n + Math.ceil((Number(m.maxmem) || 0) / (1024 * 1024)), 0);
  const full: string[] = [];
  if (group.maxGuests && guests.length >= group.maxGuests) full.push(`machines (${guests.length} of ${group.maxGuests} in use)`);
  if (group.cores && cores >= group.cores) full.push(`CPU cores (${cores} of ${group.cores} in use)`);
  if (group.memoryMb && memoryMb >= group.memoryMb) full.push(`memory (${memoryMb} of ${group.memoryMb} MiB in use)`);
  if (!full.length) return null;
  return `The organization's resource group ${group.pool} is full: ${full.join("; ")}. The engine could not start a container for this. Stop or remove a machine in the pool, or raise the organization's limits.`;
}
