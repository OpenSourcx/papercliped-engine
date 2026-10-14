import { describe, expect, it } from "vitest";
import { MachineError, applyChange, planCpu, planCtOptions, planDevice, planMachine, planMemoryExtras, planNuma, planVmOptions, readSettings, type Cfg } from "../src/machine-schema.ts";
import { checkAgentAction, checkBulk, checkClone, checkDelete, checkPower, ipconfigString, planCloudInit, planCloudInitDrive, planMapping, planPassthrough, readCloudInit, spiceFile } from "../src/machine-extra.ts";

const vm = (extra: Cfg = {}): Cfg => ({ name: "vm", cores: 4, sockets: 1, memory: 4096, bios: "ovmf", machine: "q35", net0: "virtio=BC:24:11:AA:BB:01,bridge=vmbr0", ...extra });
const fails = (fn: () => unknown, re: RegExp) => expect(fn).toThrowError(re);

describe("processor details", () => {
  it("sets the type, flags and hidden hypervisor and keeps unknown keys", () => {
    const c = planCpu(vm({ cpu: "host,hv-vendor-id=proxmox" }), { type: "x86-64-v2-AES", flags: [{ name: "aes", mode: "+" }, { name: "pcid", mode: "-" }], hidden: true });
    expect(c.set.cpu).toBe("x86-64-v2-AES,hv-vendor-id=proxmox,flags=+aes;-pcid,hidden=1");
    expect(c.warnings.join(" ")).toMatch(/hypervisor/);
  });
  it("removes the whole setting when nothing is left", () => {
    const c = planCpu(vm({ cpu: "host" }), { type: null });
    expect(c.delete).toContain("cpu");
  });
  it("checks active CPUs against sockets times cores, affinity and NUMA", () => {
    expect(planCpu(vm(), { vcpus: 2, affinity: "0-3,8", numa: true }).set).toMatchObject({ vcpus: "2", affinity: "0-3,8", numa: "1" });
    fails(() => planCpu(vm(), { vcpus: 9 }), /Active CPUs/);
    fails(() => planCpu(vm(), { affinity: "a-b" }), /affinity/);
    fails(() => planCpu(vm(), {}), /Nothing to change/);
    fails(() => planCpu(vm(), { bogus: 1 }), /Unknown field/);
  });
  it("refuses a CPU type or flag the device doesn't report", () => {
    fails(() => planCpu(vm(), { type: "Pentium5" }, { cpuModels: ["host", "kvm64"] }), /doesn't list/);
    fails(() => planCpu(vm(), { flags: [{ name: "nope", mode: "+" }] }, { cpuFlags: ["aes"] }), /doesn't know/);
    fails(() => planCpu(vm(), { flags: [{ name: "aes", mode: "+" }, { name: "aes", mode: "-" }] }), /twice/);
  });
});

describe("memory, machine type and controller", () => {
  it("memory shares and huge pages", () => {
    expect(planMemoryExtras(vm(), { shares: 2000, hugepages: "1024" }).set).toEqual({ shares: "2000", hugepages: "1024" });
    expect(planMemoryExtras(vm({ hugepages: "2" }), { hugepages: null }).delete).toEqual(["hugepages", "keephugepages"]);
    fails(() => planMemoryExtras(vm(), { shares: 60000 }), /0 to 50000/);
    fails(() => planMemoryExtras(vm(), { hugepages: "4" }), /Huge pages/);
    fails(() => planMemoryExtras(vm(), { keephugepages: true }), /huge pages turned on/);
  });
  it("builds the machine property string and warns on a type change", () => {
    const c = planMachine(vm({ machine: "pc" }), { type: "q35", viommu: "virtio" });
    expect(c.set.machine).toBe("q35,viommu=virtio");
    expect(c.warnings.join(" ")).toMatch(/layout/);
    fails(() => planMachine(vm({ machine: "pc" }), { viommu: "intel" }), /q35/);
    fails(() => planMachine(vm(), { type: "pc-q35-9.0", viommu: "virtio", awBits: 39 }), /Intel/);
    expect(planMachine(vm(), { type: "pc-q35-9.0", viommu: "intel", awBits: 39 }).set.machine).toBe("pc-q35-9.0,viommu=intel,aw-bits=39");
    fails(() => planMachine(vm(), { type: "weird" }), /machine type/);
  });
  it("the SCSI controller", () => {
    expect(planMachine(vm(), { scsihw: "virtio-scsi-single" }).set.scsihw).toBe("virtio-scsi-single");
    fails(() => planMachine(vm(), { scsihw: "ide" }), /SCSI controller/);
  });
});

describe("small devices", () => {
  it("random number generator: root-only sources", () => {
    expect(planDevice(vm(), "rng", { action: "add" }).set.rng0).toBe("source=/dev/urandom");
    expect(planDevice(vm(), "rng", { action: "add", source: "/dev/hwrng", maxBytes: 1024, period: 1000 }, { admin: true }).set.rng0).toBe("source=/dev/hwrng,max_bytes=1024,period=1000");
    fails(() => planDevice(vm(), "rng", { action: "add", source: "/dev/random" }, { admin: false }), /administrators/);
    expect(planDevice(vm({ rng0: "source=/dev/urandom" }), "rng", { action: "remove" }).delete).toEqual(["rng0"]);
  });
  it("watchdog", () => {
    const c = planDevice(vm(), "watchdog", { action: "add", model: "i6300esb", watchdogAction: "reset" });
    expect(c.set.watchdog).toBe("model=i6300esb,action=reset");
    fails(() => planDevice(vm(), "watchdog", { action: "add", watchdogAction: "explode" }), /watchdog does/);
  });
  it("shared folders use a mapping and the next free slot", () => {
    const c = planDevice(vm({ virtiofs0: "dirid=a" }), "virtiofs", { action: "add", dirid: "docs", cache: "never", exposeAcl: true }, { dirMappings: ["docs"] });
    expect(c.set).toEqual({ virtiofs1: "dirid=docs,cache=never,expose-acl=1" });
    fails(() => planDevice(vm(), "virtiofs", { action: "add", dirid: "nope" }, { dirMappings: ["docs"] }), /no directory mapping/);
  });
  it("parallel ports are for administrators", () => {
    expect(planDevice(vm(), "parallel", { action: "add", path: "/dev/parport0" }, { admin: true }).set.parallel0).toBe("/dev/parport0");
    fails(() => planDevice(vm(), "parallel", { action: "add", path: "/dev/parport0" }, { admin: false }), /administrators/);
    fails(() => planDevice(vm(), "parallel", { action: "add", path: "/etc/passwd" }, { admin: true }), /parport/);
  });
  it("NUMA nodes turn NUMA on", () => {
    const c = planNuma(vm(), { action: "add", cpus: "0-1", hostnodes: "0", memory: 2048, policy: "bind" });
    expect(c.set).toEqual({ numa: "1", numa0: "cpus=0-1,hostnodes=0,memory=2048,policy=bind" });
    fails(() => planNuma(vm(), { action: "add", cpus: "x" }), /Virtual CPUs/);
  });
});

describe("VM options", () => {
  it("writes defaults as a delete and the rest as a value", () => {
    const c = planVmOptions(vm({ tablet: 0 }), { tablet: true, acpi: false, freeze: true, localtime: true, startdate: "2026-01-31", keyboard: "de", hotplug: ["network", "disk"] });
    expect(c.delete).toContain("tablet");
    expect(c.set).toMatchObject({ acpi: "0", freeze: "1", localtime: "1", startdate: "2026-01-31", keyboard: "de", hotplug: "disk,network" });
  });
  it("guest agent details keep the channel", () => {
    const c = planVmOptions(vm({ agent: "enabled=1" }), { agent: { freezeFs: false, fstrimClonedDisks: true, type: "isa" } });
    expect(c.set.agent).toBe("enabled=1,freeze-fs=0,fstrim_cloned_disks=1,type=isa");
  });
  it("SMBIOS fields are stored as base64", () => {
    const c = planVmOptions(vm(), { smbios: { manufacturer: "Acme", product: "Box" } });
    expect(c.set.smbios1).toBe(`manufacturer=${btoa("Acme")},product=${btoa("Box")},base64=1`);
    expect(readSettings("qemu", { ...vm(), ...c.set }).vm!.options.smbios).toMatchObject({ manufacturer: "Acme", product: "Box" });
    fails(() => planVmOptions(vm(), { smbios: { uuid: "nope" } }), /UUID/);
  });
  it("extra arguments are for administrators", () => {
    expect(planVmOptions(vm(), { args: "-cpu max" }, { admin: true }).set.args).toBe("-cpu max");
    fails(() => planVmOptions(vm(), { args: "-cpu max" }, { admin: false }), /administrators/);
    fails(() => planVmOptions(vm(), { args: "a\nb" }, { admin: true }), /one line/);
  });
  it("rejects bad values", () => {
    fails(() => planVmOptions(vm(), { hotplug: ["floppy"] }), /Hotplug/);
    fails(() => planVmOptions(vm(), { startdate: "tomorrow" }), /start date/);
    fails(() => planVmOptions(vm(), { keyboard: "klingon" }), /keyboard/);
    fails(() => planVmOptions(vm(), { tablet: "yes" }), /on or off/);
  });
});

describe("container options", () => {
  it("console mode, terminals, time zone, hook script", () => {
    const c = planCtOptions({ hostname: "x" }, { cmode: "console", tty: 4, console: false, timezone: "Europe/Berlin", hookscript: "local:snippets/h.pl", debug: true }, { admin: true });
    expect(c.set).toEqual({ cmode: "console", tty: "4", console: "0", timezone: "Europe/Berlin", hookscript: "local:snippets/h.pl", debug: "1" });
    fails(() => planCtOptions({}, { hookscript: "local:snippets/h.pl" }, { admin: false }), /administrators/);
    fails(() => planCtOptions({}, { timezone: "../etc" }), /time zone/);
    fails(() => planCtOptions({}, { tty: 9 }), /Terminals/);
  });
  it("reads container options", () => {
    expect(readSettings("lxc", { cmode: "shell", tty: 3, unprivileged: 1 }).ct).toMatchObject({ cmode: "shell", tty: 3, unprivileged: true, console: true });
  });
});

describe("host devices", () => {
  const root = { root: true };
  const user = { root: false, pciMappings: ["gpu0"], usbMappings: ["key1"] };
  it("a raw PCI device is root only, and says what to do instead", () => {
    const c = planPassthrough("qemu", vm(), { kind: "pci", action: "add", source: "raw", host: "0000:01:00.0", pcie: true, xVga: true }, root);
    expect(c.set).toEqual({ hostpci0: "host=0000:01:00.0,pcie=1,x-vga=1" });
    expect(c.warnings.join(" ")).toMatch(/migrated/);
    fails(() => planPassthrough("qemu", vm(), { kind: "pci", action: "add", source: "raw", host: "0000:01:00.0" }, user), /only root@pam[\s\S]*mapping/);
  });
  it("a saved mapping works for everyone with Mapping.Use", () => {
    expect(planPassthrough("qemu", vm(), { kind: "pci", action: "add", source: "mapping", mapping: "gpu0", pcie: true }, user).set.hostpci0).toBe("mapping=gpu0,pcie=1");
    fails(() => planPassthrough("qemu", vm(), { kind: "pci", action: "add", source: "mapping", mapping: "other" }, user), /no PCI mapping/);
  });
  it("PCI Express needs q35; options only root may set", () => {
    fails(() => planPassthrough("qemu", vm({ machine: "pc" }), { kind: "pci", action: "add", source: "raw", host: "0000:01:00.0", pcie: true }, root), /q35/);
    fails(() => planPassthrough("qemu", vm(), { kind: "pci", action: "add", source: "mapping", mapping: "gpu0", romfile: "a.rom" }, user), /Only root@pam may set romfile/);
    expect(planPassthrough("qemu", vm(), { kind: "pci", action: "add", source: "raw", host: ["0000:01:00.0", "0000:01:00.1"], romfile: "a.rom", rombar: false }, root).set.hostpci0).toBe("host=0000:01:00.0;0000:01:00.1,rombar=0,romfile=a.rom");
  });
  it("one device can't be passed through twice, slots are found and removal needs the slot", () => {
    const cfg = vm({ hostpci0: "host=0000:01:00.0" });
    fails(() => planPassthrough("qemu", cfg, { kind: "pci", action: "add", source: "raw", host: "0000:01:00.0" }, root), /already passed through as hostpci0/);
    expect(planPassthrough("qemu", cfg, { kind: "pci", action: "add", source: "raw", host: "0000:02:00.0" }, root).set).toHaveProperty("hostpci1");
    expect(planPassthrough("qemu", cfg, { kind: "pci", action: "remove", key: "hostpci0" }, root).delete).toEqual(["hostpci0"]);
    fails(() => planPassthrough("qemu", cfg, { kind: "pci", action: "remove", key: "hostpci3" }, root), /isn't on this machine/);
  });
  it("USB: device, port, mapping and SPICE", () => {
    expect(planPassthrough("qemu", vm(), { kind: "usb", action: "add", source: "host", host: "1234:abcd", usb3: true }, root).set.usb0).toBe("host=1234:abcd,usb3=1");
    expect(planPassthrough("qemu", vm(), { kind: "usb", action: "add", source: "port", host: "1-2.3" }, root).set.usb0).toBe("host=1-2.3");
    expect(planPassthrough("qemu", vm(), { kind: "usb", action: "add", source: "spice" }, user).set.usb0).toBe("host=spice");
    expect(planPassthrough("qemu", vm(), { kind: "usb", action: "add", source: "mapping", mapping: "key1" }, user).set.usb0).toBe("mapping=key1");
    fails(() => planPassthrough("qemu", vm(), { kind: "usb", action: "add", source: "host", host: "1234:abcd" }, user), /only root@pam/);
    fails(() => planPassthrough("qemu", vm(), { kind: "usb", action: "add", source: "host", host: "1-2" }, root), /1234:abcd/);
  });
  it("container devices: root only, a /dev path, octal mode", () => {
    const c = planPassthrough("lxc", { hostname: "x" }, { kind: "dev", action: "add", path: "/dev/dri/renderD128", mode: "0660", gid: 44 }, root);
    expect(c.set.dev0).toBe("path=/dev/dri/renderD128,mode=0660,gid=44");
    fails(() => planPassthrough("lxc", {}, { kind: "dev", action: "add", path: "/dev/dri/renderD128" }, user), /only root@pam/);
    fails(() => planPassthrough("lxc", {}, { kind: "dev", action: "add", path: "/etc/shadow" }, root), /device path/);
    fails(() => planPassthrough("lxc", {}, { kind: "dev", action: "add", path: "/dev/../etc" }, root), /device path/);
    fails(() => planPassthrough("lxc", {}, { kind: "dev", action: "add", path: "/dev/x", mode: "999" }, root), /octal/);
    fails(() => planPassthrough("lxc", {}, { kind: "pci", action: "add" }, root), /device nodes/);
  });
});

describe("resource mappings", () => {
  it("PCI", () => {
    const m = planMapping("pci", { id: "gpu0", description: "Render GPU", mdev: true, map: [{ node: "pve", path: "0000:01:00.0", id: "10DE:2484", iommugroup: 14 }] }, true);
    expect(m.params).toEqual({ id: "gpu0", description: "Render GPU", mdev: true, map: ["node=pve,path=0000:01:00.0,id=10de:2484,iommugroup=14"] });
    fails(() => planMapping("pci", { id: "g", map: [] }, true), /name has/);
    fails(() => planMapping("pci", { id: "gpu0", map: [{ node: "pve", path: "zz", id: "10de:2484" }] }, true), /PCI path/);
  });
  it("USB and directories", () => {
    expect(planMapping("usb", { id: "key1", map: [{ node: "pve", id: "1050:0407", path: "1-2.3" }] }, true).params.map).toEqual(["node=pve,id=1050:0407,path=1-2.3"]);
    expect(planMapping("dir", { id: "docs", map: [{ node: "pve", path: "/srv/docs" }] }, true).params.map).toEqual(["node=pve,path=/srv/docs"]);
    fails(() => planMapping("dir", { id: "docs", map: [{ node: "pve", path: "/srv/../etc" }] }, true), /absolute path/);
    fails(() => planMapping("dir", { id: "docs", map: [{ node: "pve", path: "/a" }, { node: "pve", path: "/b" }] }, true), /twice/);
  });
});

describe("Cloud-Init", () => {
  const ci = vm({ ide2: "local-lvm:vm-300-cloudinit,media=cdrom", ciuser: "ubuntu", cipassword: "**********", sshkeys: encodeURIComponent("ssh-ed25519 AAAAC3Nza me@pc"), nameserver: "1.1.1.1", ipconfig0: "ip=10.0.0.5/24,gw=10.0.0.1" });
  it("reads without exposing the password", () => {
    const v = readCloudInit(ci);
    expect(v).toMatchObject({ drive: { key: "ide2" }, user: "ubuntu", hasPassword: true, sshKeys: "ssh-ed25519 AAAAC3Nza me@pc", nameserver: ["1.1.1.1"] });
    expect(JSON.stringify(v)).not.toContain("*****");
    expect(v.ipconfig[0]).toMatchObject({ key: "ipconfig0", ip: "10.0.0.5/24", gw: "10.0.0.1" });
  });
  it("adds a drive on the next free slot", () => {
    expect(planCloudInit(vm(), { drive: { storage: "local-lvm" } }).set).toEqual({ ide0: "local-lvm:cloudinit" });
    fails(() => planCloudInit(ci, { drive: { storage: "local-lvm" } }), /already has/);
  });
  it("sets user, password, keys, DNS and addresses", () => {
    const c = planCloudInit(ci, { user: "admin", password: "correct horse", sshKeys: "ssh-ed25519 AAAAC3NzaC1 me@pc", upgrade: false, nameserver: ["9.9.9.9", "2620:fe::fe"], searchdomain: "lan", ipconfig: { ipconfig0: { ip: "dhcp" }, ipconfig1: null } });
    expect(c.set).toMatchObject({ ciuser: "admin", cipassword: "correct horse", ciupgrade: "0", nameserver: "9.9.9.9 2620:fe::fe", searchdomain: "lan", ipconfig0: "ip=dhcp" });
    expect(c.set.sshkeys).toBe(encodeURIComponent("ssh-ed25519 AAAAC3NzaC1 me@pc"));
    expect(c.delete).toContain("ipconfig1");
  });
  it("refuses bad input", () => {
    fails(() => planCloudInit(ci, { password: "short" }), /8 to 128/);
    fails(() => planCloudInit(ci, { sshKeys: "not a key" }), /SSH public key/);
    fails(() => planCloudInit(ci, { ipconfig: { ipconfig5: { ip: "dhcp" } } }), /no network device net5/);
    fails(() => ipconfigString({ ip: "10.0.0.5" }, "x"), /prefix/);
    fails(() => ipconfigString({ ip: "dhcp", gw: "10.0.0.1" }, "x"), /static/);
    fails(() => ipconfigString({ ip6: "fd00::5/64", gw6: "nope" }, "x"), /IPv6 gateway/);
    expect(ipconfigString({ ip: "10.0.0.5/24", gw: "10.0.0.1", ip6: "auto" }, "x")).toBe("ip=10.0.0.5/24,gw=10.0.0.1,ip6=auto");
    fails(() => planCloudInit(ci, { nope: 1 }), /Unknown field/);
  });
  it("custom files and removing the drive", () => {
    expect(planCloudInit(ci, { custom: { user: "local:snippets/user.yaml" } }).set.cicustom).toBe("user=local:snippets/user.yaml");
    fails(() => planCloudInit(ci, { custom: { user: "/etc/passwd" } }), /snippet/);
    expect(() => planCloudInitDrive(ci, { confirm: "ide2" })).not.toThrow();
    fails(() => planCloudInitDrive(ci, { confirm: "no" }), /Type ide2/);
    fails(() => planCloudInitDrive(vm(), { confirm: "x" }), /no Cloud-Init drive/);
  });
  it("warns when nothing lets you sign in", () => {
    expect(planCloudInit(vm({ ide2: "s:cloudinit" }), { upgrade: true }).warnings.join(" ")).toMatch(/sign in/);
  });
  it("applyChange mirrors Proxmox", () => {
    const cfg: Cfg = { a: "1", b: "2" };
    applyChange(cfg, { set: { c: "3" }, delete: ["a"], warnings: [] });
    expect(cfg).toEqual({ b: "2", c: "3" });
  });
});

describe("clone, power, delete, agent, bulk", () => {
  it("clone options", () => {
    const o = checkClone("qemu", true, { newid: 500, name: "web-2", target: "pve2", full: true, storage: "tank", format: "qcow2", snapname: "base", bwlimit: 10000, cloudInit: { user: "x" } });
    expect(o).toMatchObject({ full: true, newid: 500, target: "pve2", storage: "tank", format: "qcow2", bwlimit: 10000 });
    expect(checkClone("qemu", true, {}).full).toBe(false);
    expect(checkClone("qemu", false, { name: "web-2" }).full).toBe(true);
    fails(() => checkClone("qemu", false, { full: false }), /linked clone needs a template/);
    fails(() => checkClone("qemu", true, { storage: "tank", full: false }), /stays on the template/);
    fails(() => checkClone("lxc", false, { cloudInit: {} }), /virtual machines/);
    fails(() => checkClone("qemu", true, { newid: 5 }), /machine number/);
    fails(() => checkClone("qemu", true, { bogus: 1 }), /Unknown field/);
  });
  it("power", () => {
    expect(checkPower("qemu", { action: "hibernate", statestorage: "local" })).toEqual({ action: "hibernate", path: "suspend", params: { todisk: true, statestorage: "local" } });
    expect(checkPower("qemu", { action: "shutdown", timeout: 120, forceStop: true }).params).toEqual({ timeout: 120, forceStop: true });
    expect(checkPower("qemu", { action: "resume" }).path).toBe("resume");
    fails(() => checkPower("lxc", { action: "suspend" }), /can't be suspended/);
    fails(() => checkPower("lxc", { action: "reset" }), /Only VMs/);
    fails(() => checkPower("qemu", { action: "explode" }), /Unknown action/);
    fails(() => checkPower("qemu", { action: "shutdown", timeout: 99999 }), /timeout/);
  });
  it("delete options default to purge", () => {
    expect(checkDelete({ confirm: "web" })).toEqual({ confirm: "web", purge: true, destroyUnreferenced: false, skipLock: false });
    fails(() => checkDelete({ purge: "yes" }), /on or off/);
  });
  it("agent actions", () => {
    expect(checkAgentAction({ action: "exec", command: 'ls -la "/var/log dir"' })).toEqual({ action: "exec", command: ["ls", "-la", "/var/log dir"], input: undefined });
    expect(checkAgentAction({ action: "read-file", file: "/etc/os-release" })).toEqual({ action: "read-file", file: "/etc/os-release" });
    fails(() => checkAgentAction({ action: "read-file", file: "etc/os-release" }), /full path/);
    fails(() => checkAgentAction({ action: "set-password", user: "root", password: "x" }), /5 to 128/);
    fails(() => checkAgentAction({ action: "exec", command: "a\nb" }), /one line/);
    expect(checkAgentAction({ action: "freeze" })).toEqual({ action: "freeze" });
  });
  it("bulk", () => {
    expect(checkBulk({ action: "shutdown", vms: [100, 101, 100], timeout: 60 })).toMatchObject({ vms: [100, 101], timeout: 60, forceStop: true });
    fails(() => checkBulk({ action: "migrate", vms: [100] }), /node to move/);
    fails(() => checkBulk({ action: "start", vms: [] }), /1 to 500/);
    fails(() => checkBulk({ action: "start", vms: [5] }), /machine number/);
  });
  it("spice file", () => {
    expect(spiceFile({ type: "spice", host: "pve", "tls-port": 61000, password: "p", proxy: "http://pve:3128", nested: {}, "bad key": 1 })).toBe("[virt-viewer]\ntype=spice\nhost=pve\ntls-port=61000\npassword=p\nproxy=http://pve:3128\n");
  });
  it("errors carry the field", () => {
    try {
      planCpu(vm(), { affinity: "x" });
    } catch (e) {
      expect(e).toBeInstanceOf(MachineError);
      expect((e as MachineError).field).toBe("affinity");
    }
  });
});
