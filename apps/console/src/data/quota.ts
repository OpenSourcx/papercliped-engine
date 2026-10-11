import type { Guest, Org } from "./types.ts";

/** What an organization's resource group still has room for, from the machines it already owns. */
export function orgRoom(org: Org, guests: Guest[]) {
  const mine = guests.filter((g) => g.org === org.slug);
  const usedCores = mine.reduce((n, g) => n + g.cores, 0);
  const usedMemMb = Math.round(mine.reduce((n, g) => n + g.memMax, 0) / 1024 ** 2);
  const usedDiskGb = Math.round(mine.reduce((n, g) => n + g.diskMax, 0) / 1e9);
  const rg = org.resourceGroup;
  return {
    guests: rg.maxGuests - mine.length,
    cores: rg.cores - usedCores,
    memoryMb: rg.memoryMb - usedMemMb,
    diskGb: rg.diskGb - usedDiskGb,
  };
}

/** Why a machine of this size doesn't fit the organization, or null when it does. */
export function roomError(room: ReturnType<typeof orgRoom>, size: { cores: number; memoryMb: number; diskGb: number }): string | null {
  if (room.guests < 1) return "This organization already has as many machines as its resource group allows.";
  if (size.cores > room.cores) return `Only ${Math.max(0, room.cores)} core${room.cores === 1 ? "" : "s"} left in this organization's resource group.`;
  if (size.memoryMb > room.memoryMb) return `Only ${Math.max(0, Math.floor(room.memoryMb / 1024 * 10) / 10)} GiB of memory left in this organization's resource group.`;
  if (size.diskGb > room.diskGb) return `Only ${Math.max(0, room.diskGb)} GB of disk left in this organization's resource group.`;
  return null;
}
