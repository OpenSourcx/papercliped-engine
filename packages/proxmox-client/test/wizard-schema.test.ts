import { describe, expect, it } from "vitest";
import { WizardError, buildCt, buildVm, dnsName, ipv4, ipv6, maskSecrets, osDefaults, storageFormats } from "../src/wizard-schema.ts";

const minimalVm = { general: { name: "a" }, os: { media: "none", ostype: "l26" }, disks: [], cpu: { cores: 1 }, memory: { mb: 512 }, network: [] };
const minimalCt = { general: { hostname: "a" }, template: "local:vztmpl/d.tar.zst", disk: { storage: "s", sizeGb: 1 }, cpu: { cores: 1 }, memory: { mb: 64, swapMb: 0 }, network: [] };
const fails = (fn: () => unknown, re: RegExp) => expect(fn).toThrowError(re);

describe("address checks", () => {
  it("accepts and refuses IPv4", () => {
    for (const ok of ["1.2.3.4", "255.255.255.255", "10.0.0.1"]) expect(ipv4(ok)).toBe(true);
    for (const bad of ["1.2.3", "1.2.3.256", "01.2.3.4", "1.2.3.4.5", "a.b.c.d", "1.2.3.4/24", ""]) expect(ipv4(bad)).toBe(false);
  });
  it("accepts and refuses IPv6", () => {
    for (const ok of ["::1", "::", "2001:db8::5", "fe80::1:2:3:4", "1:2:3:4:5:6:7:8", "::ffff:192.168.1.1", "2001:db8:0:0:0:0:0:1"]) expect(ipv6(ok), ok).toBe(true);
    for (const bad of ["2001:::5", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", "12345::", "g::1", "1::2::3", ":1", "1.2.3.4"]) expect(ipv6(bad), bad).toBe(false);
  });
  it("checks DNS names", () => {
    expect(dnsName("web-1.lab", "n", "f")).toBe("web-1.lab");
    for (const bad of ["-a", "a-", "a_b", "", "a..b", "a".repeat(64)]) expect(() => dnsName(bad, "n", "f")).toThrow(WizardError);
  });
});

describe("virtual machine parameters", () => {
  it("builds the smallest machine", () => {
    const b = buildVm(minimalVm, 105);
    expect(b.params).toMatchObject({ vmid: 105, name: "a", ostype: "l26", cores: 1, sockets: 1, memory: 512, balloon: 0, scsihw: "virtio-scsi-single", cpu: "x86-64-v2-AES" });
    expect(b.params.boot).toBeUndefined();
  });
  it("names the field that is wrong", () => {
    try {
      buildVm({ ...minimalVm, cpu: { cores: 0 } }, 1);
    } catch (e) {
      expect(e).toBeInstanceOf(WizardError);
      expect((e as WizardError).field).toBe("cpu.cores");
    }
  });
  it("keeps the boot order to what exists", () => {
    const b = buildVm({ ...minimalVm, os: { media: "iso", iso: "s:iso/a.iso", ostype: "l26" }, disks: [{ bus: "scsi", storage: "s", sizeGb: 1 }], network: [{ model: "virtio", bridge: "vmbr0" }] }, 1);
    expect(b.params.boot).toBe("order=scsi0;ide2;net0");
  });
  it("rejects bad input", () => {
    fails(() => buildVm(null, 1), /spec is missing/);
    fails(() => buildVm({ ...minimalVm, memory: { mb: 8 } }, 1), /Memory/);
    fails(() => buildVm({ ...minimalVm, cpu: { cores: 513 } }, 1), /Cores/);
    fails(() => buildVm({ ...minimalVm, cpu: { cores: 1, sockets: 5 } }, 1), /Sockets/);
    fails(() => buildVm({ ...minimalVm, general: { name: "a", tags: ["bad tag"] } }, 1), /tag/);
    fails(() => buildVm({ ...minimalVm, general: { name: "a", vmid: 99 } }, 1), /machine number/);
    fails(() => buildVm({ ...minimalVm, general: { name: "a", startup: { order: -1 } } }, 1), /Start order/);
    fails(() => buildVm({ ...minimalVm, system: { vga: { type: "none", memory: 16 } } }, 1), /no video memory/);
    fails(() => buildVm({ ...minimalVm, system: { machine: "q35; rm" } }, 1), /machine type/);
    fails(() => buildVm({ ...minimalVm, disks: [{ bus: "ide", storage: "s", sizeGb: 1 }, { bus: "ide", storage: "s", sizeGb: 1 }, { bus: "ide", storage: "s", sizeGb: 1 }, { bus: "ide", storage: "s", sizeGb: 1 }, { bus: "ide", storage: "s", sizeGb: 1 }] }, 1), /at most 4/);
  });
  it("lets the media slot and extra disks coexist but never collide", () => {
    const b = buildVm({ ...minimalVm, os: { media: "cdrom", ostype: "l26" }, disks: Array.from({ length: 3 }, () => ({ bus: "ide", storage: "s", sizeGb: 1 })) }, 1);
    expect(["ide0", "ide1", "ide3", "ide2"].every((k) => k in b.params)).toBe(true);
  });
  it("encodes cloud-init keys and keeps the drive off a used slot", () => {
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl x";
    const b = buildVm({ ...minimalVm, disks: [{ bus: "ide", storage: "s", sizeGb: 1 }], cloudInit: { storage: "s", sshKeys: key, upgrade: false } }, 1);
    expect(b.params.ide0).toBe("s:1");
    expect(b.params.sata5).toBe("s:cloudinit");
    expect(b.params.ciupgrade).toBe(false);
    expect(decodeURIComponent(String(b.params.sshkeys))).toBe(key);
  });
  it("masks secrets for previews", () => {
    const m = maskSecrets({ password: "x", cipassword: "y", sshkeys: "z", name: "n" });
    expect(m).toEqual({ password: "(set, hidden)", cipassword: "(set, hidden)", sshkeys: "(set, hidden)", name: "n" });
  });
});

describe("container parameters", () => {
  it("builds the smallest container", () => {
    const b = buildCt(minimalCt, 200);
    expect(b.params).toMatchObject({ vmid: 200, ostemplate: "local:vztmpl/d.tar.zst", hostname: "a", unprivileged: true, rootfs: "s:1", cores: 1, memory: 64, swap: 0 });
    expect(b.warnings.length).toBeGreaterThan(0);
  });
  it("names interfaces eth0, eth1 by position", () => {
    const b = buildCt({ ...minimalCt, network: [{ bridge: "vmbr0" }, { bridge: "vmbr0" }] }, 1);
    expect(String(b.params.net1)).toMatch(/^name=eth1,/);
  });
  it("puts addresses after the device options", () => {
    const b = buildCt({ ...minimalCt, network: [{ bridge: "vmbr0", vlan: 5, ipv4: { mode: "static", cidr: "10.0.0.5/24", gw: "10.0.0.1" } }] }, 1);
    expect(b.params.net0).toBe("name=eth0,bridge=vmbr0,tag=5,ip=10.0.0.5/24,gw=10.0.0.1");
  });
});

describe("OS defaults", () => {
  it("picks drivers an installer can see", () => {
    expect(osDefaults("win11")).toMatchObject({ bios: "ovmf", machine: "q35", tpm: true, efi: true, bus: "sata", nic: "e1000e" });
    expect(osDefaults("l26")).toMatchObject({ bus: "scsi", nic: "virtio", iothread: true });
  });
  it("offers formats only on file storage", () => {
    expect(storageFormats("dir")).toContain("qcow2");
    expect(storageFormats("lvmthin")).toEqual(["raw"]);
  });
});

describe("importing a disk image (WZ-017)", () => {
  const base = { ...minimalVm, disks: [{ bus: "scsi", storage: "local-lvm", importFrom: "local:import/ubuntu.qcow2" }] };
  it("builds a disk from an image, with no size", () => {
    const b = buildVm(base, 105);
    expect(b.params.scsi0).toBe("local-lvm:0,import-from=local:import/ubuntu.qcow2");
  });
  it("accepts an OVA and an ESXi machine, and refuses anything else", () => {
    expect(buildVm({ ...base, disks: [{ ...base.disks[0], importFrom: "local:import/app.ova" }] }, 105).params.scsi0).toContain("import-from=local:import/app.ova");
    expect(buildVm({ ...base, disks: [{ ...base.disks[0], importFrom: "esxi:ha-datacenter/web/web.vmx" }] }, 105).params.scsi0).toContain("esxi:ha-datacenter/web/web.vmx");
    fails(() => buildVm({ ...base, disks: [{ ...base.disks[0], importFrom: "../etc/passwd" }] }, 105), /image to import/);
    fails(() => buildVm({ ...base, disks: [{ ...base.disks[0], importFrom: "local:import/../../x" }] }, 105), /image to import/);
  });
  it("checks the image against the ones the account can read, and doesn't warn about the size", () => {
    fails(() => buildVm(base, 105, { imports: ["local:import/other.raw"] }), /import storage/);
    expect(buildVm({ ...base, os: { media: "none", ostype: "win11" } }, 105, { imports: ["local:import/ubuntu.qcow2"] }).warnings.join(" ")).not.toMatch(/64 GB/);
  });
});

describe("container mount points and devices at creation", () => {
  it("builds volume mount points and host directories", () => {
    const b = buildCt({ ...minimalCt, mounts: [{ path: "/data", storage: "s", sizeGb: 10, backup: false }, { path: "/media", hostPath: "/srv/media", readOnly: true }] }, 200, { root: true });
    expect(b.params.mp0).toBe("s:10,mp=/data,backup=0");
    expect(b.params.mp1).toBe("/srv/media,mp=/media,ro=1");
  });
  it("a host directory is root only, and says what to use instead", () => {
    fails(() => buildCt({ ...minimalCt, mounts: [{ path: "/media", hostPath: "/srv/media" }] }, 200, { root: false }), /only root@pam[\s\S]*new volume/);
    expect(buildCt({ ...minimalCt, mounts: [{ path: "/data", storage: "s", sizeGb: 1 }] }, 200, { root: false }).params.mp0).toBe("s:1,mp=/data");
  });
  it("refuses bad paths, duplicates and mixed mount kinds", () => {
    fails(() => buildCt({ ...minimalCt, mounts: [{ path: "/", storage: "s", sizeGb: 1 }] }, 200), /mount path/);
    fails(() => buildCt({ ...minimalCt, mounts: [{ path: "/a", storage: "s", sizeGb: 1 }, { path: "/a", storage: "s", sizeGb: 1 }] }, 200), /two mount points/);
    fails(() => buildCt({ ...minimalCt, mounts: [{ path: "/a", hostPath: "/x", storage: "s" }] }, 200, { root: true }), /no storage or size/);
    fails(() => buildCt({ ...minimalCt, mounts: [{ path: "/a", hostPath: "/x/../etc" }] }, 200, { root: true }), /\.\./);
    fails(() => buildCt({ ...minimalCt, mounts: [{ path: "/a", storage: "s" }] }, 200), /Mount point size/);
  });
  it("device passthrough is root only and a /dev path", () => {
    const b = buildCt({ ...minimalCt, devices: [{ path: "/dev/dri/renderD128", mode: "0660", gid: 44 }] }, 200, { root: true });
    expect(b.params.dev0).toBe("path=/dev/dri/renderD128,mode=0660,gid=44");
    expect(b.warnings.join(" ")).toMatch(/live-migrated/);
    fails(() => buildCt({ ...minimalCt, devices: [{ path: "/dev/dri/renderD128" }] }, 200, { root: false }), /only root@pam/);
    fails(() => buildCt({ ...minimalCt, devices: [{ path: "/etc/passwd" }] }, 200, { root: true }), /device path/);
    fails(() => buildCt({ ...minimalCt, devices: [{ path: "/dev/x", mode: "999" }] }, 200, { root: true }), /octal/);
  });
});
