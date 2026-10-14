import { createHash } from "node:crypto";
import type { Transport } from "@papercliped-engine/proxmox-client";
import { fakeGuest } from "./fakes-guest.ts";

/**
 * A Proxmox for the machine features beyond the machine page's basics, layered over fakes-guest.ts (which layers over the
 * shared fake): power actions with their options, snapshots with descriptions, clone and delete, Cloud-Init, the
 * guest agent, SPICE and the QEMU monitor, host hardware, capabilities, resource mappings, custom CPU models and bulk
 * actions. It checks requests the way Proxmox's API does: parameter names must exist, enums and ranges hold, raw
 * device passthrough is root@pam only, and an unknown parameter is a 400. Every request it answers is logged.
 *
 * Signing in as `root` in realm `pam` works here: the account maps to the shared fake's administrator but is
 * reported as root@pam, and its tickets are remembered so root-only rules can tell it apart from other administrators.
 */
export interface MachineCall {
  method: string;
  path: string;
  params: Record<string, string>;
}

const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ data }) });
const fail = (status: number, message: string) => ({ status, body: JSON.stringify({ message: `${message}\n` }) });
const sha = (s: string) => createHash("sha1").update(s).digest("hex");

const QEMU_KEYS = new RegExp(`^(acpi|affinity|agent|allow-ksm|amd-sev|arch|args|audio0|autostart|balloon|bios|boot|bootdisk|cdrom|cicustom|cipassword|citype|ciupgrade|ciuser|cores|cpu|cpulimit|cpuunits|delete|description|digest|efidisk0|force|freeze|hookscript|hostpci\\d+|hotplug|hugepages|ide\\d+|intel-tdx|ipconfig\\d+|ivshmem|keephugepages|keyboard|kvm|localtime|lock|machine|memory|migrate_downtime|migrate_speed|name|nameserver|net\\d+|numa|numa\\d+|onboot|ostype|parallel\\d+|protection|reboot|revert|rng0|sata\\d+|scsi\\d+|scsihw|searchdomain|serial\\d+|shares|skiplock|smbios1|smp|sockets|spice_enhancements|sshkeys|startdate|startup|tablet|tags|tdf|template|tpmstate0|unused\\d+|usb\\d+|vcpus|vga|virtio\\d+|virtiofs\\d+|vmgenid|vmstatestorage|watchdog)$`);
const LXC_KEYS = new RegExp(`^(arch|cmode|console|cores|cpulimit|cpuunits|debug|delete|description|dev\\d+|digest|entrypoint|env|features|hookscript|hostname|lock|memory|mp\\d+|nameserver|net\\d+|onboot|ostype|protection|revert|rootfs|searchdomain|startup|swap|tags|template|timezone|tty|unprivileged|unused\\d+)$`);

/** Parameters each endpoint accepts, from the API viewer. */
const STATUS_PARAMS: Record<string, Record<string, string[]>> = {
  qemu: {
    start: ["skiplock", "timeout", "force-cpu", "machine", "stateuri", "targetstorage", "with-conntrack-state"],
    stop: ["skiplock", "timeout", "keepActive", "overrule-shutdown"],
    reset: ["skiplock"],
    shutdown: ["skiplock", "timeout", "forceStop", "keepActive"],
    reboot: ["timeout"],
    suspend: ["skiplock", "statestorage", "todisk"],
    resume: ["skiplock", "nocheck"],
  },
  lxc: {
    start: ["skiplock", "debug"],
    stop: ["skiplock", "overrule-shutdown"],
    shutdown: ["timeout", "forceStop"],
    reboot: ["timeout"],
    suspend: [],
  },
};
const CLONE_PARAMS = { qemu: ["newid", "name", "target", "storage", "format", "full", "snapname", "pool", "bwlimit", "description"], lxc: ["newid", "hostname", "target", "storage", "full", "snapname", "pool", "bwlimit", "description"] };

