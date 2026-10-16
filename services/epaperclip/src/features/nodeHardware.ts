import { asNumber, checkDc, NODE_NAME, vmidList, withDelete } from "./dcCommon.ts";
import { DC_SCHEMAS } from "./dcSchema.ts";
import { bad, confirmed, noExtra, query, resolveNode, seg, soft, type Deps, type Route } from "./nodeCommon.ts";
import { readGroup } from "./nodeValidate.ts";

/**
 * Node hardware and details (CPU, memory, boot mode, PCI and USB devices, mediated device types), installed package
 * versions, the support report, node notes and options, exported metrics, the schedule analyzer, cluster-wide totals
 * and the resource tree, and the bulk guest actions (start all, stop all, suspend all, migrate all).
 */

const PCI_ID = /^[0-9a-f]{4,}:[0-9a-f]{2}:[0-9a-f]{2}(?:\.[0-9a-f])?$/i;
const MAX_REPORT = 2_000_000;

type Raw = Record<string, any>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, max = 300): string | null => (typeof v === "string" && v ? v.slice(0, max) : null);

export function nodeHardwareRoutes(_d: Deps): Route[] {
  return [
    // ---- CPU, memory, boot mode, kernel: what Proxmox's node Summary shows
    {
      method: "GET",
      re: /^\/api\/node\/hardware$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const [st, pci, usb, cfg] = await Promise.all([
            soft(pve.call<Raw>("GET", `/nodes/${seg(node)}/status`)),
            soft(pve.call<Raw[]>("GET", `/nodes/${seg(node)}/hardware/pci`, { verbose: 1 })),
            soft(pve.call<Raw[]>("GET", `/nodes/${seg(node)}/hardware/usb`)),
            soft(pve.call<Raw>("GET", `/nodes/${seg(node)}/config`)),
          ]);
          const s = st.data ?? {};
          const cpu = s.cpuinfo ?? {};
          return {
            node,
            statusDenied: st.denied,
            cpu: st.data
              ? { model: text(cpu.model), sockets: num(cpu.sockets), cores: num(cpu.cores), threads: num(cpu.cpus), mhz: cpu.mhz === undefined ? null : Number(cpu.mhz) || null, flags: text(cpu.flags, 4000), hvm: cpu.hvm === undefined ? null : cpu.hvm === 1 || cpu.hvm === "1", usage: num(s.cpu), load: Array.isArray(s.loadavg) ? s.loadavg.map(Number) : null, ioWait: num(s.wait) }
              : null,
            memory: s.memory ? { total: num(s.memory.total), used: num(s.memory.used), free: num(s.memory.free), available: num(s.memory.available), buffers: num(s.memory.buffers), cached: num(s.memory.cached) } : null,
            swap: s.swap ? { total: num(s.swap.total), used: num(s.swap.used), free: num(s.swap.free) } : null,
            rootfs: s.rootfs ? { total: num(s.rootfs.total), used: num(s.rootfs.used), free: num(s.rootfs.avail ?? s.rootfs.free) } : null,
            ksm: s.ksm ? { shared: num(s.ksm.shared) } : null,
            boot: s["boot-info"] ? { mode: text(s["boot-info"].mode), secureboot: s["boot-info"].secureboot === undefined ? null : s["boot-info"].secureboot === 1 || s["boot-info"].secureboot === "1" } : null,
            kernel: text(s.kversion, 400),
            kernelRelease: text(s["current-kernel"]?.release),
            machine: text(s["current-kernel"]?.machine),
            pveVersion: text(s.pveversion),
            uptime: num(s.uptime),
            pci: pci.data ? pci.data.map((d) => ({ id: String(d.id ?? ""), class: text(d.class), vendor: text(d.vendor), vendorName: text(d.vendor_name), device: text(d.device), deviceName: text(d.device_name), subsystemVendor: text(d.subsystem_vendor), subsystemDevice: text(d.subsystem_device), subsystemVendorName: text(d.subsystem_vendor_name), subsystemDeviceName: text(d.subsystem_device_name), iommuGroup: num(d.iommugroup) !== null && (d.iommugroup as number) >= 0 ? d.iommugroup : null, mdev: d.mdev === 1 || d.mdev === true })).filter((d) => d.id) : null,
            pciDenied: pci.denied,
            usb: usb.data ? usb.data.map((d) => ({ busnum: num(d.busnum), devnum: num(d.devnum), port: num(d.port), level: num(d.level), vendid: text(d.vendid), prodid: text(d.prodid), manufacturer: text(d.manufacturer), product: text(d.product), serial: text(d.serial), speed: text(String(d.speed ?? "")), usbpath: text(d.usbpath), class: num(d.class) })) : null,
            usbDenied: usb.denied,
            description: typeof cfg.data?.description === "string" ? cfg.data.description : "",
          };
        });
        c.json(200, out);
      },
    },
    // Mediated device (vGPU) types of one PCI device or mapping
    {
      method: "GET",
      re: /^\/api\/node\/hardware\/mdev$/,
      run: async (c) => {
        const id = query(c, "pci") ?? "";
        if (!PCI_ID.test(id) && !/^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(id)) bad("That isn't a PCI device");
        const types = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          return pve.call<Raw[]>("GET", `/nodes/${seg(node)}/hardware/pci/${seg(id)}/mdev`);
        });
        c.json(200, { types: types.map((t) => ({ type: String(t.type ?? ""), available: num(t.available), description: text(t.description, 1000), name: text(t.name) })) });
      },
    },

    // ---- Installed package versions (what `pveversion -v` prints)
    {
      method: "GET",
      re: /^\/api\/node\/versions$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const list = await pve.call<Raw[]>("GET", `/nodes/${seg(node)}/apt/versions`);
          const packages = list
            .map((p) => ({ package: String(p.Package ?? ""), version: text(p.Version, 100) ?? "", oldVersion: text(p.OldVersion, 100), state: text(p.CurrentState, 40), title: text(p.Title, 200), running: text(p.RunningKernel, 100), manager: text(p.ManagerVersion, 100) }))
            .filter((p) => p.package)
            .sort((a, b) => a.package.localeCompare(b.package));
          return { node, packages, running: packages.find((p) => p.running)?.running ?? null, manager: packages.find((p) => p.manager)?.manager ?? null };
        });
        c.json(200, out);
      },
    },

    // ---- Support report: the same text Proxmox support asks for, with its credentials already left out by Proxmox
    {
      method: "GET",
      re: /^\/api\/node\/report$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const report = await pve.call<string>("GET", `/nodes/${seg(node)}/report`);
          const full = typeof report === "string" ? report : "";
          return { node, truncated: full.length > MAX_REPORT, report: full.slice(0, MAX_REPORT) };
        });
        c.json(200, out);
      },
    },

    // ---- Node notes and options (description, boot delay, wake on LAN, location, ballooning target)
    {
      method: "GET",
      re: /^\/api\/node\/config$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const raw = await pve.call<Raw>("GET", `/nodes/${seg(node)}/config`);
          return { node, values: readGroup(DC_SCHEMAS.nodeConfig, raw), digest: typeof raw.digest === "string" ? raw.digest : null, schema: DC_SCHEMAS.nodeConfig };
        });
        c.json(200, out);
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/config$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(200_000);
        noExtra(body, ["node", "values", "digest"]);
        const checked = checkDc(DC_SCHEMAS.nodeConfig, (body.values ?? {}) as Record<string, unknown>);
        if (!Object.keys(checked.params).length && !checked.remove.length) bad("Nothing to change");
        const digest = typeof body.digest === "string" && /^[0-9a-f]{20,64}$/i.test(body.digest) ? body.digest : undefined;
        await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          await pve.call("PUT", `/nodes/${seg(node)}/config`, withDelete(checked, { digest }));
        });
        c.json(200, { ok: true });
      },
    },

    // ---- Raw exported metrics (Sys.Audit); bounded so a long history can't flood the page
    {
      method: "GET",
      re: /^\/api\/node\/metrics-export$/,
      run: async (c) => {
        const local = query(c, "local") === "1";
        const history = query(c, "history") === "1";
        const start = query(c, "since");
        if (start !== null && !/^\d{1,12}$/.test(start)) bad("since must be a UNIX time");
        const out = await c.asUser((pve) => pve.call<{ data?: Raw[] }>("GET", "/cluster/metrics/export", { "local-only": local ? 1 : undefined, history: history ? 1 : undefined, "start-time": start === null ? undefined : Number(start) }));
        const data = Array.isArray(out?.data) ? out.data : [];
        c.json(200, { count: data.length, truncated: data.length > 2000, metrics: data.slice(0, 2000).map((m) => ({ id: String(m.id ?? ""), metric: String(m.metric ?? ""), timestamp: num(m.timestamp), type: text(m.type, 20), value: num(m.value) })) });
      },
    },

    // ---- Schedule analyzer: the next runs of a calendar event
    {
      method: "GET",
      re: /^\/api\/node\/schedule$/,
      run: async (c) => {
        const schedule = query(c, "schedule") ?? "";
        if (!/^[A-Za-z0-9:*,./ -]{1,128}$/.test(schedule)) bad("That isn't a calendar event such as mon..fri 02:00");
        const n = query(c, "count");
        const iterations = n === null ? 10 : asNumber(Number(n), "count", 1, 30);
        const runs = await c.asUser((pve) => pve.call<{ timestamp?: number; utc?: string }[]>("GET", "/cluster/jobs/schedule-analyze", { schedule, iterations }));
        c.json(200, { runs: runs.map((r) => ({ at: num(r.timestamp) })).filter((r) => r.at !== null) });
      },
    },

    // ---- Resource totals and tree
    {
      method: "GET",
      re: /^\/api\/node\/resources$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const [res, pools] = await Promise.all([pve.call<Raw[]>("GET", "/cluster/resources"), soft(pve.call<Raw[]>("GET", "/pools"))]);
          const totals = { nodes: { online: 0, total: 0 }, cpu: { used: 0, total: 0 }, memory: { used: 0, total: 0 }, storage: { used: 0, total: 0 }, guests: { running: 0, stopped: 0, templates: 0, vms: 0, containers: 0 } };
          const seenShared = new Set<string>();
          const rows: Raw[] = [];
          for (const r of res) {
            const type = String(r.type ?? "");
            if (type === "node") {
              totals.nodes.total++;
              if (r.status === "online") {
                totals.nodes.online++;
                totals.cpu.used += (num(r.cpu) ?? 0) * (num(r.maxcpu) ?? 0);
                totals.cpu.total += num(r.maxcpu) ?? 0;
                totals.memory.used += num(r.mem) ?? 0;
                totals.memory.total += num(r.maxmem) ?? 0;
              }
            } else if (type === "storage") {
              const key = r.shared === 1 ? String(r.storage) : `${r.node}/${r.storage}`;
              if (!seenShared.has(key) && r.status === "available") {
                seenShared.add(key);
                totals.storage.used += num(r.disk) ?? 0;
                totals.storage.total += num(r.maxdisk) ?? 0;
              }
            } else if (type === "qemu" || type === "lxc") {
              if (r.template === 1) totals.guests.templates++;
              else {
                totals.guests[r.status === "running" ? "running" : "stopped"]++;
                totals.guests[type === "qemu" ? "vms" : "containers"]++;
              }
            }
            if (["node", "qemu", "lxc", "storage", "pool", "sdn"].includes(type)) {
              rows.push({ id: String(r.id ?? `${type}/${r.vmid ?? r.storage ?? r.node ?? r.pool}`), type, node: text(r.node, 64), vmid: num(r.vmid), name: text(r.name ?? r.storage ?? r.node ?? r.pool ?? r.sdn, 100), status: text(r.status, 30), template: r.template === 1, pool: text(r.pool, 100), tags: typeof r.tags === "string" && r.tags ? r.tags.split(/[;,]/).filter(Boolean).slice(0, 20) : [], cpu: num(r.cpu), maxcpu: num(r.maxcpu), mem: num(r.mem), maxmem: num(r.maxmem), disk: num(r.disk), maxdisk: num(r.maxdisk), uptime: num(r.uptime), lock: text(r.lock, 30), hastate: text(r.hastate, 30) });
            }
          }
          return { totals, rows, pools: (pools.data ?? []).map((p) => ({ pool: String(p.poolid ?? ""), comment: text(p.comment, 200) })).filter((p) => p.pool) };
        });
        c.json(200, out);
      },
    },

    // ---- Bulk guest actions on one node: start all, stop all, suspend all, migrate all
    {
      method: "POST",
      re: /^\/api\/node\/bulk\/(startall|stopall|suspendall|migrateall)$/,
      run: async (c, m) => {
        c.sameSite();
        const action = m[1] as "startall" | "stopall" | "suspendall" | "migrateall";
        const body = await c.readJson(50_000);
        const allowed = { startall: ["node", "vms", "force", "maxWorkers"], stopall: ["node", "vms", "forceStop", "timeout", "maxWorkers", "confirm"], suspendall: ["node", "vms", "maxWorkers", "confirm"], migrateall: ["node", "vms", "target", "withLocalDisks", "maxWorkers", "confirm"] }[action];
        noExtra(body, allowed);
        let vms: string | undefined;
        if (body.vms !== undefined && body.vms !== null) {
          const list = Array.isArray(body.vms) ? body.vms.map(String).join(",") : String(body.vms);
          if (list && (list.length > 2000 || !vmidList(list))) bad("Pick machines by number");
          vms = list || undefined;
        }
        const maxWorkers = body.maxWorkers === undefined || body.maxWorkers === null || body.maxWorkers === "" ? undefined : asNumber(body.maxWorkers, "Parallel tasks", 1, 64);
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          // Everything except start touches running machines: the node's name has to be typed.
          if (action !== "startall") confirmed(body, node, `${action === "stopall" ? "stopping" : action === "suspendall" ? "suspending" : "moving"} ${vms ? "the chosen machines" : "every machine"} on ${node}`);
          const base = { "max-workers": maxWorkers, vms };
          if (action === "startall") return pve.call<string>("POST", `/nodes/${seg(node)}/startall`, { ...base, force: body.force === true ? 1 : undefined });
          if (action === "stopall") {
            const timeout = body.timeout === undefined || body.timeout === null || body.timeout === "" ? undefined : asNumber(body.timeout, "Timeout", 0, 7200);
            return pve.call<string>("POST", `/nodes/${seg(node)}/stopall`, { ...base, "force-stop": body.forceStop === false ? 0 : undefined, timeout });
          }
          if (action === "suspendall") return pve.call<string>("POST", `/nodes/${seg(node)}/suspendall`, base);
          const target = typeof body.target === "string" && NODE_NAME.test(body.target) ? body.target : bad("Pick the node to move them to");
          if (target === node) bad("Pick a different node to move them to");
          const known = await pve.call<{ node: string; status?: string }[]>("GET", "/nodes");
          const t = known.find((n) => n.node === target);
          if (!t) bad(`This cluster has no node called ${target}`);
          if (t.status !== undefined && t.status !== "online") bad(`${target} is offline`);
          return pve.call<string>("POST", `/nodes/${seg(node)}/migrateall`, { ...base, target, "with-local-disks": body.withLocalDisks === true ? 1 : undefined });
        });
        c.json(202, { task });
      },
    },
  ];
}
