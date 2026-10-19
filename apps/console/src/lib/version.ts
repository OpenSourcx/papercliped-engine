/**
 * Proxmox reports its version as `pve-manager/9.2.3/d0fde103346cf89a` (package, version, build hash). People want "9.2.3":
 * the hash is noise, and as one unbroken word it pushes out of any box it sits in.
 */
export function proxmoxVersion(raw: string | null | undefined): string {
  if (!raw) return "";
  const m = /^pve-manager\/(\d+(?:\.\d+)*)(?:[~+-][\w.~+-]*)?(?:\/|$)/.exec(raw.trim());
  if (m) return m[1];
  const v = /(\d+\.\d+(?:\.\d+)?)/.exec(raw);
  return v ? v[1] : raw.length > 24 ? `${raw.slice(0, 24)}…` : raw;
}
