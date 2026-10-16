import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { fakePve } from "./fakes.ts";
import { fakeWizard, props } from "./fakes-wizard.ts";

let server: Server;
let base: string;
let pve: ReturnType<typeof fakeWizard>;
let logged: string[];

beforeEach(async () => {
  pve = fakeWizard(fakePve().transport);
  logged = [];
  for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
  const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(), staticDir: null, secureCookies: false });
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-EPC-Request": "1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const j = (r: Response): Promise<any> => r.json();
async function signIn(username = "sam") {
  const r = await send("POST", "/api/login", { username, password: "right", realm: "pve" });
  return r.headers.get("set-cookie")!.split(";")[0];
}
const create = (c: string, kind: "vm" | "ct", spec: unknown) => send("POST", "/api/wizard/create", { kind, spec }, { Cookie: c });
const preview = (c: string, kind: "vm" | "ct", spec: unknown) => send("POST", "/api/wizard/preview", { kind, spec }, { Cookie: c });
const posted = (re: RegExp) => pve.calls.filter((c) => c.method === "POST" && re.test(c.path));

const vm = (over: Record<string, any> = {}) => ({
  general: { name: "web-1" },
  os: { media: "iso", iso: "local:iso/debian-12.iso", ostype: "l26" },
  system: {},
  disks: [{ bus: "scsi", storage: "local-lvm", sizeGb: 32, iothread: true, discard: true }],
  cpu: { cores: 2 },
  memory: { mb: 2048 },
  network: [{ model: "virtio", bridge: "vmbr0", firewall: true }],
  ...over,
});
const ct = (over: Record<string, any> = {}) => ({
  general: { hostname: "ct-one", password: "correct-horse" },
  template: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst",
  disk: { storage: "local-lvm", sizeGb: 8 },
  cpu: { cores: 1 },
  memory: { mb: 512, swapMb: 512 },
  network: [{ bridge: "vmbr0", ipv4: { mode: "dhcp" } }],
  ...over,
});

describe("wizard options", () => {
  it("lists what the node offers for both wizards", async () => {
    const c = await signIn();
    const o = await j(await fetch(base + "/api/wizard/options", { headers: { Cookie: c } }));
    expect(o.nextid).toBe(300);
    expect(o.templates.map((t: any) => t.name)).toContain("debian-12-standard_12.7-1_amd64.tar.zst");
    expect(o.isos.map((i: any) => i.volid)).toEqual(expect.arrayContaining(["local:iso/win11.iso", "nas:iso/alpine.iso"]));
    expect(o.vmStorages.map((s: any) => s.storage)).toEqual(["local-lvm", "tank", "nas"]); // "old" is inactive, "local" holds no disks
    expect(o.vmStorages.find((s: any) => s.storage === "nas").formats).toEqual(["raw", "qcow2", "vmdk"]);
    expect(o.vmStorages.find((s: any) => s.storage === "tank").formats).toEqual(["raw"]);
    expect(o.bridges).toEqual([{ id: "vmbr0", kind: "bridge" }, { id: "vmbr1", kind: "bridge" }, { id: "vnetA", kind: "vnet" }]);
    expect(o.cpuTypes.custom).toEqual(["custom-lab"]);
    expect(o.machines).toEqual(["pc-q35-9.0", "pc-i440fx-9.0"]);
    expect(o.pci[0]).toMatchObject({ id: "0000:01:00.0", vendor: "NVIDIA Corporation", group: 14 });
    expect(o.usb).toEqual([{ host: "0bda:0041", port: "1-2", name: "Realtek Zigbee dongle" }]);
    expect(o.pciMappings).toEqual([{ id: "gpu0", description: "Main GPU" }]);
    expect(o.pools).toContain("existing");
    expect(o.imports.map((i: any) => i.volid)).toEqual(["local:import/ubuntu-24.04.qcow2", "local:import/appliance.ova"]);
  });

  it("only offers raw passthrough to root@pam and says when hardware can't be listed", async () => {
    const c = await signIn();
    expect((await j(await fetch(base + "/api/wizard/options", { headers: { Cookie: c } }))).rawPassthrough).toBe(false);
    pve.hide();
    const o = await j(await fetch(base + "/api/wizard/options", { headers: { Cookie: c } }));
    expect(o.pci).toEqual([]);
    expect(o.notes[0]).toMatch(/saved mappings/);
  });

  it("needs a sign-in", async () => {
    expect((await fetch(base + "/api/wizard/options")).status).toBe(401);
  });

  it("checks whether a machine number is free", async () => {
    const c = await signIn();
    expect(await j(await fetch(base + "/api/wizard/vmid?vmid=500", { headers: { Cookie: c } }))).toEqual({ free: true, message: "" });
    expect((await j(await fetch(base + "/api/wizard/vmid?vmid=101", { headers: { Cookie: c } }))).free).toBe(false);
    expect((await j(await fetch(base + "/api/wizard/vmid?vmid=5", { headers: { Cookie: c } }))).free).toBe(false);
  });
});

