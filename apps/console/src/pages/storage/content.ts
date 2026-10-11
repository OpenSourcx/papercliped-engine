import type { ContentKind } from "../../data/api.ts";
import type { HostStorage } from "../../data/types.ts";

/** The content tabs a storage shows, in Proxmox's order, from the content types it is configured for. */
export const TABS: { kind: ContentKind; label: string; from: string; empty: string }[] = [
  { kind: "iso", label: "ISO images", from: "ISO images", empty: "Upload an ISO or have Proxmox download one from a URL, then boot virtual machines from it." },
  { kind: "vztmpl", label: "CT templates", from: "Templates", empty: "Container templates are the starting systems for new containers. Get them from the catalog or a URL." },
  { kind: "backup", label: "Backups", from: "Backups", empty: "Backups of machines kept on this storage show up here." },
  { kind: "images", label: "VM disks", from: "Disk images", empty: "Virtual machine disks on this storage show up here." },
  { kind: "rootdir", label: "CT volumes", from: "Containers", empty: "Container volumes on this storage show up here." },
  { kind: "snippets", label: "Snippets", from: "Snippets", empty: "Cloud-init and hook script snippets show up here." },
];

export const tabsFor = (s: HostStorage | undefined) => TABS.filter((t) => s?.content.includes(t.from));

/** "local:iso/debian.iso" -> "debian.iso"; "local:109/vm-109-disk-0.qcow2" -> "vm-109-disk-0.qcow2" */
export const volName = (volid: string) => volid.slice(volid.indexOf(":") + 1).split("/").pop() ?? volid;

export const storagesWith = (all: HostStorage[], kind: "iso" | "vztmpl") => all.filter((s) => s.active !== false && s.content.includes(kind === "iso" ? "ISO images" : "Templates"));

/** A file name Proxmox will accept for the content type, or why not. */
export function fileNameError(name: string, kind: "iso" | "vztmpl"): string | null {
  if (!name) return "Enter a file name.";
  if (kind === "iso" ? !/^\w[\w.+-]{0,200}\.(iso|img)$/i.test(name) : !/^\w[\w.+-]{0,200}\.tar\.(gz|xz|zst)$/.test(name)) return kind === "iso" ? "Use letters, digits, . - + _ and end in .iso or .img." : "Use letters, digits, . - + _ and end in .tar.gz, .tar.xz or .tar.zst.";
  return null;
}

/** The file name at the end of a download address, if it has one. */
export function nameFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    return "";
  }
}
