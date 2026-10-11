/**
 * The operating systems ePaperclip's Library offers, and how to find each one's newest installer without hard-coding
 * a version. Each entry names a vendor's own published checksum file; the newest matching installer is picked from it
 * and downloaded with that checksum, so what lands on the drive is verified against the vendor's own list.
 *
 * Pure data and parsers, shared by the host service (which fetches the files) and the console.
 */

export type ChecksumFormat = "gnu" | "bsd" | "alpine";

export interface IsoSource {
  /** The vendor's checksum file. Only ever fetched by the host service, from exactly this address. */
  sums: string;
  format: ChecksumFormat;
  /** Regular expression source matching installer file names; capture group 1 is the version. */
  match: string;
  /** Where files named in the checksum file are downloaded from (ends with "/"). */
  baseUrl: string;
}

interface Base {
  id: string;
  name: string;
  vendor: string;
  summary: string;
  /** Proxmox OS type for a VM made from it. */
  ostype: "l26" | "win11" | "other";
  /** A comfortable first size for a VM, as the New machine dialog's Small/Medium/Large. */
  size: "small" | "medium" | "large";
}

export type LibraryEntry =
  | (Base & { kind: "iso"; source: IsoSource })
  | (Base & { kind: "fixed"; url: string; filename: string; note: string })
  | (Base & { kind: "manual"; pageUrl: string; note: string });

export const LIBRARY: LibraryEntry[] = [
  { id: "debian", kind: "iso", name: "Debian", vendor: "Debian", summary: "Stable, predictable and well documented. The usual choice for servers.", ostype: "l26", size: "small", source: { sums: "https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/SHA256SUMS", format: "gnu", match: "^debian-(\\d+\\.\\d+\\.\\d+)-amd64-netinst\\.iso$", baseUrl: "https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/" } },
  { id: "ubuntu-lts", kind: "iso", name: "Ubuntu Server 24.04 LTS", vendor: "Canonical", summary: "Long-term support release with five years of updates.", ostype: "l26", size: "small", source: { sums: "https://releases.ubuntu.com/noble/SHA256SUMS", format: "gnu", match: "^ubuntu-(\\d+\\.\\d+(?:\\.\\d+)?)-live-server-amd64\\.iso$", baseUrl: "https://releases.ubuntu.com/noble/" } },
  { id: "alpine", kind: "iso", name: "Alpine Linux (virtual)", vendor: "Alpine", summary: "Tiny and fast. Built for virtual machines.", ostype: "l26", size: "small", source: { sums: "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64/latest-releases.yaml", format: "alpine", match: "^alpine-virt-(\\d+\\.\\d+\\.\\d+)-x86_64\\.iso$", baseUrl: "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64/" } },
  { id: "rocky-9", kind: "iso", name: "Rocky Linux 9", vendor: "Rocky Enterprise Software Foundation", summary: "Free, community-built Red Hat Enterprise Linux compatible system.", ostype: "l26", size: "medium", source: { sums: "https://download.rockylinux.org/pub/rocky/9/isos/x86_64/CHECKSUM", format: "bsd", match: "^Rocky-(\\d+\\.\\d+)-x86_64-minimal\\.iso$", baseUrl: "https://download.rockylinux.org/pub/rocky/9/isos/x86_64/" } },
  { id: "alma-9", kind: "iso", name: "AlmaLinux 9", vendor: "AlmaLinux OS Foundation", summary: "Another free Red Hat Enterprise Linux compatible system.", ostype: "l26", size: "medium", source: { sums: "https://repo.almalinux.org/almalinux/9/isos/x86_64/CHECKSUM", format: "bsd", match: "^AlmaLinux-(\\d+\\.\\d+)-x86_64-minimal\\.iso$", baseUrl: "https://repo.almalinux.org/almalinux/9/isos/x86_64/" } },
  { id: "arch", kind: "iso", name: "Arch Linux", vendor: "Arch Linux", summary: "Rolling release, built up from the basics. For people who like control.", ostype: "l26", size: "small", source: { sums: "https://geo.mirror.pkgbuild.com/iso/latest/sha256sums.txt", format: "gnu", match: "^archlinux-(\\d{4}\\.\\d{2}\\.\\d{2})-x86_64\\.iso$", baseUrl: "https://geo.mirror.pkgbuild.com/iso/latest/" } },
  { id: "virtio-win", kind: "fixed", name: "VirtIO drivers for Windows", vendor: "Fedora Project", summary: "Drivers Windows needs to see VirtIO disks and network cards. Attach it as a second CD drive during Windows setup.", ostype: "win11", size: "small", url: "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso", filename: "virtio-win.iso", note: "The vendor doesn't publish a checksum next to it, so this download isn't verified." },
  { id: "windows-11", kind: "manual", name: "Windows 11", vendor: "Microsoft", summary: "Microsoft doesn't allow direct downloads from other sites. Download the ISO from Microsoft, then upload it here.", ostype: "win11", size: "medium", pageUrl: "https://www.microsoft.com/software-download/windows11", note: "Needs a license to stay activated. Gets UEFI, Secure Boot and a TPM automatically." },
  { id: "windows-server", kind: "manual", name: "Windows Server (evaluation)", vendor: "Microsoft", summary: "A free evaluation version from Microsoft's Evaluation Center. Download the ISO there, then upload it here.", ostype: "win11", size: "medium", pageUrl: "https://www.microsoft.com/evalcenter/", note: "Evaluation copies run for a limited time." },
];

