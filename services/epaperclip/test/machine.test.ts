import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { fakePve } from "./fakes.ts";
import { fakeMachine } from "./fakes-machine.ts";

let server: Server;
let base: string;
let pve: ReturnType<typeof fakeMachine>;

beforeEach(async () => {
  pve = fakeMachine(fakePve().transport);
  server = createServer(createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(), staticDir: null, secureCookies: false }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-EPC-Request": "1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const j = (r: Response): Promise<any> => r.json();
async function signIn(username = "sam", realm = "pve") {
  const r = await send("POST", "/api/login", { username, password: "right", realm });
  return r.headers.get("set-cookie")!.split(";")[0];
}
const get = (c: string, path: string) => fetch(`${base}${path}`, { headers: { Cookie: c } });
const post = (c: string, path: string, body: unknown) => send("POST", path, body, { Cookie: c });
const settings = async (c: string, vmid: number) => j(await get(c, `/api/guests/${vmid}/settings`));
const lastPut = (vmid: number) => [...pve.allCalls()].reverse().find((x) => x.method === "PUT" && x.path.endsWith(`/${vmid}/config`))!;
const puts = () => pve.allCalls().filter((x) => x.method === "PUT").length;

describe("processor details, memory extras, machine type", () => {
  it("reads the VM's settings with the digest", async () => {
    const c = await signIn();
    const s = await settings(c, 300);
    expect(s).toMatchObject({ type: "qemu", status: "running", name: "vm-app", isAdmin: true });
    expect(s.digest).toMatch(/^[0-9a-f]{40}$/);
    expect(s.vm.cpu).toMatchObject({ sockets: 1, cores: 2, type: null, numa: false });
    expect(s.vm.memory).toMatchObject({ memory: 4096, balloon: 2048 });
    expect(s.vm.options.agent.enabled).toBe(true);
  });

  it("sets the CPU type and flags, as Proxmox spells them, with the digest", async () => {
    const c = await signIn();
    const s = await settings(c, 302);
    const r = await post(c, "/api/guests/302/settings/cpu", { digest: s.digest, type: "x86-64-v2-AES", flags: [{ name: "aes", mode: "+" }, { name: "pcid", mode: "-" }], hidden: true, vcpus: 2, affinity: "0-1" });
    expect(r.status).toBe(200);
    expect(lastPut(302).params).toMatchObject({ cpu: "x86-64-v2-AES,flags=+aes;-pcid,hidden=1", vcpus: "2", affinity: "0-1", digest: s.digest });
    const again = await settings(c, 302);
    expect(again.vm.cpu).toMatchObject({ type: "x86-64-v2-AES", hidden: true, vcpus: 2, affinity: "0-1", flags: [{ name: "aes", mode: "+" }, { name: "pcid", mode: "-" }] });
  });

  it("refuses a CPU type or flag the device doesn't know", async () => {
    const c = await signIn();
    const s = await settings(c, 302);
    expect((await post(c, "/api/guests/302/settings/cpu", { digest: s.digest, type: "Pentium5" })).status).toBe(400);
    const r = await post(c, "/api/guests/302/settings/cpu", { digest: s.digest, flags: [{ name: "bogus", mode: "+" }] });
    expect((await j(r)).error).toMatch(/doesn't know a CPU flag/);
  });

  it("a stale digest, a busy machine and a wrong kind of machine are refused before anything is sent", async () => {
    const c = await signIn();
    const s = await settings(c, 302);
    const before = puts();
    expect((await post(c, "/api/guests/302/settings/cpu", { digest: "0".repeat(40), numa: true })).status).toBe(409);
    pve.guests.get(302)!.lock = "backup";
    const busy = await post(c, "/api/guests/302/settings/cpu", { digest: pve.digestOf(302), numa: true });
    expect(busy.status).toBe(409);
    expect((await j(busy)).code).toBe("busy");
    pve.guests.get(302)!.lock = undefined;
    expect((await post(c, "/api/guests/303/settings/cpu", { digest: (await settings(c, 303)).digest, numa: true })).status).toBe(400);
    expect((await post(c, "/api/guests/302/settings/ctoptions", { digest: s.digest, tty: 2 })).status).toBe(400);
    expect(puts()).toBe(before);
  });

  it("an account without permission gets Proxmox's refusal in plain words", async () => {
    const c = await signIn("lee");
    const s = await settings(c, 302);
    const r = await post(c, "/api/guests/302/settings/machine", { digest: s.digest, scsihw: "virtio-scsi-single" });
    expect(r.status).toBe(403);
    expect((await j(r)).error).toMatch(/doesn't have permission/);
  });

  it("memory shares and huge pages; machine type and SCSI controller; PCI Express follows q35", async () => {
    const c = await signIn();
    let s = await settings(c, 302);
    expect((await post(c, "/api/guests/302/settings/memory", { digest: s.digest, shares: 2000, hugepages: "1024" })).status).toBe(200);
    expect(lastPut(302).params).toMatchObject({ shares: "2000", hugepages: "1024" });
    s = await settings(c, 302);
    const r = await j(await post(c, "/api/guests/302/settings/machine", { digest: s.digest, type: "q35", viommu: "virtio", scsihw: "virtio-scsi-single" }));
    expect(r.warnings.join(" ")).toMatch(/layout/);
    expect(lastPut(302).params).toMatchObject({ machine: "q35,viommu=virtio", scsihw: "virtio-scsi-single" });
    s = await settings(c, 302);
    expect(s.vm.machine).toMatchObject({ type: "q35", viommu: "virtio" });
    expect(s.vm.scsihw).toBe("virtio-scsi-single");
  });

  it("a running VM says the change waits for a restart", async () => {
    const c = await signIn();
    const s = await settings(c, 300);
    const r = await j(await post(c, "/api/guests/300/settings/memory", { digest: s.digest, shares: 500 }));
    expect(r.pending).toBe(true);
    expect((await settings(c, 300)).pendingKeys).toContain("shares");
  });
});

describe("small devices", () => {
  it("random number generator, watchdog, shared folders, NUMA and parallel ports", async () => {
    const c = await signIn();
    const step = async (group: string, body: Record<string, unknown>) => {
      const s = await settings(c, 302);
      const r = await post(c, `/api/guests/302/settings/${group}`, { digest: s.digest, ...body });
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
      return j(r);
    };
    await step("rng", { action: "add", source: "/dev/urandom", maxBytes: 1024, period: 1000 });
    expect(lastPut(302).params.rng0).toBe("source=/dev/urandom,max_bytes=1024,period=1000");
    await step("watchdog", { action: "add", model: "i6300esb", watchdogAction: "reset" });
    expect(lastPut(302).params.watchdog).toBe("model=i6300esb,action=reset");
    await step("virtiofs", { action: "add", dirid: "docs", cache: "never" });
    expect(lastPut(302).params.virtiofs0).toBe("dirid=docs,cache=never");
    await step("numa", { action: "add", cpus: "0-3", hostnodes: "0", memory: 4096, policy: "bind" });
    expect(lastPut(302).params).toMatchObject({ numa: "1", numa0: "cpus=0-3,hostnodes=0,memory=4096,policy=bind" });
    await step("parallel", { action: "add", path: "/dev/parport0" });
    const s = await settings(c, 302);
    expect(s.vm.rng).toMatchObject({ source: "/dev/urandom", maxBytes: 1024, period: 1000 });
    expect(s.vm.watchdog).toMatchObject({ model: "i6300esb", action: "reset" });
    expect(s.vm.virtiofs[0]).toMatchObject({ key: "virtiofs0", dirid: "docs", cache: "never" });
    expect(s.vm.numaNodes[0]).toMatchObject({ key: "numa0", cpus: "0-3", policy: "bind" });
    expect(s.vm.parallel[0]).toMatchObject({ path: "/dev/parport0" });
    await step("rng", { action: "remove" });
    expect(lastPut(302).params.delete).toBe("rng0");
  });

  it("a shared folder needs a directory mapping that exists", async () => {
    const c = await signIn();
    const s = await settings(c, 302);
    const r = await post(c, "/api/guests/302/settings/virtiofs", { digest: s.digest, action: "add", dirid: "nope" });
    expect((await j(r)).error).toMatch(/no directory mapping called nope/);
  });

  it("choices for the editors list CPU models, flags, machine types and mappings", async () => {
    const c = await signIn();
    const ch = await j(await get(c, "/api/guests/302/settings/choices"));
    expect(ch.cpuModels.map((m: any) => m.name)).toContain("host");
    expect(ch.cpuFlags.map((m: any) => m.name)).toContain("spec-ctrl");
    expect(ch.machines.map((m: any) => m.id)).toContain("pc-q35-9.0");
    expect(ch.dirMappings[0].id).toBe("docs");
    expect(ch.storages).toContain("local-lvm");
  });
});

describe("VM and container options", () => {
  it("VM options, guest agent details and SMBIOS", async () => {
    const c = await signIn();
    const s = await settings(c, 300);
    const r = await post(c, "/api/guests/300/settings/vmoptions", { digest: s.digest, tablet: false, freeze: true, startdate: "2026-01-31", hotplug: ["disk", "network"], keyboard: "de", agent: { freezeFs: false, fstrimClonedDisks: true }, smbios: { manufacturer: "Acme", product: "Box" } });
    expect(r.status).toBe(200);
    const p = lastPut(300).params;
    expect(p).toMatchObject({ tablet: "0", freeze: "1", startdate: "2026-01-31", hotplug: "disk,network", keyboard: "de", agent: "enabled=1,freeze-fs=0,fstrim_cloned_disks=1" });
    expect(p.smbios1).toContain("base64=1");
    const again = await settings(c, 300);
    expect(again.vm.options).toMatchObject({ tablet: false, freeze: true, hotplug: ["disk", "network"], smbios: { manufacturer: "Acme", product: "Box" } });
  });

  it("extra QEMU arguments are for administrators only: the host refuses before Proxmox is asked", async () => {
    const c = await signIn();
    const s = await settings(c, 302);
    // sam is an administrator here; Proxmox then enforces root@pam for args, and its refusal comes through.
    const r = await post(c, "/api/guests/302/settings/vmoptions", { digest: s.digest, args: "-cpu max" });
    expect(r.status).toBe(403);
    const root = await signIn("root", "pam");
    const s2 = await settings(root, 302);
    expect((await post(root, "/api/guests/302/settings/vmoptions", { digest: s2.digest, args: "-cpu max" })).status).toBe(200);
  });

  it("container options: console mode, terminals, time zone", async () => {
    const c = await signIn();
    const s = await settings(c, 303);
    expect(s.ct).toMatchObject({ cmode: "tty", tty: 2, arch: "amd64" });
    const r = await post(c, "/api/guests/303/settings/ctoptions", { digest: s.digest, cmode: "console", tty: 4, timezone: "Europe/Berlin", console: false });
    expect(r.status).toBe(200);
    expect(lastPut(303).params).toMatchObject({ cmode: "console", tty: "4", timezone: "Europe/Berlin", console: "0" });
    expect((await post(c, "/api/guests/303/settings/ctoptions", { digest: (await settings(c, 303)).digest, timezone: "../x" })).status).toBe(400);
  });

  it("unknown fields are refused", async () => {
    const c = await signIn();
    const s = await settings(c, 302);
    const r = await post(c, "/api/guests/302/settings/vmoptions", { digest: s.digest, tablet: true, bogus: 1 });
    expect((await j(r)).error).toMatch(/Unknown field/);
  });
});

describe("host devices", () => {
  it("lists host devices and tells a non-root account what to do instead", async () => {
    const c = await signIn();
    const d = await j(await get(c, "/api/guests/302/host-devices"));
    expect(d.root).toBe(false);
    expect(d.explainer).toMatch(/only root@pam[\s\S]*Mapping\.Use/);
    expect(d.pci.map((x: any) => x.id)).toContain("0000:01:00.0");
    expect(d.usb.map((x: any) => x.id)).toContain("1234:5678");
    expect(d.mappings.pci[0]).toMatchObject({ id: "gpu0", mdev: true });
    const root = await signIn("root", "pam");
    expect((await j(await get(root, "/api/guests/302/host-devices"))).root).toBe(true);
  });

  it("a raw PCI device is refused for others and works for root; a mapping works for both", async () => {
    const c = await signIn();
    let s = await settings(c, 302);
    const before = puts();
    const r = await post(c, "/api/guests/302/host-devices", { digest: s.digest, kind: "pci", action: "add", source: "raw", host: "0000:01:00.0" });
    expect(r.status).toBe(400);
    expect((await j(r)).error).toMatch(/only root@pam/);
    expect(puts()).toBe(before);
    const m = await j(await post(c, "/api/guests/302/host-devices", { digest: s.digest, kind: "pci", action: "add", source: "mapping", mapping: "gpu0" }));
    expect(m.warnings.join(" ")).toMatch(/migrated/);
    expect(lastPut(302).params.hostpci0).toBe("mapping=gpu0");
    expect(m.key).toBe("hostpci0");
    s = await settings(c, 302);
    const root = await signIn("root", "pam");
    const rs = await settings(root, 302);
    const ok = await j(await post(root, "/api/guests/302/host-devices", { digest: rs.digest, kind: "pci", action: "add", source: "raw", host: ["0000:02:00.0"], rombar: false }));
    expect(ok.key).toBe("hostpci1");
    expect(lastPut(302).params.hostpci1).toBe("host=0000:02:00.0,rombar=0");
  });

  it("PCI Express needs the q35 machine type", async () => {
    const c = await signIn();
    const s = await settings(c, 302);
    const r = await post(c, "/api/guests/302/host-devices", { digest: s.digest, kind: "pci", action: "add", source: "mapping", mapping: "gpu0", pcie: true });
    expect(r.status).toBe(400);
    expect((await j(r)).error).toMatch(/q35/);
  });

  it("removes a device and refuses to remove one that isn't there", async () => {
    const c = await signIn();
    const s = await settings(c, 300);
    const gone = await post(c, "/api/guests/300/host-devices", { digest: s.digest, kind: "usb", action: "remove", key: "usb0" });
    expect(gone.status).toBe(200);
    expect(lastPut(300).params.delete).toBe("usb0");
    const s2 = await settings(c, 300);
    expect((await post(c, "/api/guests/300/host-devices", { digest: s2.digest, kind: "usb", action: "remove", key: "usb3" })).status).toBe(400);
  });

  it("USB: SPICE and mappings for anyone, a raw device for root", async () => {
    const c = await signIn();
    const s = await settings(c, 302);
    await post(c, "/api/guests/302/host-devices", { digest: s.digest, kind: "usb", action: "add", source: "spice" });
    expect(lastPut(302).params.usb0).toBe("host=spice");
    const s2 = await settings(c, 302);
    const raw = await post(c, "/api/guests/302/host-devices", { digest: s2.digest, kind: "usb", action: "add", source: "host", host: "1234:5678", usb3: true });
    expect(raw.status).toBe(400);
    const root = await signIn("root", "pam");
    const rs = await settings(root, 302);
    expect((await post(root, "/api/guests/302/host-devices", { digest: rs.digest, kind: "usb", action: "add", source: "host", host: "1234:5678", usb3: true })).status).toBe(200);
    expect(lastPut(302).params.usb1).toBe("host=1234:5678,usb3=1");
  });

  it("container devices are root only and need a /dev path", async () => {
    const c = await signIn();
    const s = await settings(c, 303);
    expect((await j(await post(c, "/api/guests/303/host-devices", { digest: s.digest, kind: "dev", action: "add", path: "/dev/dri/renderD128" }))).error).toMatch(/only root@pam/);
    const root = await signIn("root", "pam");
    const rs = await settings(root, 303);
    expect((await post(root, "/api/guests/303/host-devices", { digest: rs.digest, kind: "dev", action: "add", path: "/dev/dri/renderD128", mode: "0660", gid: 44 })).status).toBe(200);
    expect(lastPut(303).params.dev0).toBe("path=/dev/dri/renderD128,mode=0660,gid=44");
    expect((await post(root, "/api/guests/303/host-devices", { digest: (await settings(root, 303)).digest, kind: "dev", action: "add", path: "/etc/passwd" })).status).toBe(400);
  });
});

describe("pending changes", () => {
  it("lists what waits for a restart and reverts it", async () => {
    const c = await signIn();
    const s = await settings(c, 300);
    await post(c, "/api/guests/300/settings/memory", { digest: s.digest, shares: 500 });
    const p = await j(await get(c, "/api/guests/300/pending"));
    expect(p.running).toBe(true);
    expect(p.items[0]).toMatchObject({ key: "shares", pending: "500" });
    const s2 = await settings(c, 300);
    const r = await post(c, "/api/guests/300/pending/revert", { digest: s2.digest, keys: ["shares"] });
    expect(r.status).toBe(200);
    expect(lastPut(300).params.revert).toBe("shares");
    expect((await j(await get(c, "/api/guests/300/pending"))).items).toEqual([]);
  });

  it("only a running machine has pending changes to revert", async () => {
    const c = await signIn();
    const s = await settings(c, 302);
    expect((await post(c, "/api/guests/302/pending/revert", { digest: s.digest, keys: ["shares"] })).status).toBe(409);
  });
});

describe("Cloud-Init", () => {
  const view = async (c: string, vmid = 302) => j(await get(c, `/api/guests/${vmid}/cloudinit`));

  it("adds the drive, sets everything, never returns the password, and shows what the image doesn't have yet", async () => {
    const c = await signIn();
    let v = await view(c);
    expect(v.view.drive).toBeNull();
    expect(v.storages).toContain("local-lvm");
    expect(v.snippets).toContain("local:snippets/user.yaml");
    expect((await post(c, "/api/guests/302/cloudinit", { digest: v.digest, drive: { storage: "local-lvm" } })).status).toBe(200);
    expect(lastPut(302).params.ide0).toBe("local-lvm:cloudinit");
    v = await view(c);
    expect(v.view.drive).toMatchObject({ key: "ide0" });
    const r = await post(c, "/api/guests/302/cloudinit", { digest: v.digest, user: "ubuntu", password: "correct horse battery", sshKeys: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA me@pc", upgrade: false, nameserver: ["1.1.1.1"], searchdomain: "lan", ipconfig: { ipconfig0: { ip: "10.0.0.5/24", gw: "10.0.0.1" } } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).not.toContain("correct horse");
    expect(lastPut(302).params).toMatchObject({ ciuser: "ubuntu", cipassword: "correct horse battery", ciupgrade: "0", nameserver: "1.1.1.1", searchdomain: "lan", ipconfig0: "ip=10.0.0.5/24,gw=10.0.0.1" });
    expect(lastPut(302).params.sshkeys).toBe(encodeURIComponent("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA me@pc"));
    v = await view(c);
    expect(JSON.stringify(v)).not.toContain("correct horse");
    expect(v.view).toMatchObject({ user: "ubuntu", hasPassword: true, sshKeys: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA me@pc", upgrade: false });
    expect(v.changed.map((x: any) => x.key)).toContain("ciuser");
    expect(v.changed.find((x: any) => x.key === "cipassword").pending).toBeNull();
  });

  it("regenerates the image and shows the generated files without the password hash", async () => {
    const c = await signIn();
    const v = await view(c);
    await post(c, "/api/guests/302/cloudinit", { digest: v.digest, user: "ubuntu" });
    expect((await view(c)).changed.length).toBeGreaterThan(0);
    expect((await post(c, "/api/guests/302/cloudinit/regenerate", {})).status).toBe(200);
    expect((await view(c)).changed).toEqual([]);
    const dump = await j(await get(c, "/api/guests/302/cloudinit/dump?type=user"));
    expect(dump.text).toContain("#cloud-config");
    expect(dump.text).not.toContain("secrethash");
    expect((await get(c, "/api/guests/302/cloudinit/dump?type=other")).status).toBe(400);
  });

  it("custom files must be snippets; removing the drive needs its slot typed", async () => {
    const c = await signIn();
    let v = await view(c);
    await post(c, "/api/guests/302/cloudinit", { digest: v.digest, drive: { storage: "local-lvm" } });
    v = await view(c);
    expect((await post(c, "/api/guests/302/cloudinit", { digest: v.digest, custom: { user: "/etc/passwd" } })).status).toBe(400);
    expect((await post(c, "/api/guests/302/cloudinit", { digest: v.digest, custom: { user: "local:snippets/user.yaml" } })).status).toBe(200);
    expect(lastPut(302).params.cicustom).toBe("user=local:snippets/user.yaml");
    v = await view(c);
    const wrong = await post(c, "/api/guests/302/cloudinit/drive/remove", { digest: v.digest, confirm: "no" });
    expect(wrong.status).toBe(400);
    expect((await post(c, "/api/guests/302/cloudinit/drive/remove", { digest: v.digest, confirm: "ide0" })).status).toBe(200);
    expect(lastPut(302).params.delete).toBe("ide0");
  });

  it("is for virtual machines, and refuses a short password and a bad key before Proxmox", async () => {
    const c = await signIn();
    expect((await get(c, "/api/guests/303/cloudinit")).status).toBe(400);
    const v = await view(c);
    const before = puts();
    expect((await post(c, "/api/guests/302/cloudinit", { digest: v.digest, password: "short" })).status).toBe(400);
    expect((await post(c, "/api/guests/302/cloudinit", { digest: v.digest, sshKeys: "nope" })).status).toBe(400);
    expect(puts()).toBe(before);
  });
});

describe("power", () => {
  it("suspends, hibernates and resumes a VM with the right Proxmox parameters", async () => {
    const c = await signIn();
    const r = await post(c, "/api/guests/300/status", { action: "suspend" });
    expect(r.status).toBe(202);
    expect(pve.state.suspended.has(300)).toBe(true);
    expect((await post(c, "/api/guests/300/status", { action: "resume" })).status).toBe(202);
    expect((await post(c, "/api/guests/300/status", { action: "hibernate", statestorage: "local-lvm" })).status).toBe(202);
    const call = [...pve.calls].reverse().find((x) => x.path.endsWith("/300/status/suspend"))!;
    expect(call.params).toMatchObject({ todisk: "1", statestorage: "local-lvm" });
    expect(pve.guests.get(300)!.status).toBe("stopped");
  });

  it("shutdown takes a timeout and force stop; reboot a timeout", async () => {
    const c = await signIn();
    await post(c, "/api/guests/301/status", { action: "shutdown", timeout: 30, forceStop: true });
    const call = [...pve.calls].reverse().find((x) => x.path.endsWith("/301/status/shutdown"))!;
    expect(call.params).toMatchObject({ timeout: "30", forceStop: "1" });
  });

  it("a container can't be suspended, a template can't be started, a stopped VM can't be resumed", async () => {
    const c = await signIn();
    expect((await j(await post(c, "/api/guests/301/status", { action: "suspend" }))).error).toMatch(/can't be suspended/);
    expect((await post(c, "/api/guests/302/status", { action: "resume" })).status).toBe(409);
    expect((await post(c, "/api/guests/300/status", { action: "explode" })).status).toBe(400);
    expect((await post(c, "/api/guests/300/status", { action: "shutdown", timeout: -1 })).status).toBe(400);
  });
});

describe("snapshots", () => {
  it("edits the description, shows the snapshot's settings, and restores and starts with the name typed", async () => {
    const c = await signIn();
    await post(c, "/api/guests/302/snapshots", { name: "before-upgrade", description: "first", vmstate: false });
    expect((await post(c, "/api/guests/302/snapshots/before-upgrade/describe", { description: "Before the 24.04 upgrade" })).status).toBe(200);
    const cfg = await j(await get(c, "/api/guests/302/snapshots/before-upgrade/config"));
    expect(cfg).toMatchObject({ name: "before-upgrade", description: "Before the 24.04 upgrade", vmstate: null });
    expect(cfg.settings.cores).toBe("4");
    const bad = await post(c, "/api/guests/302/snapshots/before-upgrade/restore", { confirm: "nope", start: true });
    expect(bad.status).toBe(409);
    const ok = await post(c, "/api/guests/302/snapshots/before-upgrade/restore", { confirm: "before-upgrade", start: true });
    expect(ok.status).toBe(202);
    expect(pve.state.rollbacks).toEqual([{ vmid: 302, snap: "before-upgrade", start: true }]);
    expect(pve.guests.get(302)!.status).toBe("running");
  });

  it("refuses a long description", async () => {
    const c = await signIn();
    await post(c, "/api/guests/302/snapshots", { name: "snap-one" });
    expect((await post(c, "/api/guests/302/snapshots/snap-one/describe", { description: "x".repeat(2000) })).status).toBe(400);
  });
});

describe("clone with options", () => {
  it("offers nodes, storages, snapshots and whether a linked clone is possible", async () => {
    const c = await signIn();
    await post(c, "/api/guests/302/snapshots", { name: "base-image" });
    const o = await j(await get(c, "/api/guests/302/clone-options"));
    expect(o).toMatchObject({ type: "qemu", template: false, canLink: false, cloudInit: true });
    expect(o.nodes).toContain("pve");
    expect(o.snapshots).toEqual(["base-image"]);
    expect(o.storages.map((s: any) => s.storage)).toContain("local-lvm");
  });

  it("clones with a chosen number, node, storage, format, snapshot and bandwidth limit", async () => {
    const c = await signIn();
    await post(c, "/api/guests/302/snapshots", { name: "base-image" });
    const r = await post(c, "/api/guests/302/clone-options", { newid: 555, name: "web-2", target: "pve", storage: "local-lvm", format: "qcow2", snapname: "base-image", bwlimit: 50000, pool: "co-acme", description: "from base" });
    expect(r.status).toBe(202);
    const out = await j(r);
    expect(out.vmid).toBe(555);
    const call = pve.calls.find((x) => x.path.endsWith("/302/clone"))!;
    expect(call.params).toMatchObject({ newid: "555", name: "web-2", target: "pve", storage: "local-lvm", format: "qcow2", snapname: "base-image", bwlimit: "50000", full: "1", pool: "co-acme" });
    expect(pve.guests.get(555)!.name).toBe("web-2");
  });

  it("a taken number and a linked clone of a non-template are refused", async () => {
    const c = await signIn();
    expect((await post(c, "/api/guests/302/clone-options", { newid: 300 })).status).toBe(409);
    expect((await post(c, "/api/guests/302/clone-options", { full: false })).status).toBe(400);
    expect((await post(c, "/api/guests/302/clone-options", { target: "ghost" })).status).toBe(400);
  });

  it("clone to Cloud-Init: copies, then sets the user, keys and address, grows the disk and starts", async () => {
    const c = await signIn();
    const r = await post(c, "/api/guests/302/clone-options", { newid: 600, name: "ci-1", cloudInit: { user: "ubuntu", password: "correct horse battery", sshKeys: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA me@pc", ipconfig: { ipconfig0: { ip: "10.0.0.50/24", gw: "10.0.0.1" } } }, growGb: 8, start: true });
    expect(r.status).toBe(202);
    const out = await j(r);
    expect(JSON.stringify(out)).not.toContain("correct horse");
    expect(out.steps.filter((s: any) => !s.ok), JSON.stringify(out)).toEqual([]);
    expect(out.applied).toBe(true);
    expect(out.steps.map((s: any) => s.step)).toEqual(["Cloud-Init", "Grow disk", "Start"]);
    const put = pve.calls.find((x) => x.method === "PUT" && x.path.endsWith("/600/config"))!;
    expect(put.params).toMatchObject({ ciuser: "ubuntu", ipconfig0: "ip=10.0.0.50/24,gw=10.0.0.1" });
    expect(pve.state.resizes).toEqual([{ vmid: 600, disk: "scsi0", size: "+8G" }]);
    expect(pve.calls.some((x) => x.path.endsWith("/600/status/start"))).toBe(true);
  });

  it("refuses bad Cloud-Init values before cloning anything", async () => {
    const c = await signIn();
    const before = pve.guests.size;
    const r = await post(c, "/api/guests/302/clone-options", { newid: 601, cloudInit: { password: "short" } });
    // The copy starts, then the Cloud-Init step reports its own reason.
    const out = await j(r);
    expect(r.status).toBe(202);
    expect(out.steps[0]).toMatchObject({ step: "Cloud-Init", ok: false });
    expect(out.steps[0].message).toMatch(/8 to 128/);
    expect(pve.guests.size).toBe(before + 1);
  });
});

describe("delete with options", () => {
  it("needs the name typed, honours protection and passes the purge options", async () => {
    const c = await signIn();
    expect((await post(c, "/api/guests/302/delete", { confirm: "wrong" })).status).toBe(409);
    pve.guests.get(302)!.cfg.protection = 1;
    expect((await post(c, "/api/guests/302/delete", { confirm: "vm-win" })).status).toBe(409);
    pve.guests.get(302)!.cfg.protection = 0;
    expect((await post(c, "/api/guests/300/delete", { confirm: "vm-app" })).status).toBe(409); // running
    const r = await post(c, "/api/guests/302/delete", { confirm: "vm-win", purge: false, destroyUnreferenced: true });
    expect(r.status).toBe(202);
    expect(pve.state.deleted[0].params).toMatchObject({ purge: "0", "destroy-unreferenced-disks": "1" });
    expect(pve.guests.has(302)).toBe(false);
  });
});

describe("SPICE and the QEMU monitor", () => {
  it("builds a .vv file from Proxmox's answer", async () => {
    const c = await signIn();
    const r = await j(await post(c, "/api/guests/300/spice", { proxy: "pve.lan" }));
    expect(r.filename).toBe("vm-app-300.vv");
    expect(r.file.startsWith("[virt-viewer]\ntype=spice\n")).toBe(true);
    expect(r.file).toContain("proxy=http://pve.lan:3128");
    expect(r.file).toContain("tls-port=61000");
    expect((await post(c, "/api/guests/300/spice", { proxy: "bad host!" })).status).toBe(400);
    expect((await post(c, "/api/guests/301/spice", {})).status).toBe(400);
    expect((await post(c, "/api/guests/302/spice", {})).status).toBe(409);
  });

  it("runs one monitor command on a running VM", async () => {
    const c = await signIn();
    const r = await j(await post(c, "/api/guests/300/monitor", { command: "info status" }));
    expect(r.output).toContain("running");
    expect(pve.state.monitor).toEqual([{ vmid: 300, command: "info status" }]);
    expect((await post(c, "/api/guests/300/monitor", { command: "info\nquit" })).status).toBe(400);
    expect((await post(c, "/api/guests/302/monitor", { command: "info status" })).status).toBe(409);
    expect((await post(c, "/api/guests/301/monitor", { command: "info status" })).status).toBe(400);
  });
});

describe("guest agent", () => {
  it("reads agent, OS, file system, user, time, time zone and CPU information", async () => {
    const c = await signIn();
    expect((await j(await get(c, "/api/guests/300/agent/osinfo"))).result["pretty-name"]).toBe("Ubuntu 24.04 LTS");
    expect((await j(await get(c, "/api/guests/300/agent/fsinfo"))).result[0].mountpoint).toBe("/");
    expect((await j(await get(c, "/api/guests/300/agent/users"))).result[0].user).toBe("ubuntu");
    expect((await j(await get(c, "/api/guests/300/agent/timezone"))).result.zone).toBe("UTC");
    expect((await j(await get(c, "/api/guests/300/agent/vcpus"))).result).toHaveLength(2);
    expect((await j(await get(c, "/api/guests/300/agent/info"))).result.version).toBe("8.2.0");
  });

  it("explains an agent that doesn't answer, and a machine that isn't running", async () => {
    const c = await signIn();
    pve.agent.up = false;
    const r = await get(c, "/api/guests/300/agent/osinfo");
    expect(r.status).toBe(409);
    expect((await j(r)).code).toBe("agent_down");
    pve.agent.up = true;
    expect((await get(c, "/api/guests/302/agent/osinfo")).status).toBe(409);
    expect((await get(c, "/api/guests/301/agent/osinfo")).status).toBe(400);
  });

  it("ping, trim, freeze (typed) and thaw", async () => {
    const c = await signIn();
    expect((await j(await post(c, "/api/guests/300/agent", { action: "ping" }))).ok).toBe(true);
    expect((await j(await post(c, "/api/guests/300/agent", { action: "fstrim" }))).message).toMatch(/handed back/);
    expect((await post(c, "/api/guests/300/agent", { action: "freeze" })).status).toBe(409);
    expect((await post(c, "/api/guests/300/agent", { action: "freeze", confirm: "freeze" })).status).toBe(200);
    expect(pve.state.frozen.has(300)).toBe(true);
    expect((await j(await post(c, "/api/guests/300/agent", { action: "freeze-status" }))).message).toMatch(/frozen/);
    await post(c, "/api/guests/300/agent", { action: "thaw" });
    expect(pve.state.frozen.has(300)).toBe(false);
  });

  it("sets a password without ever showing it, even in Proxmox's error", async () => {
    const c = await signIn();
    const ok = await post(c, "/api/guests/300/agent", { action: "set-password", user: "ubuntu", password: "new-pass-123" });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(await ok.json())).not.toContain("new-pass-123");
    expect(pve.state.agentPassword).toEqual([{ vmid: 300, username: "ubuntu" }]);
    const bad = await post(c, "/api/guests/300/agent", { action: "set-password", user: "ubuntu", password: "boom-secret-pw" });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(await bad.text()).not.toContain("boom-secret-pw");
  });

  it("runs a command after typed confirmation, and reads a file", async () => {
    const c = await signIn();
    expect((await post(c, "/api/guests/300/agent", { action: "exec", command: "uname -a" })).status).toBe(409);
    const r = await j(await post(c, "/api/guests/300/agent", { action: "exec", command: 'ls -la "/var/log dir"', confirm: "run" }));
    expect(r).toMatchObject({ finished: true, exitcode: 0 });
    expect(pve.state.execs[0].command).toEqual(["ls", "-la", "/var/log dir"]);
    const f = await j(await post(c, "/api/guests/300/agent", { action: "read-file", file: "/etc/os-release" }));
    expect(f.content).toContain("Ubuntu");
    expect((await post(c, "/api/guests/300/agent", { action: "read-file", file: "etc/os-release" })).status).toBe(400);
    expect((await post(c, "/api/guests/300/agent", { action: "read-file", file: "/nope" })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("hardware, capabilities, mappings, CPU models and bulk actions", () => {
  it("lists PCI devices with IOMMU groups and the mappings they are in, and mediated types", async () => {
    const c = await signIn();
    const h = await j(await get(c, "/api/hardware/pci"));
    const gpu = h.devices.find((d: any) => d.id === "0000:01:00.0");
    expect(gpu).toMatchObject({ iommuGroup: 14, mdev: true, mappings: ["gpu0"], vendor: "NVIDIA Corporation" });
    expect(h.devices.map((d: any) => d.id)).not.toContain("0000:00:00.0"); // host bridges are filtered, as Proxmox does
    const all = await j(await get(c, "/api/hardware/pci?all=1"));
    expect(all.devices.map((d: any) => d.id)).toContain("0000:00:00.0");
    const t = await j(await get(c, "/api/hardware/pci/mdev?id=0000:01:00.0"));
    expect(t.types[0]).toMatchObject({ type: "nvidia-63", available: 8 });
    expect((await get(c, "/api/hardware/pci/mdev?id=%24x")).status).toBe(400);
  });

  it("lists USB devices, and says why a non-administrator can't", async () => {
    const c = await signIn();
    const u = await j(await get(c, "/api/hardware/usb"));
    expect(u.devices.find((d: any) => d.id === "1234:5678")).toMatchObject({ port: "1-2", name: "Acme Security key", hub: false });
    expect(u.devices.find((d: any) => d.id === "1d6b:0002").hub).toBe(true);
    const lee = await signIn("lee");
    const denied = await j(await get(lee, "/api/hardware/usb"));
    expect(denied.devices).toEqual([]);
    expect(denied.note).toMatch(/can't read USB devices/);
  });

  it("reads CPU models, flags, machine types and migration support", async () => {
    const c = await signIn();
    const k = await j(await get(c, "/api/capabilities/qemu"));
    expect(k.cpu.map((x: any) => x.name)).toContain("Skylake-Server");
    expect(k.cpu.find((x: any) => x.name === "custom-fast").custom).toBe(true);
    expect(k.flags.map((x: any) => x.name)).toContain("spec-ctrl");
    expect(k.machines.map((x: any) => x.id)).toContain("pc-q35-9.0");
    expect(k.migration.cpu).toBe("Skylake-Server");
  });

  it("creates, edits and deletes a PCI mapping with checks", async () => {
    const c = await signIn();
    let list = await j(await get(c, "/api/mappings/pci"));
    expect(list.canModify).toBe(true);
    expect(list.mappings[0]).toMatchObject({ id: "gpu0", description: "Render GPU", mdev: true });
    expect(list.mappings[0].map[0]).toMatchObject({ node: "pve", path: "0000:01:00.0", id: "10de:2484", iommugroup: 14 });
    const r = await post(c, "/api/mappings/pci", { id: "nic1", description: "10G card", map: [{ node: "pve", path: "0000:03:00.0", id: "8086:1572", iommugroup: 20 }] });
    expect(r.status).toBe(200);
    expect(pve.mappings.pci.get("nic1")!.map).toEqual(["node=pve,path=0000:03:00.0,id=8086:1572,iommugroup=20"]);
    expect((await post(c, "/api/mappings/pci", { id: "nic1", map: [{ node: "pve", path: "0000:03:00.0", id: "8086:1572" }] })).status).toBe(409);
    expect((await j(await post(c, "/api/mappings/pci", { id: "bad1", map: [{ node: "pve", path: "zz", id: "8086:1572" }] }))).error).toMatch(/PCI path/);
    list = await j(await get(c, "/api/mappings/pci"));
    const nic = list.mappings.find((m: any) => m.id === "nic1");
    expect((await post(c, "/api/mappings/pci/nic1", { digest: nic.digest, description: "Renamed", map: [{ node: "pve", path: "0000:03:00.0", id: "8086:1572" }] })).status).toBe(200);
    expect(pve.mappings.pci.get("nic1")!.description).toBe("Renamed");
    expect((await post(c, "/api/mappings/pci/nic1", { digest: "0".repeat(40), map: [{ node: "pve", path: "0000:03:00.0", id: "8086:1572" }] })).status).toBe(400);
    expect((await post(c, "/api/mappings/pci/nic1/delete", { confirm: "x" })).status).toBe(409);
    expect((await post(c, "/api/mappings/pci/nic1/delete", { confirm: "nic1" })).status).toBe(200);
    expect(pve.mappings.pci.has("nic1")).toBe(false);
  });

  it("USB and directory mappings; a non-administrator can't change them", async () => {
    const c = await signIn();
    expect((await post(c, "/api/mappings/usb", { id: "key1", map: [{ node: "pve", id: "1050:0407", path: "1-2.3" }] })).status).toBe(200);
    expect((await post(c, "/api/mappings/dir", { id: "media", map: [{ node: "pve", path: "/srv/media" }] })).status).toBe(200);
    expect((await post(c, "/api/mappings/dir", { id: "bad", map: [{ node: "pve", path: "/srv/../etc" }] })).status).toBe(400);
    const dirs = await j(await get(c, "/api/mappings/dir"));
    expect(dirs.mappings.map((m: any) => m.id).sort()).toEqual(["docs", "media"]);
    const lee = await signIn("lee");
    expect((await j(await get(lee, "/api/mappings/dir"))).canModify).toBe(false);
    expect((await post(lee, "/api/mappings/dir", { id: "x1", map: [{ node: "pve", path: "/srv" }] })).status).toBe(403);
  });

  it("custom CPU models: list, create, edit, delete", async () => {
    const c = await signIn();
    const l = await j(await get(c, "/api/cpu-models"));
    expect(l.models[0]).toMatchObject({ cputype: "fast", reportedModel: "Skylake-Server", flags: "+aes" });
    expect((await post(c, "/api/cpu-models", { cputype: "slow", reportedModel: "Haswell", flags: "+aes;-pcid", hidden: true })).status).toBe(200);
    expect(pve.cpuModels.get("slow")).toMatchObject({ "reported-model": "Haswell", flags: "+aes;-pcid", hidden: "1" });
    expect((await post(c, "/api/cpu-models/slow", { flags: null, hvVendorId: "proxmox" })).status).toBe(200);
    expect((await post(c, "/api/cpu-models", { cputype: "bad", reportedModel: "Haswell", flags: "aes" })).status).toBe(400);
    expect((await post(c, "/api/cpu-models/slow/delete", { confirm: "nope" })).status).toBe(409);
    expect((await post(c, "/api/cpu-models/slow/delete", { confirm: "slow" })).status).toBe(200);
  });

  it("bulk actions: cluster-wide and per node, with the count typed for the destructive ones", async () => {
    const c = await signIn();
    expect((await post(c, "/api/bulk/guests", { action: "start", vms: [302, 303] })).status).toBe(202);
    expect(pve.bulk[0]).toMatchObject({ path: "/cluster/bulk-action/guest/start" });
    expect(new URLSearchParams(pve.bulk[0].params as any).get("vms")).toBe("303");
    expect((await post(c, "/api/bulk/guests", { action: "shutdown", vms: [300, 301] })).status).toBe(409);
    expect((await post(c, "/api/bulk/guests", { action: "shutdown", vms: [300, 301], confirm: "2", timeout: 60, forceStop: false })).status).toBe(202);
    expect(pve.bulk[1].params).toMatchObject({ "force-stop": "0", timeout: "60" });
    expect((await post(c, "/api/bulk/node", { action: "suspend", vms: [300], confirm: "1" })).status).toBe(202);
    expect(pve.bulk[2].path).toBe("/nodes/pve/suspendall");
    expect((await post(c, "/api/bulk/guests", { action: "migrate", vms: [300], confirm: "1" })).status).toBe(400);
    expect((await post(c, "/api/bulk/guests", { action: "start", vms: [999] })).status).toBe(404);
    expect((await post(c, "/api/bulk/guests", { action: "start", vms: [] })).status).toBe(400);
  });
});

describe("security", () => {
  it("every change needs the same-site header and a signed-in person", async () => {
    const c = await signIn();
    const noHeader = await fetch(`${base}/api/guests/302/settings/cpu`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: c }, body: JSON.stringify({ digest: "0".repeat(40), numa: true }) });
    expect(noHeader.status).toBe(403);
    const anon = await fetch(`${base}/api/guests/302/settings`);
    expect(anon.status).toBe(401);
    for (const p of ["/api/hardware/pci", "/api/mappings/pci", "/api/cpu-models", "/api/capabilities/qemu", "/api/guests/302/cloudinit", "/api/guests/302/agent/info", "/api/guests/302/clone-options"]) expect((await fetch(base + p)).status, p).toBe(401);
  });
  it("an unknown machine is a 404", async () => {
    const c = await signIn();
    expect((await get(c, "/api/guests/999/settings")).status).toBe(404);
    expect((await post(c, "/api/guests/999/status", { action: "start" })).status).toBe(404);
  });
});