describe("Create virtual machine", () => {
  it("creates a Linux machine with the parameters Proxmox expects", async () => {
    const c = await signIn();
    const r = await create(c, "vm", vm({ general: { name: "web-1", pool: "existing", start: true, onboot: true, startup: { order: 2, up: 30 }, tags: ["web", "Prod"], description: "front end" } }));
    expect(r.status).toBe(202);
    const body = await j(r);
    expect(body).toMatchObject({ vmid: 300, task: expect.stringContaining("UPID:") });
    const p = pve.created.get(300)!.params;
    expect(p).toMatchObject({ name: "web-1", ostype: "l26", pool: "existing", start: "1", onboot: "1", startup: "order=2,up=30", tags: "web;prod", scsihw: "virtio-scsi-single", cores: "2", sockets: "1", cpu: "x86-64-v2-AES", memory: "2048", balloon: "0", agent: "enabled=1", ide2: "local:iso/debian-12.iso,media=cdrom", boot: "order=scsi0;ide2;net0" });
    expect(props(p.scsi0)).toEqual({ _: "local-lvm:32", discard: "on", iothread: "1" });
    expect(props(p.net0)).toEqual({ model: "virtio", bridge: "vmbr0", firewall: "1" });
    expect(p.bios).toBeUndefined();
  });

  it("uses a chosen machine number and refuses a taken one", async () => {
    const c = await signIn();
    expect((await j(await create(c, "vm", vm({ general: { name: "pick", vmid: 777 } })))).vmid).toBe(777);
    const taken = await create(c, "vm", vm({ general: { name: "pick2", vmid: 101 } }));
    expect(taken.status).toBe(409);
    expect(await j(taken)).toMatchObject({ code: "vmid_taken" });
    expect(pve.created.has(101)).toBe(false);
  });

  it("builds a Windows 11 machine with UEFI, EFI disk, TPM and SATA", async () => {
    const c = await signIn();
    const r = await create(c, "vm", vm({
      general: { name: "win" },
      os: { media: "iso", iso: "local:iso/win11.iso", ostype: "win11" },
      system: { bios: "ovmf", machine: "q35", efi: { storage: "local-lvm", preEnrolledKeys: true }, tpm: { storage: "local-lvm", version: "v2.0" }, vga: { type: "qxl", memory: 32 } },
      disks: [{ bus: "sata", storage: "local-lvm", sizeGb: 64, ssd: true, discard: true }],
      cpu: { sockets: 1, cores: 4, type: "host", numa: true },
      memory: { mb: 8192 },
      network: [{ model: "e1000e", bridge: "vmbr0" }],
    }));
    expect(r.status).toBe(202);
    const p = pve.created.get(300)!.params;
    expect(p).toMatchObject({ bios: "ovmf", machine: "q35", ostype: "win11", cpu: "host", numa: "1", vga: "type=qxl,memory=32", efidisk0: "local-lvm:1,efitype=4m,pre-enrolled-keys=1", tpmstate0: "local-lvm:1,version=v2.0" });
    expect(props(p.sata0)).toEqual({ _: "local-lvm:64", discard: "on", ssd: "1" });
  });

  it("numbers several disks per bus and keeps the install media slot", async () => {
    const c = await signIn();
    const r = await create(c, "vm", vm({
      disks: [
        { bus: "scsi", storage: "local-lvm", sizeGb: 32 },
        { bus: "scsi", storage: "tank", sizeGb: 100, cache: "writeback", backup: false },
        { bus: "virtio", storage: "nas", sizeGb: 10, format: "qcow2", iothread: true },
        { bus: "sata", storage: "local-lvm", sizeGb: 5, ssd: true },
        { bus: "ide", storage: "local-lvm", sizeGb: 2 },
      ],
    }));
    expect(r.status).toBe(202);
    const p = pve.created.get(300)!.params;
    expect(Object.keys(p).filter((k) => /^(scsi|virtio|sata|ide)\d+$/.test(k)).sort()).toEqual(["ide0", "ide2", "sata0", "scsi0", "scsi1", "virtio0"]);
    expect(props(p.scsi1)).toEqual({ _: "tank:100", cache: "writeback", backup: "0" });
    expect(props(p.virtio0)).toEqual({ _: "nas:10", format: "qcow2", iothread: "1" });
  });

  it("supports no media, a physical drive, several network devices with every option, and no network", async () => {
    const c = await signIn();
    await create(c, "vm", vm({
      os: { media: "cdrom", ostype: "l26" },
      network: [
        { model: "virtio", bridge: "vmbr0", vlan: 20, mac: "bc:24:11:aa:bb:cc", firewall: true, rateMbps: 12.5, mtu: 1, queues: 4 },
        { model: "e1000", bridge: "vnetA", disconnected: true },
      ],
    }));
    const p = pve.created.get(300)!.params;
    expect(p.ide2).toBe("cdrom,media=cdrom");
    expect(props(p.net0)).toEqual({ model: "virtio", macaddr: "BC:24:11:AA:BB:CC", bridge: "vmbr0", firewall: "1", mtu: "1", queues: "4", rate: "12.5", tag: "20" });
    expect(props(p.net1)).toEqual({ model: "e1000", bridge: "vnetA", link_down: "1" });
    await create(c, "vm", vm({ general: { name: "bare" }, os: { media: "none", ostype: "other" }, disks: [], network: [] }));
    const q = pve.created.get(301)!.params;
    expect(q.ide2).toBeUndefined();
    expect(q.net0).toBeUndefined();
    expect(q.boot).toBeUndefined();
  });

  it("ballooning, CPU limits and vCPUs", async () => {
    const c = await signIn();
    await create(c, "vm", vm({ cpu: { sockets: 2, cores: 4, vcpus: 6, limit: 3.5, units: 2048 }, memory: { mb: 4096, balloonMinMb: 1024, shares: 2000 } }));
    expect(pve.created.get(300)!.params).toMatchObject({ sockets: "2", cores: "4", vcpus: "6", cpulimit: "3.5", cpuunits: "2048", memory: "4096", balloon: "1024", shares: "2000" });
  });

  it("adds cloud-init, with the SSH key encoded and the password only sent to Proxmox", async () => {
    const c = await signIn();
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop";
    const r = await create(c, "vm", vm({
      cloudInit: { storage: "local-lvm", user: "deploy", password: "s3cret-pass-1", sshKeys: key, nameserver: ["1.1.1.1"], searchdomain: "lab.example", ip: [{ ipv4: { mode: "static", cidr: "192.168.1.50/24", gw: "192.168.1.1" }, ipv6: { mode: "auto" } }] },
    }));
    expect(r.status).toBe(202);
    const p = pve.created.get(300)!.params;
    expect(p.ide0).toBe("local-lvm:cloudinit");
    expect(p).toMatchObject({ ciuser: "deploy", nameserver: "1.1.1.1", searchdomain: "lab.example", ipconfig0: "ip=192.168.1.50/24,gw=192.168.1.1,ip6=auto" });
    expect(decodeURIComponent(p.sshkeys)).toBe(key);
    expect(JSON.stringify(await j(r))).not.toContain("s3cret-pass-1");
  });

  it("adds PCI, USB, serial, audio and display", async () => {
    const c = await signIn();
    const r = await create(c, "vm", vm({
      system: { bios: "ovmf", machine: "q35", vga: { type: "none" } },
      hardware: { pci: [{ device: "0000:01:00.0", pcie: true, primaryGpu: true }, { mapping: "gpu0", romBar: false }], usb: [{ host: "0bda:0041", usb3: true }, { spice: true }], serial: 2, audio: { device: "ich9-intel-hda" } },
    }));
    expect(r.status).toBe(202);
    const p = pve.created.get(300)!.params;
    expect(p).toMatchObject({ hostpci0: "host=0000:01:00.0,pcie=1,x-vga=1", hostpci1: "mapping=gpu0,rombar=0", usb0: "host=0bda:0041,usb3=1", usb1: "spice", serial0: "socket", serial1: "socket", audio0: "device=ich9-intel-hda,driver=spice", vga: "type=none" });
    expect(p.serial2).toBeUndefined();
  });

  it("refuses requests that Proxmox would refuse, before anything reaches it", async () => {
    const c = await signIn();
    const cases: [string, any, RegExp][] = [
      ["an unknown field", { ...vm(), extra: 1 }, /Unknown field spec\.extra/],
      ["an unknown nested field", vm({ cpu: { cores: 1, turbo: true } }), /Unknown field cpu\.turbo/],
      ["a bad name", vm({ general: { name: "-bad" } }), /name can use/],
      ["an unknown pool", vm({ general: { name: "x", pool: "nope" } }), /no resource group/],
      ["an unknown operating system", vm({ os: { media: "none", ostype: "beos" } }), /operating system/],
      ["an ISO with no media choice", vm({ os: { media: "none", iso: "local:iso/a.iso", ostype: "l26" } }), /only used with the ISO/],
      ["a bad ISO path", vm({ os: { media: "iso", iso: "local:iso/../../etc/passwd", ostype: "l26" } }), /ISO/],
      ["an IO thread on SATA", vm({ disks: [{ bus: "sata", storage: "local-lvm", sizeGb: 8, iothread: true }] }), /IO thread/],
      ["SSD on VirtIO", vm({ disks: [{ bus: "virtio", storage: "local-lvm", sizeGb: 8, ssd: true }] }), /SSD/],
      ["a disk on a storage that holds none", vm({ disks: [{ bus: "scsi", storage: "local", sizeGb: 8 }] }), /can't hold disks/],
      ["QCOW2 on ZFS", vm({ disks: [{ bus: "scsi", storage: "tank", sizeGb: 8, format: "qcow2" }] }), /raw disks only/],
      ["an empty disk", vm({ disks: [{ bus: "scsi", storage: "local-lvm", sizeGb: 0 }] }), /Disk size/],
      ["five IDE disks", vm({ disks: Array.from({ length: 5 }, () => ({ bus: "ide", storage: "local-lvm", sizeGb: 1 })) }), /at most 4|taken/],
      ["EFI without UEFI", vm({ system: { efi: { storage: "local-lvm" } } }), /UEFI/],
      ["an unknown CPU type", vm({ cpu: { cores: 1, type: "pentium-9" } }), /CPU type/],
      ["too many active CPUs", vm({ cpu: { cores: 2, vcpus: 5 } }), /Active CPUs/],
      ["a minimum memory above the memory", vm({ memory: { mb: 1024, balloonMinMb: 2048 } }), /Minimum memory/],
      ["shares without ballooning", vm({ memory: { mb: 1024, shares: 100 } }), /ballooning/],
      ["an unknown bridge", vm({ network: [{ model: "virtio", bridge: "vmbr9" }] }), /no network bridge/],
      ["VLAN 0", vm({ network: [{ model: "virtio", bridge: "vmbr0", vlan: 0 }] }), /VLAN/],
      ["VLAN 4095", vm({ network: [{ model: "virtio", bridge: "vmbr0", vlan: 4095 }] }), /VLAN/],
      ["a bad MAC", vm({ network: [{ model: "virtio", bridge: "vmbr0", mac: "nope" }] }), /MAC/],
      ["a multicast MAC", vm({ network: [{ model: "virtio", bridge: "vmbr0", mac: "01:00:5e:00:00:01" }] }), /multicast/],
      ["MTU on e1000", vm({ network: [{ model: "e1000", bridge: "vmbr0", mtu: 1400 }] }), /VirtIO/],
      ["PCIe without q35", vm({ hardware: { pci: [{ device: "0000:01:00.0", pcie: true }] } }), /q35/],
      ["a PCI entry with both a device and a mapping", vm({ hardware: { pci: [{ device: "0000:01:00.0", mapping: "gpu0" }] } }), /device or a saved mapping/],
      ["six USB entries", vm({ hardware: { usb: Array.from({ length: 6 }, () => ({ spice: true })) } }), /at most 5/],
      ["a serial device path", vm({ hardware: { serial: 9 } }), /Serial ports/],
      ["cloud-init with a bad key", vm({ cloudInit: { storage: "local-lvm", sshKeys: "not a key" } }), /SSH public key/],
      ["cloud-init static without a prefix", vm({ cloudInit: { storage: "local-lvm", ip: [{ ipv4: { mode: "static", cidr: "192.168.1.5" } }] } }), /prefix/],
      ["a gateway outside the network", vm({ cloudInit: { storage: "local-lvm", ip: [{ ipv4: { mode: "static", cidr: "192.168.1.5/24", gw: "10.0.0.1" } }] } }), /inside/],
      ["a short cloud-init password", vm({ cloudInit: { storage: "local-lvm", password: "abc" } }), /password/],
    ];
    for (const [label, spec, re] of cases) {
      const r = await create(c, "vm", spec);
      expect(r.status, label).toBe(400);
      expect((await j(r)).error, label).toMatch(re);
    }
    expect(posted(/\/qemu$/)).toHaveLength(0);
  });

  it("previews the exact Proxmox parameters without creating, and hides secrets", async () => {
    const c = await signIn();
    const r = await preview(c, "vm", vm({ cloudInit: { storage: "local-lvm", password: "s3cret-pass-1", sshKeys: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me" } }));
    expect(r.status).toBe(200);
    const text = JSON.stringify(await r.clone().json());
    const body = await j(r);
    expect(body.vmid).toBe(300);
    expect(body.params.cipassword).toBe("(set, hidden)");
    expect(body.params.sshkeys).toBe("(set, hidden)");
    expect(body.params.scsi0).toBe("local-lvm:32,discard=on,iothread=1");
    expect(text).not.toContain("s3cret-pass-1");
    expect(posted(/\/qemu$/)).toHaveLength(0);
    expect(pve.created.size).toBe(0);
  });

  it("warns about choices that will cause trouble", async () => {
    const c = await signIn();
    const w = (await j(await preview(c, "vm", vm({ os: { media: "none", ostype: "win11" }, network: [], hardware: { pci: [{ device: "01:00.0" }] }, memory: { mb: 2048, balloonMinMb: 512 } })))).warnings.join(" ");
    expect(w).toMatch(/Windows 11 needs UEFI/);
    expect(w).toMatch(/No network device/);
    expect(w).toMatch(/ballooning/);
  });
});

describe("importing a disk image (WZ-017)", () => {
  it("creates a VM whose disk comes from an image on an import storage", async () => {
    const c = await signIn();
    const r = await create(c, "vm", vm({ disks: [{ bus: "scsi", storage: "local-lvm", importFrom: "local:import/ubuntu-24.04.qcow2" }] }));
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(202);
    expect(pve.created.get(300)!.params.scsi0).toBe("local-lvm:0,import-from=local:import/ubuntu-24.04.qcow2");
  });
  it("refuses an image the account can't see", async () => {
    const c = await signIn();
    const r = await create(c, "vm", vm({ disks: [{ bus: "scsi", storage: "local-lvm", importFrom: "local:import/secret.qcow2" }] }));
    expect(r.status).toBe(400);
    expect((await j(r)).error).toMatch(/import storage/);
  });
});

describe("Create container", () => {
  it("adds a mount point on a new volume and refuses a host directory and devices for an account that isn't root@pam", async () => {
    const c = await signIn();
    const ok = await create(c, "ct", ct({ mounts: [{ path: "/data", storage: "local-lvm", sizeGb: 20, backup: false }] }));
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(202);
    expect(pve.created.get(300)!.params.mp0).toBe("local-lvm:20,mp=/data,backup=0");
    const dir = await create(c, "ct", ct({ mounts: [{ path: "/media", hostPath: "/srv/media" }] }));
    expect(dir.status).toBe(400);
    expect((await j(dir)).error).toMatch(/only root@pam/);
    const dev = await create(c, "ct", ct({ devices: [{ path: "/dev/dri/renderD128" }] }));
    expect((await j(dev)).error).toMatch(/only root@pam/);
  });

  it("creates an unprivileged container with the parameters Proxmox expects", async () => {
    const c = await signIn();
    const r = await create(c, "ct", ct({
      general: { hostname: "ct-one", password: "correct-horse", sshKeys: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop", pool: "existing", onboot: true, startup: { order: 1 }, tags: ["agents"], unprivileged: true },
      cpu: { cores: 2, limit: 1.5, units: 512 },
      memory: { mb: 1024, swapMb: 256 },
      features: { nesting: true, keyctl: true },
      dns: { nameserver: ["9.9.9.9", "2620:fe::fe"], searchdomain: "lab.example" },
    }));
    expect(r.status).toBe(202);
    const p = pve.created.get(300)!.params;
    expect(p).toMatchObject({ hostname: "ct-one", unprivileged: "1", pool: "existing", onboot: "1", start: "1", startup: "order=1", tags: "agents", cores: "2", cpulimit: "1.5", cpuunits: "512", memory: "1024", swap: "256", rootfs: "local-lvm:8", features: "nesting=1,keyctl=1", nameserver: "9.9.9.9 2620:fe::fe", searchdomain: "lab.example" });
    expect(props(p.net0)).toEqual({ name: "eth0", bridge: "vmbr0", ip: "dhcp" });
  });

  it("sets static IPv4 and IPv6, gateways, VLAN, firewall, rate and several devices", async () => {
    const c = await signIn();
    await create(c, "ct", ct({
      network: [
        { bridge: "vmbr0", vlan: 30, firewall: true, mac: "bc:24:11:00:00:01", rateMbps: 50, mtu: 1500, ipv4: { mode: "static", cidr: "10.0.30.5/24", gw: "10.0.30.1" }, ipv6: { mode: "static", cidr: "2001:db8::5/64", gw: "2001:db8::1" } },
        { name: "mgmt", bridge: "vmbr1", ipv4: { mode: "manual" }, ipv6: { mode: "dhcp" }, disconnected: true },
      ],
    }));
    const p = pve.created.get(300)!.params;
    expect(props(p.net0)).toEqual({ name: "eth0", bridge: "vmbr0", hwaddr: "BC:24:11:00:00:01", firewall: "1", mtu: "1500", rate: "50", tag: "30", ip: "10.0.30.5/24", gw: "10.0.30.1", ip6: "2001:db8::5/64", gw6: "2001:db8::1" });
    expect(props(p.net1)).toEqual({ name: "mgmt", bridge: "vmbr1", link_down: "1", ip: "manual", ip6: "dhcp" });
  });

  it("creates a privileged container only when asked, and refuses keyctl on it", async () => {
    const c = await signIn();
    expect((await create(c, "ct", ct({ general: { hostname: "priv", password: "correct-horse", unprivileged: false } }))).status).toBe(202);
    expect(pve.created.get(300)!.params.unprivileged).toBe("0");
    const r = await create(c, "ct", ct({ general: { hostname: "priv2", unprivileged: false }, features: { keyctl: true } }));
    expect(r.status).toBe(400);
  });

  it("refuses requests Proxmox would refuse", async () => {
    const c = await signIn();
    const cases: [string, any, RegExp][] = [
      ["a short password", ct({ general: { hostname: "a", password: "abc" } }), /password/],
      ["a bad hostname", ct({ general: { hostname: "under_score" } }), /hostname/],
      ["a bad key", ct({ general: { hostname: "a", sshKeys: "ssh-rsa" } }), /SSH public key/],
      ["a template that isn't one", ct({ template: "local:iso/a.iso" }), /template/],
      ["a bad address", ct({ network: [{ bridge: "vmbr0", ipv4: { mode: "static", cidr: "999.1.1.1/24" } }] }), /IPv4 address/],
      ["a loopback address", ct({ network: [{ bridge: "vmbr0", ipv4: { mode: "static", cidr: "127.0.0.1/8" } }] }), /can use/],
      ["an address with dhcp", ct({ network: [{ bridge: "vmbr0", ipv4: { mode: "dhcp", cidr: "10.0.0.2/24" } }] }), /static/],
      ["a gateway outside the subnet", ct({ network: [{ bridge: "vmbr0", ipv4: { mode: "static", cidr: "10.0.0.2/24", gw: "10.1.0.1" } }] }), /inside/],
      ["an IPv6 with an IPv4 gateway", ct({ network: [{ bridge: "vmbr0", ipv6: { mode: "static", cidr: "2001:db8::5/64", gw: "10.0.0.1" } }] }), /IPv6 gateway/],
      ["a bad IPv6", ct({ network: [{ bridge: "vmbr0", ipv6: { mode: "static", cidr: "2001:::5/64" } }] }), /IPv6 address/],
      ["a duplicate interface", ct({ network: [{ name: "eth0", bridge: "vmbr0" }, { name: "eth0", bridge: "vmbr0" }] }), /Two network devices/],
      ["a bad DNS server", ct({ dns: { nameserver: ["not-an-ip"] } }), /IP address/],
      ["a negative swap", ct({ memory: { mb: 512, swapMb: -1 } }), /Swap/],
      ["too little memory", ct({ memory: { mb: 8, swapMb: 0 } }), /Memory/],
      ["an unknown feature", ct({ features: { mknod: true } }), /Unknown field features\.mknod/],
    ];
    for (const [label, spec, re] of cases) {
      const r = await create(c, "ct", spec);
      expect(r.status, label).toBe(400);
      expect((await j(r)).error, label).toMatch(re);
    }
    expect(posted(/\/lxc$/)).toHaveLength(0);
  });

  it("never returns or logs a password or key, even when Proxmox's error repeats it", async () => {
    const c = await signIn();
    pve.failures.add("echo");
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop";
    const r = await create(c, "ct", ct({ general: { hostname: "leaky", password: "hunter2-hunter2", sshKeys: key } }));
    const text = await r.text();
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(text).not.toContain("hunter2-hunter2");
    expect(logged.join("\n")).not.toContain("hunter2-hunter2");
    expect(pve.secretsSeen).toContain("hunter2-hunter2"); // it did reach Proxmox, which is the point
    const p = await preview(c, "ct", ct({ general: { hostname: "leaky", password: "hunter2-hunter2" } }));
    expect(JSON.stringify(await p.json())).not.toContain("hunter2-hunter2");
  });

  it("reports Proxmox's own reason when it can't create", async () => {
    const c = await signIn();
    pve.failures.add("create");
    const r = await create(c, "ct", ct());
    expect(r.status).toBe(502);
    expect((await j(r)).error).toMatch(/storage 'local-lvm' is full/);
  });
});

describe("access", () => {
  it("lets Proxmox refuse a person without the rights, and requires our own page", async () => {
    const lee = await signIn("lee");
    const r = await create(lee, "vm", vm());
    expect(r.status).toBe(403);
    expect(pve.created.size).toBe(0);
    const c = await signIn();
    const cross = await fetch(base + "/api/wizard/create", { method: "POST", headers: { "Content-Type": "application/json", Cookie: c }, body: JSON.stringify({ kind: "vm", spec: vm() }) });
    expect(cross.status).toBe(403);
    expect((await send("POST", "/api/wizard/create", { kind: "vm", spec: vm() })).status).toBe(401);
    expect((await create(c, "vm" as any, undefined)).status).toBe(400);
    expect((await send("POST", "/api/wizard/create", { kind: "disk", spec: {} }, { Cookie: c })).status).toBe(400);
    expect((await send("POST", "/api/wizard/create", { kind: "vm", spec: vm(), extra: 1 }, { Cookie: c })).status).toBe(400);
  });
});