export const isoEntries = () => LIBRARY.filter((e): e is Extract<LibraryEntry, { kind: "iso" }> => e.kind === "iso");

export interface Checksum {
  file: string;
  hash: string;
  algorithm: "sha256" | "sha512";
}

const HEX = /^[0-9a-f]{64}$|^[0-9a-f]{128}$/i;
const algoOf = (h: string) => (h.length === 128 ? "sha512" : "sha256");

/** Reads a vendor's checksum file in any of the formats the Library uses into a plain list. */
export function parseChecksums(text: string, format: ChecksumFormat): Checksum[] {
  const out: Checksum[] = [];
  if (format === "gnu") {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([0-9a-fA-F]{64}|[0-9a-fA-F]{128})\s+\*?(\S+)\s*$/);
      if (m) out.push({ file: m[2], hash: m[1].toLowerCase(), algorithm: algoOf(m[1]) });
    }
  } else if (format === "bsd") {
    // "SHA256 (file) = hash", possibly inside a PGP-signed block.
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^SHA(256|512) \(([^)\s]+)\) = ([0-9a-fA-F]+)\s*$/);
      if (m && HEX.test(m[3])) out.push({ file: m[2], hash: m[3].toLowerCase(), algorithm: m[1] === "512" ? "sha512" : "sha256" });
    }
  } else {
    // Alpine's latest-releases.yaml: blocks with `file:` followed by `sha256:`.
    let file: string | null = null;
    for (const line of text.split(/\r?\n/)) {
      const f = line.match(/^\s+file:\s*(\S+)\s*$/);
      if (f) file = f[1];
      const h = line.match(/^\s+sha256:\s*([0-9a-fA-F]{64})\s*$/);
      if (h && file) {
        out.push({ file, hash: h[1].toLowerCase(), algorithm: "sha256" });
        file = null;
      }
    }
  }
  return out;
}

/** "13.7.0" > "13.10.0"? No: compares numeric parts, so 13.10.0 is newer than 13.7.0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export interface Latest {
  id: string;
  version: string;
  filename: string;
  url: string;
  checksum: string;
  algorithm: "sha256" | "sha512";
}

/** The newest installer an entry's checksum file lists, with its checksum. Null when nothing matches. */
export function pickLatest(entry: Extract<LibraryEntry, { kind: "iso" }>, sumsText: string): Latest | null {
  const re = new RegExp(entry.source.match);
  let best: { c: Checksum; version: string } | null = null;
  for (const c of parseChecksums(sumsText, entry.source.format)) {
    const m = c.file.match(re);
    if (!m) continue;
    if (!best || compareVersions(m[1].replace(/\./g, "."), best.version) > 0) best = { c, version: m[1] };
  }
  return best && { id: entry.id, version: best.version, filename: best.c.file, url: `${entry.source.baseUrl}${best.c.file}`, checksum: best.c.hash, algorithm: best.c.algorithm };
}

/** Whether a file name on a drive is some version of an entry's installer. */
export function matchesEntry(entry: LibraryEntry, filename: string): { version: string | null } | null {
  if (entry.kind === "iso") {
    const m = filename.match(new RegExp(entry.source.match));
    return m ? { version: m[1] } : null;
  }
  if (entry.kind === "fixed") return filename === entry.filename ? { version: null } : null;
  return null;
}
