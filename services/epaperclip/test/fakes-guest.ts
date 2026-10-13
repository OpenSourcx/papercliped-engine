import { createHash } from "node:crypto";
import type { Transport } from "@papercliped-engine/proxmox-client";

/**
 * A Proxmox for the machine page, layered over the shared fake (which keeps sign-in, tickets and permissions): four
 * machines (a running VM with the guest agent, a running container, a stopped VM and a stopped container) whose
 * configuration changes like the real thing (digests that refuse stale writes, `delete` lists, pending changes on a
 * running VM), the guest agent and container interface calls, host PCI and USB devices, mappings, and access entries.
 * Every request is logged so tests can assert on what reached Proxmox.
 */
export interface GuestCall {
  method: string;
  path: string;
  params: Record<string, string>;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ data }) });
const fail = (status: number, message: string) => ({ status, body: JSON.stringify({ message: `${message}\n` }) });

export function fakeGuest(base: Transport) {
  const calls: GuestCall[] = [];
  type M = { type: "qemu" | "lxc"; name: string; status: string; pool?: string; cfg: Record<string, string | number>; pending: Record<string, string | null>; lock?: string };
  const guests = new Map<number, M>([
    [300, { type: "qemu", name: "vm-app", status: "running", pool: "co-acme", pending: {}, cfg: { name: "vm-app", cores: 2, sockets: 1, memory: 4096, balloon: 2048, bios: "seabios", agent: "enabled=1", ostype: "l26", vga: "std", net0: "virtio=BC:24:11:AA:BB:01,bridge=vmbr0,firewall=1,tag=20", net1: "e1000=BC:24:11:AA:BB:02,bridge=vmbr1,host-tunnel=0", scsi0: "local-lvm:vm-300-disk-0,size=32G", description: "The app server.", tags: "web;prod", hostpci0: "0000:01:00.0,pcie=1,x-vga=1", usb0: "host=1234:5678", serial0: "socket" } }],
    [301, { type: "lxc", name: "ct-web", status: "running", pending: {}, cfg: { hostname: "ct-web", cores: 2, memory: 1024, swap: 512, arch: "amd64", unprivileged: 1, net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=dhcp,type=veth", net1: "name=eth1,bridge=vmbr1,hwaddr=BC:24:11:00:00:02,ip=10.0.5.20/24,gw=10.0.5.1,type=veth", nameserver: "1.1.1.1 9.9.9.9", searchdomain: "lan", features: "nesting=1,keyctl=1", dev0: "/dev/dri/card0,mode=0660,gid=44", rootfs: "local-lvm:vm-301-disk-0,size=8G", tags: "edge" } }],
    [302, { type: "qemu", name: "vm-win", status: "stopped", pending: {}, cfg: { name: "vm-win", cores: 4, memory: 8192, bios: "ovmf", ostype: "win11", net0: "e1000e=BC:24:11:AA:BB:03,bridge=vmbr0", scsi0: "local-lvm:vm-302-disk-0,size=64G" } }],
    [303, { type: "lxc", name: "ct-idle", status: "stopped", pending: {}, cfg: { hostname: "ct-idle", cores: 1, memory: 512, swap: 512, net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:09,ip=192.168.1.9/24,ip6=fd00::9/64,gw=192.168.1.1,type=veth", rootfs: "local-lvm:vm-303-disk-0,size=4G" } }],
  ]);
  const digestOf = (id: number) => sha(JSON.stringify(guests.get(id)!.cfg));
  type Acl = { path: string; type: string; ugid: string; roleid: string; propagate: number };
  const acl: Acl[] = [
    { path: "/", type: "user", ugid: "sam@pve", roleid: "Administrator", propagate: 1 },
    { path: "/vms", type: "group", ugid: "ops", roleid: "PVEVMUser", propagate: 1 },
    { path: "/vms/300", type: "user", ugid: "lee@pve", roleid: "PVEVMUser", propagate: 1 },
    { path: "/pool/co-acme", type: "user", ugid: "lee@pve", roleid: "PVEAuditor", propagate: 1 },
  ];
  const roles = ["Administrator", "PVEAuditor", "PVEVMAdmin", "PVEVMUser", "NoAccess"];
  const agent = { up: true };

  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const path = u.pathname.replace("/api2/json", "");
    const form = new URLSearchParams(req.body ?? "");
    const params: Record<string, string> = Object.fromEntries([...u.searchParams, ...form]);
    const mine = /^\/(nodes$|cluster\/firewall|nodes\/pve\/firewall|nodes\/pve\/(qemu|lxc)\/\d+|nodes\/pve\/hardware|nodes\/pve\/network|cluster\/resources|cluster\/mapping|cluster\/sdn\/vnets|access\/(acl|roles|users|groups))/.test(path);
    if (!mine) return base(req);
    const perm = await base({ ...req, method: "GET", url: `${u.origin}/api2/json/access/permissions?path=/`, body: undefined });
    if (perm.status === 401) return perm;
    const admin = (JSON.parse(perm.body).data?.["/"]?.["Sys.Modify"] ?? 0) === 1;
    const ticket = decodeURIComponent((req.headers.Cookie ?? "").replace("PVEAuthCookie=", ""));
    const who = ticket.split(":")[1] ?? "";
    calls.push({ method: req.method, path, params });
    const deny = fail(403, "Permission check failed (user lacks the privilege)");

    if (path === "/cluster/resources" && params.type === "storage") return base(req);
    if (path === "/cluster/resources") return ok([...guests].map(([vmid, g]) => ({ id: `${g.type}/${vmid}`, type: g.type, vmid, node: "pve", name: g.name, status: g.status, pool: g.pool, tags: String(g.cfg.tags ?? ""), cpu: g.status === "running" ? 0.12 : 0, maxcpu: Number(g.cfg.cores ?? 1), mem: g.status === "running" ? 1.1e9 : 0, maxmem: Number(g.cfg.memory ?? 512) * 1048576, disk: 3e9, maxdisk: 32e9, uptime: g.status === "running" ? 86400 : 0 })));
    if (path === "/nodes") return ok([{ node: "pve", status: "online" }]);
    if (/\/firewall\/options$/.test(path)) return ok({ enable: 1, policy_in: "DROP", policy_out: "ACCEPT" });
    if (/\/firewall\/rules$/.test(path) && req.method === "GET") return ok([{ pos: 0, type: "in", action: "ACCEPT", macro: "SSH", source: "192.168.1.0/24", comment: "SSH from the office network", enable: 1 }, { pos: 1, type: "in", action: "ACCEPT", proto: "tcp", dport: "443", comment: "Web", enable: 1, log: "info" }, { pos: 2, type: "out", action: "DROP", dest: "10.99.0.0/16", comment: "Never reach the lab network", enable: 0 }]);
    if (/\/firewall\/(aliases|ipset|log)$/.test(path)) return ok([]);
    if (path === "/nodes/pve/network") return admin ? ok([{ iface: "vmbr0", type: "bridge" }, { iface: "vmbr1", type: "bridge" }]) : deny;
    if (path === "/cluster/sdn/vnets") return ok([{ vnet: "acme", zone: "orgs" }]);
    if (path === "/nodes/pve/hardware/pci") return admin ? ok([{ id: "0000:01:00.0", vendor_name: "NVIDIA Corporation", device_name: "GA104 [GeForce RTX 3070]", class: "0x030000", iommugroup: 14, mdev: false }, { id: "0000:00:1f.6", vendor_name: "Intel Corporation", device_name: "Ethernet Connection", class: "0x020000", iommugroup: -1 }]) : deny;
    if (path === "/nodes/pve/hardware/usb") return admin ? ok([{ busnum: 1, port: 2, devnum: 3, vendid: "1234", prodid: "5678", product: "Security key", class: 0, speed: "480" }, { busnum: 1, port: 1, devnum: 1, vendid: "1d6b", prodid: "0002", product: "xHCI Host Controller", class: 9, speed: "480" }]) : deny;
    if (path === "/cluster/mapping/pci") return ok([{ id: "gpu0", description: "Render GPU", map: [{ node: "pve", path: "0000:01:00.0" }] }]);
    if (path === "/cluster/mapping/usb") return ok([]);
    if (path === "/access/roles") return ok(roles.map((roleid) => ({ roleid })));
    if (path === "/access/users") return ok([{ userid: "sam@pve" }, { userid: "lee@pve" }, { userid: "root@pam" }]);
    if (path === "/access/groups") return ok([{ groupid: "ops" }]);
    if (path === "/access/acl" && req.method === "GET") return admin || who ? ok(acl) : deny;
    if (path === "/access/acl" && req.method === "PUT") {
      if (!admin) return deny;
      const key = params.users ? "user" : params.groups ? "group" : "token";
      const id = params.users ?? params.groups ?? params.tokens;
      const i = acl.findIndex((a) => a.path === params.path && a.ugid === id && a.roleid === params.roles && a.type === key);
      if (params.delete === "1") {
        if (i >= 0) acl.splice(i, 1);
      } else if (i < 0) acl.push({ path: params.path, type: key, ugid: id, roleid: params.roles, propagate: params.propagate === "0" ? 0 : 1 });
      return ok(null);
    }

    const rrd = path.match(/^\/nodes\/pve\/(qemu|lxc)\/(\d+)\/rrddata$/);
    if (rrd) return ok(Array.from({ length: 60 }, (_, i) => ({ time: 1_760_000_000 + i * 60, cpu: 0.1 + 0.05 * Math.sin(i / 6), maxcpu: 2, mem: 1.2e9 + 1e8 * Math.sin(i / 9), maxmem: 4e9, netin: 2e4 + 1e4 * Math.sin(i / 4), netout: 1e4, diskread: 0, diskwrite: 5e3 })));
    const g = path.match(/^\/nodes\/pve\/(qemu|lxc)\/(\d+)\/(config|pending|interfaces|agent\/network-get-interfaces|agent\/get-host-name)$/);
    if (!g) return fail(501, `fake: ${req.method} ${path} not implemented`);
    const id = Number(g[2]);
    const m = guests.get(id);
    if (!m || m.type !== g[1]) return fail(500, "Configuration file does not exist");
    const tail = g[3];
    if (tail === "config" && req.method === "GET") return ok({ ...m.cfg, ...(m.lock ? { lock: m.lock } : {}), digest: digestOf(id) });
    if (tail === "pending") return ok(Object.entries(m.pending).map(([key, value]) => (value === null ? { key, delete: 1, value: m.cfg[key] } : { key, pending: value, value: m.cfg[key] })));
    if (tail === "config" && req.method === "PUT") {
      if (!admin && who !== "sam@pve") return deny;
      if (params.digest && params.digest !== digestOf(id)) return fail(400, "detected modified configuration - file changed by other user! Try again.");
      const { digest: _d, delete: del, ...rest } = params;
      const stage = (k: string, v: string | null) => {
        if (m.status === "running") m.pending[k] = v;
        if (v === null) delete m.cfg[k];
        else m.cfg[k] = v;
      };
      for (const k of (del ?? "").split(",").filter(Boolean)) stage(k, null);
      for (const [k, v] of Object.entries(rest)) stage(k, v);
      return ok(null);
    }
    if (m.status !== "running") return fail(500, m.type === "qemu" ? "VM is not running" : "container is not running");
    if (tail === "interfaces") return ok([{ name: "lo", hwaddr: "00:00:00:00:00:00", inet: "127.0.0.1/8" }, { name: "eth0", hwaddr: "BC:24:11:00:00:01", inet: "192.168.1.51/24", inet6: "fe80::be24:11ff:fe00:1/64" }]);
    if (!agent.up || !String(m.cfg.agent ?? "").includes("1")) return fail(500, "QEMU guest agent is not running");
    if (tail === "agent/get-host-name") return ok({ result: { "host-name": "app.lan" } });
    return ok({ result: [{ name: "lo", "hardware-address": "00:00:00:00:00:00", "ip-addresses": [{ "ip-address": "127.0.0.1", "ip-address-type": "ipv4", prefix: 8 }] }, { name: "ens18", "hardware-address": "bc:24:11:aa:bb:01", "ip-addresses": [{ "ip-address": "192.168.1.60", "ip-address-type": "ipv4", prefix: 24 }, { "ip-address": "fd00::60", "ip-address-type": "ipv6", prefix: 64 }] }] });
  };

  return { transport, calls, guests, digestOf, acl, agent };
}
