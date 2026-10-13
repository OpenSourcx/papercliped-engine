import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { ctDns, ctFeatures, ctNic, ctNicString, display, efiValue, featuresString, readNic, readPassthrough, resources, tags, vmNic, vmNicString } from "../src/features/guestCheck.ts";
import { fakePve } from "./fakes.ts";
import { fakeGuest } from "./fakes-guest.ts";

let server: Server;
let base: string;
let pve: ReturnType<typeof fakeGuest>;

beforeEach(async () => {
  pve = fakeGuest(fakePve().transport);
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
async function signIn(username = "sam") {
  const r = await send("POST", "/api/login", { username, password: "right", realm: "pve" });
  return r.headers.get("set-cookie")!.split(";")[0];
}
const get = async (c: string, vmid: number, what: string) => fetch(`${base}/api/guests/${vmid}/${what}`, { headers: { Cookie: c } });
const devices = async (c: string, vmid: number) => j(await get(c, vmid, "devices"));
const post = (c: string, vmid: number, what: string, body: unknown) => send("POST", `/api/guests/${vmid}/${what}`, body, { Cookie: c });
const lastPut = (vmid: number) => [...pve.calls].reverse().find((x) => x.method === "PUT" && x.path.endsWith(`/${vmid}/config`))!;
const puts = () => pve.calls.filter((x) => x.method === "PUT").length;

describe("addresses and hostname", () => {
  it("reads a running VM's addresses and hostname through the guest agent", async () => {
    const c = await signIn();
    const a = await j(await get(c, 300, "addresses"));
    expect(a.source).toBe("running");
    expect(a.hostname).toBe("app.lan");
    const nic = a.interfaces.find((i: any) => i.name === "ens18");
    expect(nic).toMatchObject({ mac: "bc:24:11:aa:bb:01" });
    expect(nic.addresses).toEqual([{ ip: "192.168.1.60", prefix: 24, family: "ipv4" }, { ip: "fd00::60", prefix: 64, family: "ipv6" }]);
  });

  it("reads a running container's interfaces and uses its configured hostname", async () => {
    const c = await signIn();
    const a = await j(await get(c, 301, "addresses"));
    expect(a.hostname).toBe("ct-web");
    expect(a.interfaces.find((i: any) => i.name === "eth0").addresses.map((x: any) => x.ip)).toEqual(["192.168.1.51", "fe80::be24:11ff:fe00:1"]);
  });

  it("falls back to the configuration for a stopped container, and says so", async () => {
    const c = await signIn();
    const a = await j(await get(c, 303, "addresses"));
    expect(a).toMatchObject({ source: "config", hostname: "ct-idle" });
    expect(a.interfaces[0].addresses.map((x: any) => x.ip)).toEqual(["192.168.1.9", "fd00::9"]);
    expect(a.note).toMatch(/Stopped/);
  });

  it("tells a stopped VM to start, and a VM without the agent how to get addresses, without showing Proxmox's error text", async () => {
    const c = await signIn();
    expect((await j(await get(c, 302, "addresses"))).note).toMatch(/Start the machine/);
    pve.guests.get(300)!.cfg.agent = "0";
    expect((await j(await get(c, 300, "addresses"))).note).toMatch(/guest agent/);
    pve.guests.get(300)!.cfg.agent = "enabled=1";
    pve.agent.up = false;
    const down = await j(await get(c, 300, "addresses"));
    expect(down.source).toBe("none");
    expect(down.note).toMatch(/qemu-guest-agent/);
    expect(JSON.stringify(down)).not.toMatch(/failed \(|\/nodes\//);
  });
});

describe("reading the machine page's devices", () => {
  it("describes a VM", async () => {
    const c = await signIn();
    const d = await devices(c, 300);
    expect(d.digest).toBe(pve.digestOf(300));
    expect(d.nics[0]).toMatchObject({ key: "net0", model: "virtio", mac: "BC:24:11:AA:BB:01", bridge: "vmbr0", tag: 20, firewall: true });
    expect(d.nics[1]).toMatchObject({ model: "e1000", bridge: "vmbr1", firewall: false });
    expect(d.bridges).toEqual(["acme", "vmbr0", "vmbr1"]);
    expect(d.resources).toMatchObject({ cores: 2, sockets: 1, memory: 4096, balloon: 2048, swap: null });
    expect(d.tags).toEqual(["web", "prod"]);
    expect(d.notes).toBe("The app server.");
    expect(d.vm).toMatchObject({ bios: "seabios", display: { type: "std", memory: null }, efi: null, tpm: null, serial: [{ key: "serial0", value: "socket" }] });
    expect(d.passthrough).toEqual([
      { key: "hostpci0", kind: "pci", target: "0000:01:00.0", mapped: false, options: ["PCI Express", "Primary GPU"], raw: "0000:01:00.0,pcie=1,x-vga=1" },
      { key: "usb0", kind: "usb", target: "1234:5678", mapped: false, options: [], raw: "host=1234:5678" },
    ]);
    expect(d.dns).toBeNull();
  });

  it("describes a container, with its DNS, features and passed-through device", async () => {
    const c = await signIn();
    const d = await devices(c, 301);
    expect(d.dns).toEqual({ nameserver: ["1.1.1.1", "9.9.9.9"], searchdomain: ["lan"], fromHost: false });
    expect(d.features).toMatchObject({ nesting: true, keyctl: true, fuse: false, mount: [] });
    expect(d.unprivileged).toBe(true);
    expect(d.nics[1]).toMatchObject({ name: "eth1", ip: "10.0.5.20/24", gw: "10.0.5.1" });
    expect(d.passthrough[0]).toMatchObject({ kind: "dev", target: "/dev/dri/card0", options: ["Mode 0660", "gid 44"] });
    expect(d.vm).toBeNull();
  });

  it("marks changes waiting for a restart", async () => {
    const c = await signIn();
    pve.guests.get(300)!.pending.net0 = "virtio=BC:24:11:AA:BB:01,bridge=vmbr1";
    const d = await devices(c, 300);
    expect(d.pendingKeys).toEqual(["net0"]);
    expect(d.nics[0].pending).toBe(true);
  });

  it("answers 404 for a machine that does not exist and needs sign-in", async () => {
    const c = await signIn();
    expect((await get(c, 999, "devices")).status).toBe(404);
    expect((await fetch(`${base}/api/guests/300/devices`)).status).toBe(401);
  });
});

describe("VM network devices (GU-038)", () => {
  it("adds a device with model, bridge, VLAN, MAC, firewall, rate limit, MTU and queues on the next free slot", async () => {
    const c = await signIn();
    const dg = (await devices(c, 300)).digest;
    const r = await post(c, 300, "network", { digest: dg, model: "virtio", bridge: "vmbr1", tag: 30, trunks: "10;20-25", mac: "02:00:00:aa:bb:cc", firewall: true, rate: 12.5, mtu: 1400, queues: 4, linkDown: true });
    expect(await j(r)).toMatchObject({ key: "net2", ok: true, pending: true });
    const put = lastPut(300);
    expect(put.params.digest).toBe(dg);
    expect(put.params.net2).toBe("virtio=02:00:00:AA:BB:CC,bridge=vmbr1,firewall=1,link_down=1,tag=30,trunks=10;20-25,rate=12.5,mtu=1400,queues=4");
  });

  it("adds a device with Proxmox picking the MAC when none is given", async () => {
    const c = await signIn();
    await post(c, 300, "network", { digest: (await devices(c, 300)).digest, bridge: "acme", model: "e1000e" });
    expect(lastPut(300).params.net2).toBe("e1000e,bridge=acme");
  });

  it("edits a device and keeps its MAC and the settings the form doesn't manage", async () => {
    const c = await signIn();
    const r = await post(c, 300, "network", { digest: (await devices(c, 300)).digest, key: "net1", model: "e1000", bridge: "vmbr0", firewall: true });
    expect((await j(r)).key).toBe("net1");
    expect(lastPut(300).params.net1).toBe("e1000=BC:24:11:AA:BB:02,bridge=vmbr0,host-tunnel=0,firewall=1");
  });

  it("changing the model keeps the MAC address", async () => {
    const c = await signIn();
    await post(c, 300, "network", { digest: (await devices(c, 300)).digest, key: "net0", model: "vmxnet3", bridge: "vmbr0", firewall: true, tag: 20 });
    expect(lastPut(300).params.net0).toMatch(/^vmxnet3=BC:24:11:AA:BB:01,/);
  });

  it("refuses what Proxmox would refuse, before asking it", async () => {
    const c = await signIn();
    const dg = (await devices(c, 300)).digest;
    const before = puts();
    for (const [body, msg] of [
      [{ bridge: "vmbr0", model: "e1000", mtu: 1400 }, /VirtIO/],
      [{ bridge: "vmbr0", mac: "BC:24:11" }, /MAC address looks like/],
      [{ bridge: "vmbr0", mac: "01:00:5e:00:00:01" }, /group address/],
      [{ bridge: "vmbr0", tag: 5000 }, /1 to 4094/],
      [{ bridge: "vmbr0", tag: "x" }, /1 to 4094/],
      [{ bridge: "vmbr0", trunks: "10;abc" }, /isn't a VLAN id/],
      [{ bridge: "vmbr0", trunks: "30-20" }, /1 to 4094/],
      [{ bridge: "vmbr0", rate: -3 }, /positive number/],
      [{ bridge: "vmbr0", model: "warp" }, /Unknown network card model/],
      [{ bridge: "bad bridge!" }, /Pick a bridge/],
      [{ bridge: "vmbr0", firewall: "yes" }, /on or off/],
      [{ bridge: "vmbr0", model: "virtio", mtu: 70000 }, /1 to 65520|from 1 to 65520/],
      [{ bridge: "vmbr0", key: "net99" }, /Unknown network device/],
    ] as [Record<string, unknown>, RegExp][]) {
      const r = await post(c, 300, "network", { digest: dg, ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await j(r)).error).toMatch(msg);
    }
    expect(puts()).toBe(before);
  });

  it("refuses a stale page, a missing digest and a busy machine", async () => {
    const c = await signIn();
    const dg = (await devices(c, 300)).digest;
    pve.guests.get(300)!.cfg.cores = 8; // someone else changed it
    const stale = await post(c, 300, "network", { digest: dg, bridge: "vmbr0" });
    expect(stale.status).toBe(409);
    expect((await j(stale)).code).toBe("stale");
    expect((await post(c, 300, "network", { bridge: "vmbr0" })).status).toBe(400);
    pve.guests.get(300)!.lock = "backup";
    const busy = await post(c, 300, "network", { digest: pve.digestOf(300), bridge: "vmbr0" });
    expect(busy.status).toBe(409);
    expect((await j(busy)).error).toMatch(/busy \(backup\)/);
  });

  it("removes a device only after its name is typed", async () => {
    const c = await signIn();
    const dg = (await devices(c, 300)).digest;
    const no = await post(c, 300, "network/net1/delete", { digest: dg, confirm: "net0" });
    expect(no.status).toBe(409);
    expect(puts()).toBe(0);
    const yes = await post(c, 300, "network/net1/delete", { digest: dg, confirm: "net1" });
    expect(yes.status).toBe(200);
    expect(lastPut(300).params.delete).toBe("net1");
    expect(pve.guests.get(300)!.cfg.net1).toBeUndefined();
    expect((await post(c, 300, "network/net7/delete", { digest: pve.digestOf(300), confirm: "net7" })).status).toBe(404);
  });

  it("refuses changes from someone who may not make them, and cross-site requests", async () => {
    const lee = await signIn("lee");
    const r = await post(lee, 300, "network", { digest: pve.digestOf(300), bridge: "vmbr0" });
    expect(r.status).toBe(403);
    expect((await j(r)).error).toMatch(/permission/);
    const c = await signIn();
    const before = puts();
    const cross = await fetch(`${base}/api/guests/300/network`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: c }, body: JSON.stringify({ digest: pve.digestOf(300), bridge: "vmbr0" }) });
    expect(cross.status).toBeGreaterThanOrEqual(400);
    expect(puts()).toBe(before);
  });
});

describe("container network (GU-056)", () => {
  it("adds a device with DHCP and IPv6 settings", async () => {
    const c = await signIn();
    const r = await post(c, 301, "network", { digest: (await devices(c, 301)).digest, name: "eth2", bridge: "vmbr0", ip: "dhcp", ip6: "auto", tag: 7, firewall: true, rate: 5, mtu: 1500, mac: "02:11:22:33:44:55" });
    expect((await j(r)).key).toBe("net2");
    expect(lastPut(301).params.net2).toBe("name=eth2,bridge=vmbr0,hwaddr=02:11:22:33:44:55,firewall=1,tag=7,rate=5,mtu=1500,ip=dhcp,ip6=auto,type=veth");
  });

  it("sets a static address and gateway for both families, keeping the MAC when editing", async () => {
    const c = await signIn();
    await post(c, 301, "network", { digest: (await devices(c, 301)).digest, key: "net0", name: "eth0", bridge: "vmbr0", ip: "192.168.1.50/24", gw: "192.168.1.1", ip6: "fd00::50/64", gw6: "fd00::1" });
    expect(lastPut(301).params.net0).toBe("name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=192.168.1.50/24,type=veth,gw=192.168.1.1,ip6=fd00::50/64,gw6=fd00::1");
  });

  it("removes the gateway when the address goes back to DHCP", async () => {
    const c = await signIn();
    await post(c, 301, "network", { digest: (await devices(c, 301)).digest, key: "net1", name: "eth1", bridge: "vmbr1", ip: "dhcp" });
    expect(lastPut(301).params.net1).toBe("name=eth1,bridge=vmbr1,hwaddr=BC:24:11:00:00:02,ip=dhcp,type=veth");
  });

  it("refuses bad names, addresses and gateways", async () => {
    const c = await signIn();
    const dg = (await devices(c, 301)).digest;
    for (const [body, msg] of [
      [{ name: "1eth", bridge: "vmbr0" }, /device name/],
      [{ name: "eth1", bridge: "vmbr0", ip: "dhcp" }, /already called eth1/],
      [{ name: "eth3", bridge: "vmbr0", ip: "10.0.0.5" }, /DHCP, none, or an address/],
      [{ name: "eth3", bridge: "vmbr0", ip: "10.0.0.5/33" }, /DHCP, none, or an address/],
      [{ name: "eth3", bridge: "vmbr0", ip: "dhcp", gw: "10.0.0.1" }, /static address/],
      [{ name: "eth3", bridge: "vmbr0", ip: "10.0.0.5/24", gw: "999.1.1.1" }, /IPv4 address/],
      [{ name: "eth3", bridge: "vmbr0", ip6: "fd00::5" }, /IPv6 address like/],
      [{ name: "eth3", bridge: "vmbr0", ip6: "dhcp", gw6: "fd00::1" }, /static IPv6/],
      [{ name: "eth3", bridge: "vmbr0", mtu: 10 }, /64 to 65535/],
      [{ name: "eth3", bridge: "vmbr0", trunks: "10-20" }, /isn't a VLAN id/],
    ] as [Record<string, unknown>, RegExp][]) {
      const r = await post(c, 301, "network", { digest: dg, ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await j(r)).error).toMatch(msg);
    }
  });
});

describe("container DNS (GU-057)", () => {
  it("sets name servers and search domains", async () => {
    const c = await signIn();
    const r = await post(c, 301, "dns", { digest: (await devices(c, 301)).digest, nameserver: ["10.0.0.2", "fd00::2"], searchdomain: ["corp.example", "lan"] });
    expect(r.status).toBe(200);
    expect(lastPut(301).params).toMatchObject({ nameserver: "10.0.0.2 fd00::2", searchdomain: "corp.example lan" });
    expect(lastPut(301).params.delete).toBeUndefined();
  });

  it("accepts a typed list and a link-local server", async () => {
    const c = await signIn();
    await post(c, 301, "dns", { digest: (await devices(c, 301)).digest, nameserver: "1.1.1.1, fe80::1%eth0", searchdomain: "" });
    expect(lastPut(301).params).toMatchObject({ nameserver: "1.1.1.1 fe80::1%eth0", delete: "searchdomain" });
  });

  it("empty means use the host's settings, which Proxmox wants as a delete", async () => {
    const c = await signIn();
    await post(c, 301, "dns", { digest: (await devices(c, 301)).digest, nameserver: [], searchdomain: [] });
    expect(lastPut(301).params.delete).toBe("nameserver,searchdomain");
    expect((await devices(c, 301)).dns.fromHost).toBe(true);
  });

  it("refuses what is not an address or domain, too many, and VMs", async () => {
    const c = await signIn();
    const dg = (await devices(c, 301)).digest;
    for (const [body, msg] of [
      [{ nameserver: ["not-an-ip"] }, /isn't an IP address/],
      [{ nameserver: ["1.1.1.1", "1.1.1.1"] }, /once/],
      [{ nameserver: ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"] }, /up to 3/],
      [{ searchdomain: ["bad domain"] }, /isn't a domain/],
      [{ searchdomain: ["-bad.example"] }, /isn't a domain/],
      [{ searchdomain: ["a", "b", "c", "d", "e", "f", "g"] }, /up to 6/],
    ] as [Record<string, unknown>, RegExp][]) {
      const r = await post(c, 301, "dns", { digest: dg, ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await j(r)).error).toMatch(msg);
    }
    const vm = await post(c, 300, "dns", { digest: pve.digestOf(300), nameserver: ["1.1.1.1"] });
    expect(vm.status).toBe(400);
  });
});

describe("container features (GU-058)", () => {
  it("turns features on and off and sets mount types, keeping the ones it doesn't manage", async () => {
    const c = await signIn();
    pve.guests.get(301)!.cfg.features = "nesting=1,keyctl=1,future_flag=1";
    await post(c, 301, "features", { digest: (await devices(c, 301)).digest, nesting: true, keyctl: false, fuse: true, mknod: true, forceRwSys: true, mount: ["nfs", "cifs"] });
    expect(lastPut(301).params.features).toBe("nesting=1,future_flag=1,fuse=1,mknod=1,force_rw_sys=1,mount=nfs;cifs");
    expect((await devices(c, 301)).features).toMatchObject({ nesting: true, keyctl: false, fuse: true, mknod: true, forceRwSys: true, mount: ["nfs", "cifs"] });
  });

  it("deletes the setting when nothing is left on", async () => {
    const c = await signIn();
    await post(c, 301, "features", { digest: (await devices(c, 301)).digest, nesting: false, keyctl: false });
    expect(lastPut(301).params.delete).toBe("features");
  });

  it("refuses bad mount types and VMs", async () => {
    const c = await signIn();
    const dg = (await devices(c, 301)).digest;
    expect((await post(c, 301, "features", { digest: dg, mount: ["nfs;rm -rf"] })).status).toBe(400);
    expect((await post(c, 301, "features", { digest: dg, nesting: "yes" })).status).toBe(400);
    expect((await post(c, 301, "features", { digest: dg, mount: ["nfs", "nfs"] })).status).toBe(400);
    expect((await post(c, 300, "features", { digest: pve.digestOf(300), nesting: true })).status).toBe(400);
  });
});

describe("resources", () => {
  it("sets a container's memory (any amount), swap, cores, CPU limit and weight", async () => {
    const c = await signIn();
    await post(c, 301, "resources", { digest: (await devices(c, 301)).digest, memory: 3000, swap: 0, cores: 6, cpulimit: 2.5, cpuunits: 2048 });
    expect(lastPut(301).params).toMatchObject({ memory: "3000", swap: "0", cores: "6", cpulimit: "2.5", cpuunits: "2048" });
  });

  it("clears a limit with null", async () => {
    const c = await signIn();
    await post(c, 301, "resources", { digest: (await devices(c, 301)).digest, cpulimit: null, cpuunits: null });
    expect(lastPut(301).params.delete).toBe("cpulimit,cpuunits");
  });

  it("sets a VM's memory, minimum memory, sockets and cores", async () => {
    const c = await signIn();
    await post(c, 300, "resources", { digest: (await devices(c, 300)).digest, memory: 6144, balloon: 1024, sockets: 2, cores: 4 });
    expect(lastPut(300).params).toMatchObject({ memory: "6144", balloon: "1024", sockets: "2", cores: "4" });
  });

  it("refuses values outside Proxmox's limits", async () => {
    const c = await signIn();
    const dg = (await devices(c, 300)).digest;
    const ct = (await devices(c, 301)).digest;
    for (const [id, d, body, msg] of [
      [300, dg, { memory: 8 }, /Memory/],
      [300, dg, { memory: 4096.5 }, /Memory/],
      [300, dg, { cores: 0 }, /Cores/],
      [300, dg, { sockets: 99 }, /Sockets/],
      [300, dg, { swap: 10 }, /Only containers/],
      [300, dg, { balloon: 9000 }, /can't be more than/],
      [300, dg, { cpulimit: 500 }, /CPU limit/],
      [301, ct, { sockets: 2 }, /don't have sockets/],
      [301, ct, { balloon: 1 }, /Only VMs/],
      [301, ct, { cpuunits: 900000 }, /CPU weight/],
      [301, ct, { memory: "3 GiB" }, /Memory/],
      [301, ct, {}, /Nothing to change/],
    ] as [number, string, Record<string, unknown>, RegExp][]) {
      const r = await post(c, id, "resources", { digest: d, ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await j(r)).error).toMatch(msg);
    }
  });
});

describe("notes and tags", () => {
  it("saves both, lowercases and de-duplicates tags", async () => {
    const c = await signIn();
    await post(c, 300, "notes", { digest: (await devices(c, 300)).digest, description: "Runs the shop.\nSecond line.", tags: ["Shop", "prod", "shop"] });
    expect(lastPut(300).params).toMatchObject({ description: "Runs the shop.\nSecond line.", tags: "shop;prod" });
    const d = await devices(c, 300);
    expect(d.tags).toEqual(["shop", "prod"]);
    expect(d.notes).toBe("Runs the shop.\nSecond line.");
  });

  it("clearing deletes the settings", async () => {
    const c = await signIn();
    await post(c, 300, "notes", { digest: (await devices(c, 300)).digest, description: "  ", tags: "" });
    expect(lastPut(300).params.delete).toBe("description,tags");
  });

  it("refuses bad tags, too many tags and long notes", async () => {
    const c = await signIn();
    const dg = (await devices(c, 300)).digest;
    expect((await post(c, 300, "notes", { digest: dg, tags: ["bad tag!"] })).status).toBe(400);
    expect((await post(c, 300, "notes", { digest: dg, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).status).toBe(400);
    expect((await post(c, 300, "notes", { digest: dg, description: "x".repeat(8193) })).status).toBe(400);
    expect((await post(c, 300, "notes", { digest: dg, description: 5 })).status).toBe(400);
    expect((await post(c, 300, "notes", { digest: dg })).status).toBe(400);
  });
});

describe("display, BIOS, serial, audio, EFI and TPM", () => {
  it("sets and resets the display", async () => {
    const c = await signIn();
    await post(c, 300, "items/display", { digest: (await devices(c, 300)).digest, action: "set", type: "virtio", memory: 64, clipboard: "vnc" });
    expect(lastPut(300).params.vga).toBe("type=virtio,memory=64,clipboard=vnc");
    expect((await devices(c, 300)).vm.display).toEqual({ type: "virtio", memory: 64, clipboard: "vnc" });
    await post(c, 300, "items/display", { digest: pve.digestOf(300), action: "remove" });
    expect(lastPut(300).params.delete).toBe("vga");
    const bad = await post(c, 300, "items/display", { digest: pve.digestOf(300), action: "set", type: "serial0", memory: 64 });
    expect(bad.status).toBe(400);
    expect((await post(c, 300, "items/display", { digest: pve.digestOf(300), action: "set", type: "std", memory: 1 })).status).toBe(400);
  });

  it("changes the BIOS and warns when UEFI has no EFI disk", async () => {
    const c = await signIn();
    const r = await j(await post(c, 300, "items/bios", { digest: (await devices(c, 300)).digest, action: "set", bios: "ovmf" }));
    expect(r.warning).toMatch(/EFI disk/);
    expect(lastPut(300).params.bios).toBe("ovmf");
    expect((await post(c, 300, "items/bios", { digest: pve.digestOf(300), action: "set", bios: "coreboot" })).status).toBe(400);
  });

  it("adds a serial port on the next free slot and removes one", async () => {
    const c = await signIn();
    const r = await j(await post(c, 300, "items/serial", { digest: (await devices(c, 300)).digest, action: "add" }));
    expect(r.key).toBe("serial1");
    expect(lastPut(300).params.serial1).toBe("socket");
    await post(c, 300, "items/serial", { digest: pve.digestOf(300), action: "remove", key: "serial0" });
    expect(lastPut(300).params.delete).toBe("serial0");
    expect((await post(c, 300, "items/serial", { digest: pve.digestOf(300), action: "remove", key: "serial3" })).status).toBe(400);
  });

  it("hands a host serial port only to administrators", async () => {
    const c = await signIn();
    const ok = await post(c, 300, "items/serial", { digest: (await devices(c, 300)).digest, action: "add", device: "/dev/ttyUSB0" });
    expect(ok.status).toBe(200);
    expect((await post(c, 300, "items/serial", { digest: pve.digestOf(300), action: "add", device: "/dev/sda" })).status).toBe(400);
  });

  it("sets and removes an audio device", async () => {
    const c = await signIn();
    await post(c, 300, "items/audio", { digest: (await devices(c, 300)).digest, action: "set", device: "ich9-intel-hda", driver: "spice" });
    expect(lastPut(300).params.audio0).toBe("device=ich9-intel-hda,driver=spice");
    expect((await devices(c, 300)).vm.audio).toEqual({ device: "ich9-intel-hda", driver: "spice" });
    await post(c, 300, "items/audio", { digest: pve.digestOf(300), action: "remove" });
    expect(lastPut(300).params.delete).toBe("audio0");
    expect((await post(c, 300, "items/audio", { digest: pve.digestOf(300), action: "set", device: "sb16" })).status).toBe(400);
  });

  it("adds an EFI disk and switches to UEFI, then removes it only after typing efidisk0", async () => {
    const c = await signIn();
    const add = await post(c, 300, "items/efi", { digest: (await devices(c, 300)).digest, action: "add", storage: "local-lvm", efitype: "4m", preEnrolledKeys: true });
    expect(add.status).toBe(200);
    expect(lastPut(300).params).toMatchObject({ efidisk0: "local-lvm:1,efitype=4m,pre-enrolled-keys=1", bios: "ovmf" });
    expect((await devices(c, 300)).vm.efi).toMatchObject({ efitype: "4m", preEnrolledKeys: true });
    expect((await post(c, 300, "items/efi", { digest: pve.digestOf(300), action: "add", storage: "local-lvm" })).status).toBe(400);
    const dg = pve.digestOf(300);
    expect((await post(c, 300, "items/efi", { digest: dg, action: "remove", confirm: "yes" })).status).toBe(409);
    expect((await post(c, 300, "items/efi", { digest: dg, action: "remove", confirm: "efidisk0" })).status).toBe(200);
    expect(lastPut(300).params.delete).toBe("efidisk0");
  });

  it("refuses 2m with pre-enrolled keys and bad storage names", async () => {
    const c = await signIn();
    const dg = (await devices(c, 302)).digest;
    expect((await post(c, 302, "items/efi", { digest: dg, action: "add", storage: "local-lvm", efitype: "2m", preEnrolledKeys: true })).status).toBe(400);
    expect((await post(c, 302, "items/efi", { digest: dg, action: "add", storage: "../etc" })).status).toBe(400);
  });

  it("adds a TPM and removes it only after typing tpmstate0", async () => {
    const c = await signIn();
    expect((await post(c, 302, "items/tpm", { digest: (await devices(c, 302)).digest, action: "add", storage: "local-lvm" })).status).toBe(200);
    expect(lastPut(302).params.tpmstate0).toBe("local-lvm:1,version=v2.0");
    expect((await devices(c, 302)).vm.tpm).toMatchObject({ version: "v2.0" });
    const dg = pve.digestOf(302);
    expect((await post(c, 302, "items/tpm", { digest: dg, action: "remove" })).status).toBe(409);
    expect((await post(c, 302, "items/tpm", { digest: dg, action: "remove", confirm: "tpmstate0" })).status).toBe(200);
    expect((await post(c, 302, "items/tpm", { digest: pve.digestOf(302), action: "add", storage: "x", version: "v3" })).status).toBe(400);
  });

  it("is for VMs only", async () => {
    const c = await signIn();
    expect((await post(c, 301, "items/audio", { digest: pve.digestOf(301), action: "remove" })).status).toBe(400);
  });
});

describe("host devices handed to a machine", () => {
  it("lists host PCI and USB devices and mappings, leaving out USB hubs", async () => {
    const c = await signIn();
    const p = await j(await get(c, 300, "passthrough"));
    expect(p.pci[0]).toMatchObject({ id: "0000:01:00.0", vendor: "NVIDIA Corporation", iommuGroup: 14 });
    expect(p.usb).toEqual([{ id: "1234:5678", port: "1-2", name: "Security key", speed: "480" }]);
    expect(p.mappings.pci).toEqual([{ id: "gpu0", description: "Render GPU", entries: 1 }]);
  });

  it("says why when the account can't list host devices instead of failing", async () => {
    const lee = await signIn("lee");
    const p = await j(await get(lee, 300, "passthrough"));
    expect(p.pci).toEqual([]);
    expect(p.notes.pci).toMatch(/Sys.Audit/);
  });

  it("reads mapped devices", () => {
    expect(readPassthrough("qemu", { hostpci1: "mapping=gpu0,pcie=1", usb1: "mapping=dongle,usb3=1" })).toEqual([
      { key: "hostpci1", kind: "pci", target: "gpu0", mapped: true, options: ["PCI Express"], raw: "mapping=gpu0,pcie=1" },
      { key: "usb1", kind: "usb", target: "dongle", mapped: true, options: ["USB 3"], raw: "mapping=dongle,usb3=1" },
    ]);
  });
});

describe("who may use a machine", () => {
  it("shows what is set on the machine and what reaches it from above", async () => {
    const c = await signIn();
    const p = await j(await get(c, 300, "permissions"));
    expect(p.path).toBe("/vms/300");
    expect(p.canModify).toBe(true);
    expect(p.entries).toEqual([{ path: "/vms/300", type: "user", id: "lee@pve", role: "PVEVMUser", propagate: true }]);
    expect(p.inherited.map((e: any) => [e.path, e.id, e.role])).toEqual([["/", "sam@pve", "Administrator"], ["/vms", "ops", "PVEVMUser"], ["/pool/co-acme", "lee@pve", "PVEAuditor"]]);
    expect(p.roles).toContain("PVEVMAdmin");
    expect(p.groups).toEqual(["ops"]);
  });

  it("someone without Permissions.Modify sees that and can't change anything", async () => {
    const lee = await signIn("lee");
    expect((await j(await get(lee, 300, "permissions"))).canModify).toBe(false);
    const r = await post(lee, 300, "permissions", { action: "grant", type: "user", id: "lee@pve", role: "Administrator" });
    expect(r.status).toBe(403);
  });

  it("grants a role to a user and a group on this machine only", async () => {
    const c = await signIn();
    const r = await j(await post(c, 300, "permissions", { action: "grant", type: "group", id: "ops", role: "PVEVMAdmin", propagate: false }));
    expect(pve.calls.filter((x) => x.method === "PUT" && x.path === "/access/acl").at(-1)!.params).toMatchObject({ path: "/vms/300", roles: "PVEVMAdmin", groups: "ops", propagate: "0" });
    expect(r.entries.map((e: any) => [e.type, e.id, e.role, e.propagate])).toContainEqual(["group", "ops", "PVEVMAdmin", false]);
    await post(c, 300, "permissions", { action: "grant", type: "user", id: "sam@pve", role: "PVEAuditor" });
    expect(pve.acl.some((a) => a.path === "/vms/300" && a.ugid === "sam@pve")).toBe(true);
  });

  it("refuses unknown roles, groups and users, and malformed ids", async () => {
    const c = await signIn();
    for (const [body, msg] of [
      [{ action: "grant", type: "user", id: "lee@pve", role: "Overlord" }, /no role called/],
      [{ action: "grant", type: "group", id: "ghosts", role: "PVEAuditor" }, /no group called/],
      [{ action: "grant", type: "user", id: "nobody@pve", role: "PVEAuditor" }, /no user called/],
      [{ action: "grant", type: "user", id: "lee", role: "PVEAuditor" }, /name@pam/],
      [{ action: "grant", type: "user", id: "lee@pve", role: "bad role" }, /Pick a role/],
      [{ action: "grant", type: "token", id: "lee@pve", role: "PVEAuditor" }, /API token/],
      [{ action: "wipe", type: "user", id: "lee@pve", role: "PVEAuditor" }, /grant or revoke/],
    ] as [Record<string, unknown>, RegExp][]) {
      const r = await post(c, 300, "permissions", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await j(r)).error).toMatch(msg);
    }
  });

  it("revokes only after the name is typed", async () => {
    const c = await signIn();
    const no = await post(c, 300, "permissions", { action: "revoke", type: "user", id: "lee@pve", role: "PVEVMUser", confirm: "lee" });
    expect(no.status).toBe(409);
    expect(pve.acl.some((a) => a.path === "/vms/300")).toBe(true);
    const yes = await j(await post(c, 300, "permissions", { action: "revoke", type: "user", id: "lee@pve", role: "PVEVMUser", confirm: "lee@pve" }));
    expect(yes.entries).toEqual([]);
    expect(pve.calls.filter((x) => x.method === "PUT" && x.path === "/access/acl").at(-1)!.params.delete).toBe("1");
  });
});

describe("the checks on their own", () => {
  it("builds the strings Proxmox expects", () => {
    expect(vmNicString(vmNic({ bridge: "vmbr0", firewall: true }))).toBe("virtio,bridge=vmbr0,firewall=1");
    expect(ctNicString(ctNic({ name: "eth0", bridge: "vmbr0", ip: "dhcp" }))).toBe("name=eth0,bridge=vmbr0,ip=dhcp,type=veth");
    expect(readNic("lxc", "net0", "name=eth0,bridge=vmbr0,hwaddr=AA:BB:CC:DD:EE:FF,ip=dhcp,ip6=auto,mtu=1400,link_down=1")).toMatchObject({ name: "eth0", mac: "AA:BB:CC:DD:EE:FF", ip6: "auto", mtu: 1400, linkDown: true });
    expect(readNic("qemu", "net0", "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,rate=3.5")).toMatchObject({ model: "virtio", rate: 3.5 });
    expect(featuresString(ctFeatures({}))).toBeNull();
    expect(efiValue({ storage: "s" })).toEqual({ value: "s:1,efitype=4m", ovmf: true });
    expect(display({ type: "std" })).toBe("type=std");
    expect(tags("a, b;c")).toEqual(["a", "b", "c"]);
    expect(ctDns({ nameserver: "", searchdomain: undefined })).toEqual({ nameserver: [], searchdomain: [] });
    expect(resources("lxc", 512, { memory: 600 }).params).toEqual({ memory: 600 });
  });
});