export function fakeMachine(base: Transport) {
  const inner = fakeGuest(base);
  const calls: MachineCall[] = [];
  const { guests } = inner;
  const rootTickets = new Set<string>();
  const upids = new Set<string>();
  let seq = 0;
  const task = (what: string) => {
    const u = `UPID:pve:${String(++seq).padStart(8, "0")}:00000001:00000001:${what}:x:sam@pve:`;
    upids.add(u);
    return u;
  };
  type Snap = { name: string; description: string; time: number; parent: string | null; vmstate: number; cfg: Record<string, string | number> };
  const snaps = new Map<number, Snap[]>();
  const cloudPending = new Map<number, Record<string, string | null>>();
  const state = {
    agentPassword: [] as { vmid: number; username: string }[],
    frozen: new Set<number>(),
    execs: [] as { vmid: number; command: string[] }[],
    monitor: [] as { vmid: number; command: string }[],
    suspended: new Set<number>(),
    resizes: [] as { vmid: number; disk: string; size: string }[],
    rollbacks: [] as { vmid: number; snap: string; start: boolean }[],
    deleted: [] as { vmid: number; params: Record<string, string> }[],
  };
  // Hardware
  const pci = [
    { id: "0000:01:00.0", vendor: "0x10de", vendor_name: "NVIDIA Corporation", device: "0x2484", device_name: "GA104 [GeForce RTX 3070]", class: "0x030000", iommugroup: 14, mdev: true, subsystem_vendor_name: "Gigabyte", subsystem_device_name: "RTX 3070" },
    { id: "0000:01:00.1", vendor: "0x10de", vendor_name: "NVIDIA Corporation", device: "0x228b", device_name: "GA104 High Definition Audio", class: "0x040300", iommugroup: 14 },
    { id: "0000:00:1f.6", vendor: "0x8086", vendor_name: "Intel Corporation", device: "0x15fa", device_name: "Ethernet Connection", class: "0x020000", iommugroup: -1 },
    { id: "0000:00:00.0", vendor: "0x8086", vendor_name: "Intel Corporation", device: "0x3e0f", device_name: "Host bridge", class: "0x060000", iommugroup: 0 },
  ];
  const usb = [
    { busnum: 1, port: 2, devnum: 3, level: 1, vendid: "1234", prodid: "5678", product: "Security key", manufacturer: "Acme", class: 0, speed: "480", usbpath: "1-2" },
    { busnum: 1, port: 1, devnum: 1, level: 0, vendid: "1d6b", prodid: "0002", product: "xHCI Host Controller", class: 9, speed: "480", usbpath: "1-1" },
  ];
  type Mapping = { id: string; description?: string; map: string[]; mdev?: number; digest: string };
  const mappings: Record<"pci" | "usb" | "dir", Map<string, Mapping>> = {
    pci: new Map([["gpu0", { id: "gpu0", description: "Render GPU", map: ["node=pve,path=0000:01:00.0,id=10de:2484,iommugroup=14"], mdev: 1, digest: "" }]]),
    usb: new Map(),
    dir: new Map([["docs", { id: "docs", description: "Shared documents", map: ["node=pve,path=/srv/docs"], digest: "" }]]),
  };
  const cpuModels = new Map<string, Record<string, unknown>>([["fast", { cputype: "custom-fast", "reported-model": "Skylake-Server", flags: "+aes", digest: "" }]]);
  for (const k of ["pci", "usb", "dir"] as const) for (const m of mappings[k].values()) m.digest = sha(JSON.stringify(m));
  for (const m of cpuModels.values()) m.digest = sha(JSON.stringify(m));
  const bulk: { path: string; params: Record<string, string> }[] = [];

  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const path = u.pathname.replace("/api2/json", "");
    const form = new URLSearchParams(req.body ?? "");
    const params: Record<string, string> = Object.fromEntries([...u.searchParams, ...form]);
    const arrays = new Map<string, string[]>();
    for (const [k, v] of [...u.searchParams, ...form]) arrays.set(k, [...(arrays.get(k) ?? []), v]);

    // Sign-in as root@pam: the shared administrator, reported as root.
    if (path === "/access/ticket" && req.method === "POST" && params.username === "root" && params.realm === "pam") {
      if (params.password !== "right") return { status: 401, body: "" };
      const r = await base({ ...req, body: new URLSearchParams({ username: "sam", realm: "pve", password: "right" }).toString() });
      const data = JSON.parse(r.body).data;
      rootTickets.add(data.ticket);
      return ok({ ...data, username: "root@pam" });
    }
    const mine = /^\/(nodes\/pve\/(qemu|lxc)\/\d+\/(status|snapshot|clone|cloudinit|spiceproxy|monitor|agent|resize)|nodes\/pve\/(qemu|lxc)\/\d+$|nodes\/pve\/(hardware|capabilities|startall|stopall|suspendall|migrateall)|nodes\/pve\/tasks\/|nodes\/pve\/storage\/[\w-]+\/content|cluster\/mapping|cluster\/nextid|cluster\/qemu|cluster\/bulk-action|access\/permissions)|^\/nodes\/pve\/(qemu|lxc)\/\d+\/config$/.test(path);
    if (!mine) return inner.transport(req);
    const perm = await base({ ...req, method: "GET", url: `${u.origin}/api2/json/access/permissions?path=/`, body: undefined });
    if (perm.status === 401) return perm;
    const admin = (JSON.parse(perm.body).data?.["/"]?.["Sys.Modify"] ?? 0) === 1;
    const ticket = decodeURIComponent((req.headers.Cookie ?? "").replace("PVEAuthCookie=", ""));
    const root = rootTickets.has(ticket);
    const deny = fail(403, "Permission check failed (user lacks the privilege)");

    const log = () => calls.push({ method: req.method, path, params });
    const unknown = (allowed: string[]) => Object.keys(params).filter((k) => !allowed.includes(k));

    if (path === "/access/permissions" && params.path?.startsWith("/mapping/")) {
      log();
      return ok(admin ? { [params.path]: { "Mapping.Modify": 1, "Mapping.Use": 1, "Mapping.Audit": 1 } } : { [params.path]: {} });
    }
    if (path === "/access/permissions") return inner.transport(req);

    // ---- Tasks started here
    const tk = path.match(/^\/nodes\/pve\/tasks\/([^/]+)\/status$/);
    if (tk && upids.has(decodeURIComponent(tk[1]))) return ok({ status: "stopped", exitstatus: "OK" });
    if (path.startsWith("/nodes/pve/tasks/")) return inner.transport(req);

    // ---- Snippets
    const sc = path.match(/^\/nodes\/pve\/storage\/([\w-]+)\/content$/);
    if (sc) {
      if (params.content === "snippets") return ok([{ volid: `${sc[1]}:snippets/user.yaml`, content: "snippets" }, { volid: `${sc[1]}:snippets/network.yaml`, content: "snippets" }]);
      return inner.transport(req);
    }

    if (path === "/cluster/nextid") {
      if (params.vmid && guests.has(Number(params.vmid))) return fail(400, `Parameter verification failed.\nvmid: VM ${params.vmid} already exists`);
      if (params.vmid) return ok(params.vmid);
      let n = 9000;
      while (guests.has(n)) n++;
      return ok(String(n));
    }

    // ---- Hardware and capabilities
    if (path === "/nodes/pve/hardware/pci") {
      log();
      if (!admin) return deny;
      const black = (params["pci-class-blacklist"] ?? "05;06;0b").split(";").filter(Boolean);
      return ok(pci.filter((d) => !black.some((c) => d.class.startsWith(`0x${c}`))));
    }
    const md = path.match(/^\/nodes\/pve\/hardware\/pci\/([^/]+)\/mdev$/);
    if (md) {
      log();
      if (!admin) return deny;
      return ok(pci.find((d) => d.id === decodeURIComponent(md[1]))?.mdev ? [{ type: "nvidia-63", name: "GRID P40-1Q", description: "framebuffer=1024M", available: 8 }] : []);
    }
    if (path === "/nodes/pve/hardware/usb") {
      log();
      return admin ? ok(usb) : deny;
    }
    if (path === "/nodes/pve/capabilities/qemu/cpu") return ok([{ name: "host", vendor: "default" }, { name: "x86-64-v2-AES", vendor: "default" }, { name: "Skylake-Server", vendor: "GenuineIntel" }, { name: "custom-fast", vendor: "GenuineIntel", custom: 1 }]);
    if (path === "/nodes/pve/capabilities/qemu/cpu-flags") return ok([{ name: "aes", description: "AES instructions" }, { name: "pcid", description: "Process-context IDs" }, { name: "spec-ctrl", description: "Spectre protection" }, { name: "ssbd", description: "Speculative store bypass disable" }]);
    if (path === "/nodes/pve/capabilities/qemu/machines") return ok([{ id: "pc-i440fx-9.0", type: "i440fx", version: "9.0" }, { id: "pc-q35-9.0", type: "q35", version: "9.0" }, { id: "pc-q35-8.1", type: "q35", version: "8.1" }]);
    if (path === "/nodes/pve/capabilities/qemu/migration") return ok({ cpu: "Skylake-Server", "has-dbus-vmstate": 1 });

    // ---- Mappings
    const mp = path.match(/^\/cluster\/mapping\/(pci|usb|dir)(?:\/([\w-]+))?$/);
    if (mp) {
      log();
      const kind = mp[1] as "pci" | "usb" | "dir";
      const store = mappings[kind];
      if (req.method === "GET" && !mp[2]) return ok([...store.values()]);
      if (req.method === "GET") return store.has(mp[2]) ? ok(store.get(mp[2])) : fail(404, "mapping does not exist");
      if (!admin) return deny;
      if (req.method === "DELETE") return store.delete(mp[2]) ? ok(null) : fail(404, "mapping does not exist");
      const allowed = kind === "pci" ? ["id", "description", "map", "mdev", "live-migration-capable", "digest", "delete"] : ["id", "description", "map", "digest", "delete"];
      const extra = unknown(allowed);
      if (extra.length) return fail(400, `Parameter verification failed. ${extra[0]}: property is not defined in schema`);
      const lines = arrays.get("map") ?? [];
      for (const line of lines) {
        const keys = line.split(",").map((x) => x.split("=")[0]);
        const need = kind === "pci" ? ["node", "path", "id"] : kind === "usb" ? ["node", "id"] : ["node", "path"];
        for (const k of need) if (!keys.includes(k)) return fail(400, `Parameter verification failed. map: missing ${k}`);
      }
      if (req.method === "POST") {
        if (store.has(params.id)) return fail(500, `mapping '${params.id}' already defined`);
        if (!lines.length) return fail(400, "Parameter verification failed. map: property is missing");
        const entry: Mapping = { id: params.id, description: params.description, map: lines, mdev: params.mdev === "1" ? 1 : undefined, digest: "" };
        entry.digest = sha(JSON.stringify(entry));
        store.set(params.id, entry);
        return ok(null);
      }
      const cur = store.get(mp[2]);
      if (!cur) return fail(404, "mapping does not exist");
      if (params.digest && params.digest !== cur.digest) return fail(400, "detected modified configuration - file changed by other user! Try again.");
      if (lines.length) cur.map = lines;
      if (params.description !== undefined) cur.description = params.description;
      if (params.delete?.includes("description")) delete cur.description;
      if (params.mdev !== undefined) cur.mdev = params.mdev === "1" ? 1 : undefined;
      cur.digest = sha(JSON.stringify({ ...cur, digest: "" }));
      return ok(null);
    }
    // ---- Custom CPU models
    if (path === "/cluster/qemu/custom-cpu-models" && req.method === "GET") {
      log();
      return ok([...cpuModels.values()]);
    }
    const cm = path.match(/^\/cluster\/qemu\/custom-cpu-models(?:\/([\w-]+))?$/);
    if (cm) {
      log();
      if (!admin) return deny;
      if (req.method === "POST") {
        if (!params.cputype || !params["reported-model"]) return fail(400, "Parameter verification failed. reported-model: property is missing");
        cpuModels.set(params.cputype, { cputype: `custom-${params.cputype}`, ...Object.fromEntries(Object.entries(params).filter(([k]) => k !== "cputype")), digest: "d" });
        return ok(null);
      }
      if (req.method === "DELETE") return cpuModels.delete(cm[1]) ? ok(null) : fail(404, "no such model");
      const cur = cpuModels.get(cm[1]);
      if (!cur) return fail(404, "no such model");
      for (const [k, v] of Object.entries(params)) if (!["cputype", "delete", "digest"].includes(k)) cur[k] = v;
      for (const k of (params.delete ?? "").split(",").filter(Boolean)) delete cur[k];
      return ok(null);
    }

    // ---- Bulk
    const bk = path.match(/^\/(cluster\/bulk-action\/guest\/(start|shutdown|suspend|migrate)|nodes\/pve\/(startall|stopall|suspendall|migrateall))$/);
    if (bk) {
      log();
      bulk.push({ path, params });
      const allowed = bk[2]
        ? { start: ["vms", "max-workers", "timeout"], shutdown: ["vms", "max-workers", "timeout", "force-stop"], suspend: ["vms", "max-workers", "to-disk", "statestorage"], migrate: ["vms", "max-workers", "target", "online", "with-local-disks"] }[bk[2] as "start"]
        : ["vms", "max-workers", "force", "force-stop", "timeout", "target", "with-local-disks"];
      const extra = unknown(allowed);
      if (extra.length) return fail(400, `Parameter verification failed. ${extra[0]}: property is not defined in schema`);
      return ok(task("bulk"));
    }

    // ---- Machines
    const g = path.match(/^\/nodes\/pve\/(qemu|lxc)\/(\d+)(?:\/(.+))?$/);
    if (!g) return inner.transport(req);
    const id = Number(g[2]);
    const m = guests.get(id);
    if (!m || m.type !== g[1]) return fail(500, "Configuration file does not exist");
    const tail = g[3] ?? "";
    log();

    if (tail === "config" && req.method === "PUT") {
      const keys = Object.keys(params);
      const re = m.type === "qemu" ? QEMU_KEYS : LXC_KEYS;
      const badKey = keys.find((k) => !re.test(k));
      if (badKey) return fail(400, `Parameter verification failed.\n${badKey}: property is not defined in schema and the schema does not allow additional properties`);
      for (const k of (params.delete ?? "").split(",").filter(Boolean)) if (!re.test(k)) return fail(400, `Parameter verification failed.\ndelete: unknown option '${k}'`);
      if (!admin && !root) return deny;
      // Raw host devices are root@pam only; mappings need Mapping.Use (admins here).
      for (const [k, v] of Object.entries(params)) {
        if (/^hostpci\d+$/.test(k) && !/mapping=/.test(v) && !root) return fail(403, "Permission check failed (only root can pass through a raw PCI device)");
        if (/^usb\d+$/.test(k) && !/mapping=|host=spice/.test(v) && !root) return fail(403, "Permission check failed (only root can pass through a raw USB device)");
        if (/^dev\d+$/.test(k) && !root) return fail(403, "Permission check failed (only root can add device passthrough)");
        if (k === "args" && !root) return fail(403, "Permission check failed (only root can set 'args')");
        if (k === "hostpci0" && /pcie=1/.test(v) && !/q35/.test(String(m.cfg.machine ?? "")) && !/q35/.test(params.machine ?? "")) return fail(500, "q35 machine model is not enabled");
        if (k === "cicustom" && !/^((user|network|meta|vendor)=[\w.-]+:snippets\/[\w.-]+)(,(user|network|meta|vendor)=[\w.-]+:snippets\/[\w.-]+)*$/.test(v)) return fail(400, "Parameter verification failed.\ncicustom: invalid format");
        if (k === "cipassword" && v.length < 5) return fail(400, "Parameter verification failed.\ncipassword: value must be at least 5 characters long");
        if (/^ipconfig\d+$/.test(k) && !/^(?:(ip|gw|ip6|gw6)=[^,]+)(?:,(ip|gw|ip6|gw6)=[^,]+)*$/.test(v)) return fail(400, `Parameter verification failed.\n${k}: invalid format`);
        if (k === "cpu" && !/^[\w.-]+(,[\w-]+=[^,]+)*$|^([\w-]+=[^,]+)(,[\w-]+=[^,]+)*$/.test(v)) return fail(400, "Parameter verification failed.\ncpu: invalid format");
        if (k === "machine" && !/^(?:[\w.+-]+)?(,[\w-]+=[^,]+)*$/.test(v)) return fail(400, "Parameter verification failed.\nmachine: invalid format");
      }
      if (params.revert) {
        const cur = inner.digestOf(id);
        if (params.digest && params.digest !== cur) return fail(400, "detected modified configuration - file changed by other user! Try again.");
        for (const k of params.revert.split(",")) {
          if (!(k in m.pending)) return fail(400, `Parameter verification failed.\nrevert: no pending change for '${k}'`);
          delete m.pending[k];
        }
        return ok(null);
      }
      const ci = /^(cipassword|ciuser|sshkeys|cicustom|ipconfig\d+|nameserver|searchdomain|ciupgrade|citype)$/;
      const touched = [...Object.keys(params), ...(params.delete ?? "").split(",")].filter((k) => ci.test(k));
      if (touched.length) {
        const pend = cloudPending.get(id) ?? {};
        for (const [k, v] of Object.entries(params)) if (ci.test(k)) pend[k] = v;
        for (const k of (params.delete ?? "").split(",")) if (ci.test(k)) pend[k] = null;
        cloudPending.set(id, pend);
      }
      return inner.transport(req);
    }
    if (tail === "config" || tail === "pending" || tail === "interfaces" || tail === "agent/network-get-interfaces" || tail === "agent/get-host-name") return inner.transport(req);

    if (tail === "" && req.method === "DELETE") {
      if (!admin) return deny;
      const extra = unknown(m.type === "qemu" ? ["purge", "skiplock", "destroy-unreferenced-disks"] : ["purge", "force", "destroy-unreferenced-disks"]);
      if (extra.length) return fail(400, `Parameter verification failed. ${extra[0]}: property is not defined in schema`);
      state.deleted.push({ vmid: id, params });
      guests.delete(id);
      return ok(task("delete"));
    }

    if (tail === "resize" && req.method === "PUT") {
      if (!admin) return deny;
      if (!(params.disk in m.cfg)) return fail(500, `disk '${params.disk}' does not exist`);
      if (!/^\+?\d+(\.\d+)?[KMGT]?$/.test(params.size ?? "")) return fail(400, "Parameter verification failed.\nsize: invalid format");
      state.resizes.push({ vmid: id, disk: params.disk, size: params.size });
      return ok(null);
    }

    // Power
    const st = tail.match(/^status\/(\w+)$/);
    if (st && req.method === "POST") {
      if (!admin) return deny;
      const allowed = STATUS_PARAMS[m.type][st[1]];
      if (!allowed) return fail(501, `Method 'POST /nodes/pve/${m.type}/${id}/status/${st[1]}' not implemented`);
      const extra = unknown(allowed);
      if (extra.length) return fail(400, `Parameter verification failed. ${extra[0]}: property is not defined in schema`);
      for (const [k, v] of Object.entries(params)) if (k === "timeout" && !/^\d+$/.test(v)) return fail(400, "Parameter verification failed. timeout: value is not an integer");
      if (st[1] === "start") m.status = "running";
      else if (st[1] === "stop" || st[1] === "shutdown") m.status = "stopped";
      else if (st[1] === "suspend") {
        if (m.status !== "running") return fail(500, "VM is not running");
        if (params.todisk === "1") m.status = "stopped";
        else state.suspended.add(id);
      } else if (st[1] === "resume") {
        if (!state.suspended.has(id)) return fail(500, "VM is not paused");
        state.suspended.delete(id);
      }
      return ok(task(`q${st[1]}`));
    }

    // Snapshots
    const list = snaps.get(id) ?? [];
    snaps.set(id, list);
    if (tail === "snapshot" && req.method === "GET") return ok([...list.map((s) => ({ name: s.name, description: s.description, snaptime: s.time, parent: s.parent ?? undefined, vmstate: s.vmstate })), { name: "current", description: "You are here!", parent: list.at(-1)?.name }]);
    if (tail === "snapshot" && req.method === "POST") {
      if (!admin) return deny;
      const extra = unknown(["snapname", "description", "vmstate"]);
      if (extra.length) return fail(400, `Parameter verification failed. ${extra[0]}: property is not defined in schema`);
      if (list.some((s) => s.name === params.snapname)) return fail(500, "snapshot name already used");
      list.push({ name: params.snapname, description: params.description ?? "", time: 1_760_000_000 + list.length * 60, parent: list.at(-1)?.name ?? null, vmstate: params.vmstate === "1" ? 1 : 0, cfg: { ...m.cfg } });
      return ok(task("snapshot"));
    }
    const sn = tail.match(/^snapshot\/([\w-]+)(?:\/(config|rollback))?$/);
    if (sn) {
      const s = list.find((x) => x.name === sn[1]);
      if (!s) return fail(500, `snapshot '${sn[1]}' does not exist`);
      if (sn[2] === "config" && req.method === "GET") return ok({ ...s.cfg, description: s.description, snaptime: s.time, ...(s.vmstate ? { vmstate: `local-lvm:vm-${id}-state-${s.name}` } : {}) });
      if (sn[2] === "config" && req.method === "PUT") {
        if (!admin) return deny;
        const extra = unknown(["description"]);
        if (extra.length) return fail(400, `Parameter verification failed. ${extra[0]}: property is not defined in schema`);
        s.description = params.description ?? "";
        return ok(null);
      }
      if (sn[2] === "rollback" && req.method === "POST") {
        if (!admin) return deny;
        const extra = unknown(["start"]);
        if (extra.length) return fail(400, `Parameter verification failed. ${extra[0]}: property is not defined in schema`);
        state.rollbacks.push({ vmid: id, snap: s.name, start: params.start === "1" });
        m.cfg = { ...s.cfg };
        if (params.start === "1") m.status = "running";
        return ok(task("rollback"));
      }
      if (req.method === "DELETE") {
        snaps.set(id, list.filter((x) => x !== s));
        return ok(task("delsnapshot"));
      }
    }

    // Clone
    if (tail === "clone" && req.method === "POST") {
      if (!admin) return deny;
      const extra = unknown(CLONE_PARAMS[m.type]);
      if (extra.length) return fail(400, `Parameter verification failed. ${extra[0]}: property is not defined in schema`);
      const newid = Number(params.newid);
      if (!Number.isInteger(newid) || newid < 100) return fail(400, "Parameter verification failed. newid: value must be at least 100");
      if (guests.has(newid)) return fail(500, `VM ${newid} already exists`);
      if (params.full === "0" && !String(m.cfg.template ?? "")) return fail(500, "can't clone non-template VM as linked clone");
      guests.set(newid, { type: m.type, name: params.name ?? params.hostname ?? `clone-${newid}`, status: "stopped", pending: {}, cfg: { ...(params.snapname ? snaps.get(id)?.find((s) => s.name === params.snapname)?.cfg : m.cfg), ...(m.type === "qemu" ? { name: params.name ?? `clone-${newid}` } : { hostname: params.hostname ?? `clone-${newid}` }) } });
      return ok(task("qmclone"));
    }

    // Cloud-Init
    if (tail === "cloudinit" && req.method === "GET") {
      const pend = cloudPending.get(id) ?? {};
      return ok(Object.entries(pend).map(([key, v]) => (v === null ? { key, delete: 1, value: m.cfg[key] } : { key, pending: key === "cipassword" ? "**********" : v, value: m.cfg[key] })));
    }
    if (tail === "cloudinit" && req.method === "PUT") {
      if (!admin) return deny;
      cloudPending.delete(id);
      return ok(null);
    }
    if (tail === "cloudinit/dump" && req.method === "GET") {
      const t = params.type;
      if (!["user", "network", "meta"].includes(t)) return fail(400, "Parameter verification failed. type: value 'x' does not have a value in the enumeration 'user, network, meta'");
      if (t === "user") return ok(`#cloud-config\nhostname: ${m.cfg.name}\nmanage_etc_hosts: true\nuser: ${m.cfg.ciuser ?? "root"}\npasswd: $5$secrethash\nchpasswd:\n  expire: False\n`);
      return ok(t === "network" ? "version: 1\nconfig:\n  - type: physical\n    name: eth0\n" : `instance-id: abc123\nlocal-hostname: ${m.cfg.name}\n`);
    }

    // Console helpers
    if (tail === "spiceproxy" && req.method === "POST") {
      const extra = unknown(["proxy"]);
      if (extra.length) return fail(400, `Parameter verification failed. ${extra[0]}: property is not defined in schema`);
      return ok({ type: "spice", title: `VM ${id}`, host: "pvespiceproxy:abc", proxy: `http://${params.proxy ?? "pve"}:3128`, "tls-port": 61000, password: "spice-ticket", "delete-this-file": 1, "toggle-fullscreen": "shift+f11", "release-cursor": "ctrl+alt+r", ca: "-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----\\n" });
    }
    if (tail === "monitor" && req.method === "POST") {
      if (!admin) return deny;
      if (m.status !== "running") return fail(500, "VM is not running");
      state.monitor.push({ vmid: id, command: params.command });
      return ok(params.command === "info status" ? "VM status: running\r\n" : `unknown command: '${params.command}'\r\n`);
    }

    // Guest agent
    const ag = tail.match(/^agent\/([\w-]+)$/);
    if (ag) {
      if (m.status !== "running") return fail(500, "VM is not running");
      if (!inner.agent.up || !String(m.cfg.agent ?? "").includes("1")) return fail(500, "QEMU guest agent is not running");
      const a = ag[1];
      const reads: Record<string, unknown> = {
        info: { result: { version: "8.2.0", supported_commands: [{ name: "guest-ping", enabled: true }, { name: "guest-exec", enabled: true }] } },
        "get-osinfo": { result: { name: "Ubuntu", "pretty-name": "Ubuntu 24.04 LTS", version: "24.04", "kernel-release": "6.8.0", machine: "x86_64" } },
        "get-fsinfo": { result: [{ name: "sda1", mountpoint: "/", type: "ext4", "used-bytes": 3e9, "total-bytes": 32e9, disk: [{ serial: "drive-scsi0" }] }] },
        "get-users": { result: [{ user: "ubuntu", "login-time": 1_760_000_000.5 }] },
        "get-time": { result: 1_760_000_000_000_000_000 },
        "get-timezone": { result: { zone: "UTC", offset: 0 } },
        "get-vcpus": { result: [{ "logical-id": 0, online: true, "can-offline": false }, { "logical-id": 1, online: true, "can-offline": true }] },
        "get-memory-blocks": { result: [] },
      };
      if (req.method === "GET" && a in reads) return ok(reads[a]);
      if (req.method === "GET" && a === "file-read") {
        const extra = unknown(["file", "count", "offset", "decode"]);
        if (extra.length) return fail(400, `Parameter verification failed. ${extra[0]}: property is not defined in schema`);
        if (params.file === "/etc/os-release") return ok({ content: 'NAME="Ubuntu"\nVERSION_ID="24.04"\n', "bytes-read": 31, truncated: false });
        return fail(500, `Failed to open file ${params.file}: No such file or directory`);
      }
      if (req.method === "GET" && a === "exec-status") {
        const last = state.execs.at(-1);
        return ok({ exited: 1, exitcode: 0, "out-data": `ran ${last?.command.join(" ")}\n`, "err-data": "" });
      }
      if (req.method === "POST") {
        if (a === "ping") return ok({ result: {} });
        if (a === "fstrim") return ok({ result: { paths: [{ path: "/", trimmed: 1_048_576 }] } });
        if (a === "fsfreeze-freeze") return state.frozen.add(id), ok({ result: 1 });
        if (a === "fsfreeze-thaw") return state.frozen.delete(id), ok({ result: 1 });
        if (a === "fsfreeze-status") return ok({ result: state.frozen.has(id) ? "frozen" : "thawed" });
        if (a === "set-user-password") {
          if (!root && !admin) return deny;
          const extra = unknown(["username", "password", "crypted"]);
          if (extra.length) return fail(400, `Parameter verification failed. ${extra[0]}: property is not defined in schema`);
          if (params.password === "boom-secret-pw") return fail(500, `guest-set-user-password failed for ${params.username} with ${params.password}`);
          state.agentPassword.push({ vmid: id, username: params.username });
          return ok(null);
        }
        if (a === "exec") {
          const extra = unknown(["command", "input-data"]);
          if (extra.length) return fail(400, `Parameter verification failed. ${extra[0]}: property is not defined in schema`);
          state.execs.push({ vmid: id, command: arrays.get("command") ?? [] });
          return ok({ pid: 4242 });
        }
      }
    }
    return fail(501, `fake: ${req.method} ${path} not implemented`);
  };

  return { ...inner, transport, calls, allCalls: () => [...inner.calls, ...calls], snaps, cloudPending, state, mappings, cpuModels, bulk, rootTickets, pci, usb };
}
