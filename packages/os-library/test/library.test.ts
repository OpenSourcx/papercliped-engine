import { describe, expect, it } from "vitest";
import { LIBRARY, compareVersions, isoEntries, matchesEntry, parseChecksums, pickLatest } from "../src/index.ts";

const H = "a".repeat(64);
const entry = (id: string) => isoEntries().find((e) => e.id === id)!;

describe("checksum files", () => {
  it("reads GNU style files, with or without the binary marker", () => {
    const t = `${H}  debian-13.7.0-amd64-netinst.iso\n${"b".repeat(64)} *ubuntu-24.04.5-live-server-amd64.iso\nnot a line\n`;
    expect(parseChecksums(t, "gnu")).toEqual([
      { file: "debian-13.7.0-amd64-netinst.iso", hash: H, algorithm: "sha256" },
      { file: "ubuntu-24.04.5-live-server-amd64.iso", hash: "b".repeat(64), algorithm: "sha256" },
    ]);
  });

  it("reads BSD style files inside a signed block", () => {
    const t = `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n# Rocky-9.8-x86_64-minimal.iso: 1480048640 bytes\nSHA256 (Rocky-9.8-x86_64-minimal.iso) = ${H}\nSHA256 (broken.iso) = nothex\n`;
    expect(parseChecksums(t, "bsd")).toEqual([{ file: "Rocky-9.8-x86_64-minimal.iso", hash: H, algorithm: "sha256" }]);
  });

  it("reads Alpine's release list", () => {
    const t = `-\n  flavor: alpine-virt\n  file: alpine-virt-3.24.2-x86_64.iso\n  size: 69206016\n  sha256: ${H}\n  sha512: ${"c".repeat(128)}\n-\n  file: alpine-xen-3.24.2-x86_64.iso\n  sha256: ${"d".repeat(64)}\n`;
    expect(parseChecksums(t, "alpine").map((c) => c.file)).toEqual(["alpine-virt-3.24.2-x86_64.iso", "alpine-xen-3.24.2-x86_64.iso"]);
  });
});

describe("picking the newest installer", () => {
  it("compares versions numerically, so 13.10 beats 13.7", () => {
    expect(compareVersions("13.10.0", "13.7.0")).toBeGreaterThan(0);
    expect(compareVersions("24.04.5", "24.04.4")).toBeGreaterThan(0);
    expect(compareVersions("9.8", "9.8")).toBe(0);
    expect(compareVersions("2026.10.01", "2026.9.30")).toBeGreaterThan(0);
  });

  it("picks the newest Ubuntu server image and ignores desktop and WSL", () => {
    const t = ["24.04.3-desktop-amd64.iso", "24.04.4-live-server-amd64.iso", "24.04.5-live-server-amd64.iso", "24.04.3-live-server-amd64.iso", "24.04.5-wsl-amd64.wsl"].map((f, i) => `${String(i).repeat(64)}  *ubuntu-${f}`).join("\n");
    expect(pickLatest(entry("ubuntu-lts"), t)).toMatchObject({ version: "24.04.5", filename: "ubuntu-24.04.5-live-server-amd64.iso", url: "https://releases.ubuntu.com/noble/ubuntu-24.04.5-live-server-amd64.iso", algorithm: "sha256" });
  });

  it("picks the plain Debian netinst, not the edu or mac variants", () => {
    const t = [`${"1".repeat(64)}  debian-edu-13.7.0-amd64-netinst.iso`, `${"2".repeat(64)}  debian-13.7.0-amd64-netinst.iso`, `${"3".repeat(64)}  debian-mac-13.7.0-amd64-netinst.iso`].join("\n");
    expect(pickLatest(entry("debian"), t)).toMatchObject({ filename: "debian-13.7.0-amd64-netinst.iso", checksum: "2".repeat(64) });
  });

  it("returns null when the vendor's file has nothing we recognise", () => {
    expect(pickLatest(entry("arch"), "nothing here")).toBeNull();
  });
});

describe("the catalog", () => {
  it("uses only https vendor addresses and unique ids", () => {
    expect(new Set(LIBRARY.map((e) => e.id)).size).toBe(LIBRARY.length);
    for (const e of LIBRARY) {
      const urls = e.kind === "iso" ? [e.source.sums, e.source.baseUrl] : e.kind === "fixed" ? [e.url] : [e.pageUrl];
      for (const u of urls) expect(u.startsWith("https://"), `${e.id} ${u}`).toBe(true);
      if (e.kind === "iso") expect(e.source.baseUrl.endsWith("/")).toBe(true);
    }
  });

  it("recognises downloaded files as versions of an entry", () => {
    expect(matchesEntry(entry("alpine"), "alpine-virt-3.22.1-x86_64.iso")).toEqual({ version: "3.22.1" });
    expect(matchesEntry(entry("alpine"), "alpine-standard-3.22.1-x86_64.iso")).toBeNull();
    expect(matchesEntry(LIBRARY.find((e) => e.id === "virtio-win")!, "virtio-win.iso")).toEqual({ version: null });
  });
});
