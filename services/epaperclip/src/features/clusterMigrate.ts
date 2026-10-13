import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import { asRecord, cidr, flag, intIn, knownNodes, requireNode, seg, storagePairs, vmidOf } from "./clusterCommon.ts";
import { bad, noExtra, query, soft, type Route } from "./nodeCommon.ts";

/**
 * Moving a machine to another node, and backing up machines that live on different nodes. A migration is a Proxmox
 * task on the node the machine is leaving; the console follows it with the task log. Machines managed by high
 * availability are moved by the HA manager instead (Proxmox refuses a direct migration), which queues the request and
 * has no task of its own.
 */

interface Found {
  vmid: number;
  node: string;
  type: "qemu" | "lxc";
  name: string;
  status: string;
  template: boolean;
  lock: string | null;
}

async function find(pve: ProxmoxClient, vmid: number): Promise<Found> {
  const all = await pve.call<Record<string, any>[]>("GET", "/cluster/resources", { type: "vm" });
  const g = all.find((r) => r.vmid === vmid && (r.type === "qemu" || r.type === "lxc"));
  if (!g) throw new HttpError(404, "not_found", `There is no machine ${vmid} in this cluster`);
  return { vmid, node: String(g.node), type: g.type, name: String(g.name ?? vmid), status: String(g.status ?? "unknown"), template: g.template === 1, lock: typeof g.lock === "string" ? g.lock : null };
}

const haSidOf = (g: Found) => `${g.type === "lxc" ? "ct" : "vm"}:${g.vmid}`;

const reasons = (info: Record<string, any>): string[] => {
  const out: string[] = [];
  const storages = Array.isArray(info.unavailable_storages) ? info.unavailable_storages : [];
  if (storages.length) out.push(`Storage ${storages.join(", ")} isn't available there`);
  for (const r of Array.isArray(info["blocking-ha-resources"]) ? info["blocking-ha-resources"] : []) {
    out.push(r.cause === "resource-affinity" ? `${r.sid} must stay apart from this machine (HA resource rule)` : `${r.sid} is restricted by an HA node rule`);
  }
  return out;
};

