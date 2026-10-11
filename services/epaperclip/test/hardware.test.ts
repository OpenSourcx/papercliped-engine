import { describe, expect, it } from "vitest";
import { checkIface, checkNic, ifaceParams, nextNicKey, nicString, normalizeConfig, parseProps, serializeProps, setProps, sizeGb } from "../src/hardware.ts";

describe("device strings", () => {
  it("round-trips Proxmox comma lists and keeps unknown keys", () => {
    const raw = "virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,firewall=1,queues=4";
    expect(serializeProps(parseProps(raw))).toBe(raw);
    expect(serializeProps(setProps(parseProps(raw), { bridge: "vmbr1", firewall: null, tag: "20" }))).toBe("virtio=BC:24:11:AA:BB:CC,bridge=vmbr1,queues=4,tag=20");
  });

  it("reads sizes in Proxmox's units", () => {
    expect(sizeGb("32G")).toBe(32);
    expect(sizeGb("512M")).toBe(0.5);
    expect(sizeGb("1T")).toBe(1024);
    expect(sizeGb(undefined)).toBeNull();
  });
});

describe("normalizing configuration", () => {
  it("reads a VM: disks, the CD drive, NICs with MACs, pending keys", () => {
    const hw = normalizeConfig("qemu", { name: "lab", cores: 4, sockets: 1, memory: 8192, scsi0: "local-lvm:vm-109-disk-0,iothread=1,size=32G", ide2: "local:iso/debian.iso,media=cdrom", efidisk0: "local-lvm:vm-109-disk-1,size=4M", net0: "virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,firewall=1,tag=20", onboot: 1, tags: "web;prod" }, ["memory"]);
    expect(hw).toMatchObject({ name: "lab", cores: 4, memoryMb: 8192, onboot: true, tags: ["web", "prod"], cdrom: "local:iso/debian.iso", pending: ["memory"] });
    expect(hw.disks).toEqual([{ key: "scsi0", storage: "local-lvm", volume: "local-lvm:vm-109-disk-0", sizeGb: 32, mount: null }]);
    expect(hw.nics[0]).toMatchObject({ key: "net0", model: "virtio", mac: "BC:24:11:AA:BB:CC", bridge: "vmbr0", tag: 20, firewall: true });
  });

  it("reads a container: rootfs first, mount points, swap, static IP", () => {
    const hw = normalizeConfig("lxc", { hostname: "web", cores: 2, memory: 2048, swap: 512, mp0: "drive2:subvol-101-disk-1,mp=/data,size=100G", rootfs: "local-lvm:vm-101-disk-0,size=8G", net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=192.168.1.50/24,gw=192.168.1.1,type=veth" });
    expect(hw.disks.map((d) => [d.key, d.mount, d.sizeGb])).toEqual([["rootfs", "/", 8], ["mp0", "/data", 100]]);
    expect(hw.nics[0]).toMatchObject({ name: "eth0", mac: "BC:24:11:00:00:01", ip: "192.168.1.50/24", gw: "192.168.1.1", firewall: false });
    expect(hw.swapMb).toBe(512);
  });
});

describe("network devices", () => {
  it("keeps the MAC when editing a VM NIC, even when the model changes", () => {
    const spec = checkNic("qemu", { bridge: "vmbr1", model: "e1000e", firewall: true, tag: 30 });
    expect(nicString("qemu", "net0", spec, "virtio=BC:24:11:AA:BB:CC,bridge=vmbr0")).toBe("e1000e=BC:24:11:AA:BB:CC,bridge=vmbr1,firewall=1,tag=30");
    expect(nicString("qemu", "net1", checkNic("qemu", { bridge: "vmbr0" }))).toBe("virtio,bridge=vmbr0,firewall=1");
  });

  it("builds container NICs with names, IPs and gateways", () => {
    expect(nicString("lxc", "net1", checkNic("lxc", { bridge: "vmbr0", ip: "10.0.0.5/24", gw: "10.0.0.1", firewall: false }))).toBe("name=eth1,bridge=vmbr0,ip=10.0.0.5/24,gw=10.0.0.1,type=veth");
    expect(nicString("lxc", "net0", checkNic("lxc", { bridge: "vmbr0", ip: "dhcp", gw: "10.0.0.1" }), "name=eth0,bridge=vmbr1,hwaddr=AA,ip=1.2.3.4/24,gw=1.2.3.1,type=veth")).toBe("name=eth0,bridge=vmbr0,hwaddr=AA,ip=dhcp,type=veth,firewall=1");
  });

  it("rejects bad input", () => {
    expect(() => checkNic("qemu", { bridge: "vmbr0;rm" })).toThrow();
    expect(() => checkNic("qemu", { bridge: "vmbr0", tag: 5000 })).toThrow();
    expect(() => checkNic("qemu", { bridge: "vmbr0", model: "evil" })).toThrow();
    expect(() => checkNic("lxc", { bridge: "vmbr0", ip: "1.2.3.4" })).toThrow();
    expect(nextNicKey({ net0: "x", net2: "y" })).toBe("net1");
  });
});

describe("host interfaces", () => {
  it("validates names and addresses per type", () => {
    expect(checkIface({ type: "bridge", iface: "vmbr1", cidr: "10.10.0.1/24", ports: "nic1" }, true)).toMatchObject({ iface: "vmbr1", ports: ["nic1"], cidr: "10.10.0.1/24" });
    expect(() => checkIface({ type: "bridge", iface: "eth0" }, true)).toThrow(/vmbr/);
    expect(() => checkIface({ type: "bridge", iface: "vmbr1", cidr: "10.0.0.300/24" }, true)).toThrow();
    expect(() => checkIface({ type: "bridge", iface: "vmbr1", gateway: "10.0.0.1" }, true)).toThrow(/gateway needs/);
    expect(() => checkIface({ type: "bond", iface: "bond0", slaves: "" }, true)).toThrow();
    expect(checkIface({ type: "vlan", iface: "vmbr0.20" }, true)).toMatchObject({ vlanRaw: "vmbr0", vlanId: 20 });
    expect(() => checkIface({ type: "vlan", iface: "vmbr0.9999" }, true)).toThrow();
    expect(() => checkIface({ type: "bridge", iface: "vmbr1", comments: "a\nb" }, true)).toThrow();
  });

  it("clears removed fields on edit", () => {
    const p = ifaceParams(checkIface({ type: "bridge", iface: "vmbr1", ports: "nic1", vlanAware: true }, false), false);
    expect(p).toMatchObject({ type: "bridge", bridge_ports: "nic1", bridge_vlan_aware: true, delete: "cidr,gateway,comments" });
    expect(p.iface).toBeUndefined();
    expect(ifaceParams(checkIface({ type: "vlan", iface: "vlan30", vlanRaw: "nic0", vlanId: 30 }, true), true)).toMatchObject({ iface: "vlan30", "vlan-raw-device": "nic0", "vlan-id": 30 });
  });
});
