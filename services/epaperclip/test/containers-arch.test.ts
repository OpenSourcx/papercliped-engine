import { describe, expect, it } from "vitest";
import { hostArch, newestDebian, storageVerdict } from "../src/containers.ts";

/**
 * The owner's real failure: the host is an Intel Xeon (amd64), its template catalog listed both an amd64 and a newer arm64
 * Debian 13 image, and setup sorted by version alone. Proxmox unpacked the arm64 root filesystem, so /sbin/init could not
 * run and LXC reported only that the init process died. These tests pin the two rules that prevent it.
 */
describe("picking the container template for the host's processor", () => {
  const BOTH = [
    "debian-13-standard_13.1-2_amd64.tar.zst",
    "debian-13-standard_13.6-1_arm64.tar.zst",
    "debian-12-standard_12.12-1_amd64.tar.zst",
    "ubuntu-24.04-standard_24.04-2_amd64.tar.zst",
  ];

  it("takes the newest template of the host's architecture, not the newest overall", () => {
    expect(newestDebian(BOTH, "amd64")).toBe("debian-13-standard_13.1-2_amd64.tar.zst");
    expect(newestDebian(BOTH, "arm64")).toBe("debian-13-standard_13.6-1_arm64.tar.zst");
  });

  it("returns nothing when the catalog has no template for this host, instead of the wrong one", () => {
    expect(newestDebian(["debian-13-standard_13.6-1_arm64.tar.zst"], "amd64")).toBeNull();
  });

  it("keeps its old behaviour when no architecture is given", () => {
    expect(newestDebian(BOTH)).toBe("debian-13-standard_13.6-1_arm64.tar.zst");
  });

  it("knows the architecture of the process running on the Proxmox node", () => {
    expect(["amd64", "arm64", null]).toContain(hostArch());
  });
});

describe("whether a storage can hold unprivileged container disks", () => {
  const base = { name: "drive2", type: "dir", active: true, availBytes: 500 * 1024 ** 3 };

  it("accepts xfs, ext4, btrfs and zfs directory storage with normal options", () => {
    for (const filesystem of ["xfs", "ext4", "btrfs", "zfs"]) {
      expect(storageVerdict({ ...base, filesystem, mountOptions: ["rw", "relatime"] })).toMatchObject({ verdict: "ok" });
    }
  });

  it("accepts block storage without asking about a filesystem", () => {
    for (const type of ["lvmthin", "lvm", "zfspool", "rbd"]) {
      expect(storageVerdict({ name: "x", type, active: true, availBytes: 10 ** 12 })).toMatchObject({ verdict: "ok" });
    }
  });

  it("refuses filesystems that cannot hold an unprivileged container", () => {
    for (const filesystem of ["ntfs", "ntfs3", "exfat", "vfat", "fuseblk"]) {
      const v = storageVerdict({ ...base, filesystem });
      expect(v.verdict).toBe("unsupported");
      expect(v.reason).toContain(filesystem);
      expect(v.hostCheck).toContain("findmnt -T");
    }
  });

  it("refuses a mount that is noexec or read-only, and warns about nodev", () => {
    expect(storageVerdict({ ...base, filesystem: "xfs", mountOptions: ["rw", "noexec"] }).verdict).toBe("unsupported");
    expect(storageVerdict({ ...base, filesystem: "xfs", mountOptions: ["ro"] }).verdict).toBe("unsupported");
    expect(storageVerdict({ ...base, filesystem: "xfs", mountOptions: ["rw", "nodev"] }).verdict).toBe("warning");
  });

  it("warns, but does not refuse, a network share", () => {
    const v = storageVerdict({ name: "nas", type: "nfs", active: true, availBytes: 10 ** 12 });
    expect(v.verdict).toBe("warning");
    expect(v.reason).toContain("no_root_squash");
  });

  it("says what it could not learn and which host command answers it, instead of guessing", () => {
    const v = storageVerdict({ ...base, path: "/mnt/pve/drive2" });
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toContain("does not report which filesystem");
    expect(v.hostCheck).toContain("findmnt -T /mnt/pve/drive2");
  });

  it("refuses an inactive or nearly full storage", () => {
    expect(storageVerdict({ ...base, active: false }).reason).toContain("not active");
    expect(storageVerdict({ ...base, availBytes: 1024 ** 3 }).reason).toContain("only 1.0 GiB free");
  });
});