export function clusterMigrateRoutes(): Route[] {
  return [
    {
      method: "GET",
      re: /^\/api\/cluster\/migrate\/(\d+)$/,
      run: async (c, m) => {
        const vmid = vmidOf(m[1]);
        const wanted = query(c, "target");
        const out = await c.asUser(async (pve) => {
          const g = await find(pve, vmid);
          const nodes = await knownNodes(pve);
          const target = wanted ? requireNode(wanted, nodes) : undefined;
          const [pre, ha] = await Promise.all([
            soft(pve.call<Record<string, any>>("GET", `/nodes/${seg(g.node)}/${g.type}/${vmid}/migrate`, target ? { target } : undefined)),
            soft(pve.call<Record<string, any>[]>("GET", "/cluster/ha/resources")),
          ]);
          if (pre.denied) throw new HttpError(403, "forbidden", "Your Proxmox account doesn't have permission to migrate this machine (it needs VM.Migrate)");
          const info = asRecord(pre.data);
          const allowed = new Set<string>((info.allowed_nodes ?? info["allowed-nodes"] ?? []) as string[]);
          const notAllowed = asRecord(info.not_allowed_nodes ?? info["not-allowed-nodes"]);
          const resource = (ha.data ?? []).find((r) => r.sid === haSidOf(g));
          const running = g.status === "running";
          return {
            vmid,
            name: g.name,
            type: g.type,
            node: g.node,
            status: g.status,
            running,
            template: g.template,
            locked: g.lock,
            targets: nodes.filter((n) => n.node !== g.node).map((n) => ({
              node: n.node,
              online: n.status === "online",
              allowed: n.status === "online" && !(n.node in notAllowed) && (allowed.size === 0 || allowed.has(n.node)),
              reasons: n.status !== "online" ? ["The node is offline"] : n.node in notAllowed ? reasons(asRecord(notAllowed[n.node])) : [],
            })),
            localDisks: ((info.local_disks ?? []) as Record<string, any>[]).map((d) => ({ volid: String(d.volid), size: typeof d.size === "number" ? d.size : null, cdrom: flag(d.cdrom), unused: flag(d.is_unused) })),
            localResources: ((info.local_resources ?? []) as string[]).map(String),
            mappedResources: Object.keys(asRecord(info["mapped-resource-info"])).length ? Object.entries(asRecord(info["mapped-resource-info"])).map(([id, v]) => ({ id, liveMigration: flag(asRecord(v)["live-migration"]) })) : ((info["mapped-resources"] ?? []) as string[]).map((id) => ({ id: String(id), liveMigration: false })),
            dependentHa: ((info["dependent-ha-resources"] ?? []) as string[]).map(String),
            conntrack: flag(info["has-dbus-vmstate"]),
            ha: resource ? { sid: String(resource.sid), state: String(resource.state ?? "started") } : null,
            modes: g.type === "qemu"
              ? { online: running, offline: true, localDisks: true, restart: false }
              : { online: running, offline: !running, localDisks: false, restart: running },
          };
        });
        c.json(200, out);
      },
    },
    {
      // Storages on the target that can hold this machine's disks, for choosing where local disks land.
      method: "GET",
      re: /^\/api\/cluster\/migrate\/(\d+)\/storages$/,
      run: async (c, m) => {
        const vmid = vmidOf(m[1]);
        const out = await c.asUser(async (pve) => {
          const g = await find(pve, vmid);
          const target = requireNode(query(c, "target"), await knownNodes(pve));
          const list = await pve.call<Record<string, any>[]>("GET", `/nodes/${seg(target)}/storage`, { content: g.type === "lxc" ? "rootdir" : "images", enabled: true });
          return { storages: list.map((s) => ({ storage: String(s.storage), type: String(s.type ?? ""), shared: flag(s.shared), avail: typeof s.avail === "number" ? s.avail : null, total: typeof s.total === "number" ? s.total : null })).sort((a, b) => a.storage.localeCompare(b.storage)) };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/cluster\/migrate\/(\d+)$/,
      run: async (c, m) => {
        c.sameSite();
        const vmid = vmidOf(m[1]);
        const body = await c.readJson(10_000);
        noExtra(body, ["target", "online", "restart", "withLocalDisks", "targetStorage", "bwlimit", "timeout", "force", "confirm", "migrationType", "migrationNetwork", "withConntrackState"]);
        for (const k of ["online", "restart", "withLocalDisks", "force", "withConntrackState"]) if (body[k] !== undefined && typeof body[k] !== "boolean") bad(`${k} is on or off`);
        const out = await c.asUser(async (pve) => {
          const g = await find(pve, vmid);
          const nodes = await knownNodes(pve);
          const target = requireNode(body.target, nodes);
          if (target === g.node) throw new HttpError(409, "same_node", `${g.name} is already on ${target}`);
          if (nodes.find((n) => n.node === target)?.status !== "online") throw new HttpError(409, "node_offline", `${target} is offline`);
          if (g.lock) throw new HttpError(409, "locked", `${g.name} is locked (${g.lock}); wait for what is using it to finish`);
          const running = g.status === "running";
          if (body.online === true && !running) throw new HttpError(409, "not_running", `${g.name} isn't running, so it can only be moved while off`);
          if (body.restart === true && (g.type !== "lxc" || !running)) bad("Restart migration only applies to a running container");
          if (body.online === true && body.restart === true) bad("Choose online or restart, not both");
          if (body.withLocalDisks !== undefined && g.type !== "qemu") bad("Moving local disks while running only applies to virtual machines");
          if (g.type === "lxc" && body.migrationType !== undefined) bad("The migration type only applies to virtual machines");
          const bw = body.bwlimit === undefined || body.bwlimit === null || body.bwlimit === "" ? undefined : intIn(body.bwlimit, 0, 1_000_000_000, "The bandwidth limit");
          const storage = body.targetStorage === undefined || body.targetStorage === null || body.targetStorage === "" ? undefined : storagePairs(body.targetStorage);
          if (body.force === true && body.confirm !== String(vmid)) throw new HttpError(400, "confirm", `Type “${vmid}” to migrate despite local devices`);
          const ha = (await soft(pve.call<Record<string, any>[]>("GET", "/cluster/ha/resources"))).data?.find((r) => r.sid === haSidOf(g));
          if (ha) {
            if (storage || body.withLocalDisks || body.force) throw new HttpError(409, "ha_managed", `${g.name} is managed by high availability, and the HA manager moves it without these options. Remove it from HA first to use them.`);
            // Online moves keep it running; the HA manager relocates (stop, start) everything else.
            const how = (body.online === true || (body.online === undefined && running && g.type === "qemu")) ? "migrate" : "relocate";
            await pve.call("POST", `/cluster/ha/resources/${seg(haSidOf(g))}/${how}`, { node: target });
            return { queued: true as const, ha: haSidOf(g), how, node: g.node };
          }
          const common = { target, bwlimit: bw };
          let task: string;
          if (g.type === "qemu") {
            task = await pve.call<string>("POST", `/nodes/${seg(g.node)}/qemu/${vmid}/migrate`, {
              ...common,
              online: running ? body.online !== false : undefined,
              "with-local-disks": body.withLocalDisks === true ? true : undefined,
              targetstorage: storage,
              force: body.force === true ? true : undefined,
              migration_type: body.migrationType === undefined ? undefined : body.migrationType === "secure" || body.migrationType === "insecure" ? (body.migrationType as string) : bad("The migration type is secure or insecure"),
              migration_network: body.migrationNetwork === undefined || body.migrationNetwork === "" ? undefined : cidr(body.migrationNetwork),
              "with-conntrack-state": body.withConntrackState === true ? true : undefined,
            });
          } else {
            task = await pve.call<string>("POST", `/nodes/${seg(g.node)}/lxc/${vmid}/migrate`, {
              ...common,
              online: body.online === true ? true : undefined,
              restart: running && body.online !== true ? true : undefined,
              "target-storage": storage,
              timeout: body.timeout === undefined ? undefined : intIn(body.timeout, 1, 3600, "The shutdown timeout"),
            });
          }
          return { queued: false as const, task, node: g.node };
        });
        c.json(200, out);
      },
    },

    // ---- Backing up machines that live on different nodes
    {
      method: "POST",
      re: /^\/api\/cluster\/backup\/run$/,
      run: async (c) => {
        c.sameSite();
        const b = await c.readJson(20_000);
        noExtra(b, ["all", "vmids", "storage", "mode", "notes"]);
        const all = b.all === true;
        const vmids = all ? [] : Array.isArray(b.vmids) && b.vmids.length >= 1 && b.vmids.length <= 500 ? b.vmids.map((v: unknown) => vmidOf(v)) : bad("Pick the machines to back up");
        const mode = b.mode === undefined ? "snapshot" : ["snapshot", "suspend", "stop"].includes(String(b.mode)) ? String(b.mode) : bad("Unknown backup mode");
        const storage = typeof b.storage === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,254}$/.test(b.storage) ? b.storage : bad("Pick where to keep the backups");
        const notes = b.notes === undefined || b.notes === "" ? "{{guestname}}" : typeof b.notes === "string" && b.notes.length <= 200 && !/[\r\n]/.test(b.notes) ? b.notes : bad("Keep the note to one line");
        const out = await c.asUser(async (pve) => {
          const nodes = await knownNodes(pve);
          const res = await pve.call<Record<string, any>[]>("GET", "/cluster/resources", { type: "vm" });
          const groups = new Map<string, number[]>();
          if (all) {
            for (const n of nodes) if (n.status === "online") groups.set(n.node, []);
          } else {
            for (const id of vmids as number[]) {
              const g = res.find((r) => r.vmid === id && (r.type === "qemu" || r.type === "lxc"));
              if (!g) throw new HttpError(404, "not_found", `There is no machine ${id} in this cluster`);
              if (nodes.find((n) => n.node === g.node)?.status !== "online") throw new HttpError(409, "node_offline", `${g.name ?? id} is on ${g.node}, which is offline`);
              groups.set(String(g.node), [...(groups.get(String(g.node)) ?? []), id]);
            }
          }
          const tasks: { node: string; task: string; vmids: number[] }[] = [];
          for (const [node, ids] of groups) {
            const task = await pve.vzdump(node, { all: all ? true : undefined, vmid: all ? undefined : ids.join(","), storage, mode, compress: "zstd", "notes-template": notes });
            tasks.push({ node, task, vmids: ids });
          }
          return { tasks };
        });
        c.json(200, out);
      },
    },
  ];
}
