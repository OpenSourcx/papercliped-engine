import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import { asRecord, cidr, flag, intIn, seg } from "./clusterCommon.ts";
import { DEVICE_RE } from "./disksCheck.ts";
import { bad, confirmed, noExtra, resolveNode, soft, type Route } from "./nodeCommon.ts";

/**
 * Ceph, the writes. Everything here changes what the cluster stores, so each step asks Proxmox whether it is safe
 * first (`cmd-safety`), refuses what Proxmox or arithmetic says would lose data, and needs the thing it touches typed.
 *
 *   OSD create (wipes the drive) and destroy, pool delete, monitor / manager / metadata server create and destroy,
 *   CephFS create and destroy, start / stop / restart of services, initial configuration, and the CRUSH map to read.
 *
 * Installing the Ceph packages is not an API call at all (Proxmox's own screen runs `pveceph install` in a shell), so
 * that step is a guide with a command to copy.
 */

type Json = Record<string, any>;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const SERVICE = /^(ceph\.target|(osd|mon|mds|mgr)\.[A-Za-z0-9][A-Za-z0-9._-]{0,62})$/;
const CLASS = /^[a-z][a-z0-9_-]{0,30}$/;

const devicePath = (v: unknown, what: string): string => (typeof v === "string" && DEVICE_RE.test(v) ? v : bad(`${what}: pick a drive from the list`));
const name = (v: unknown, what: string): string => (typeof v === "string" && NAME.test(v) ? v : bad(`${what} uses letters, numbers, . _ and - (up to 63 characters)`));
const gib = (v: unknown, min: number, what: string): number => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= 100_000 ? v : bad(`${what} is a number of GiB, at least ${min}`));

/** What Ceph itself says about stopping or destroying a daemon. Proxmox without the endpoint (older) says nothing. */
export async function safety(pve: ProxmoxClient, node: string, service: "osd" | "mon" | "mds", id: string, action: "stop" | "destroy"): Promise<{ checked: boolean; safe: boolean; reason: string | null }> {
  try {
    const r = asRecord(await pve.call<unknown>("GET", `/nodes/${seg(node)}/ceph/cmd-safety`, { action, id, service }));
    const safe = r.safe === undefined ? flag(r.ok) || r.status === "ok" : flag(r.safe);
    const reason = [r.status, r.message, r.reason].find((x) => typeof x === "string" && x && x !== "ok") as string | undefined;
    return { checked: true, safe, reason: safe ? null : (reason ?? "Ceph says this is not safe right now").slice(0, 300) };
  } catch (e) {
    if (e instanceof ProxmoxError && (e.status === 403 || e.status === 401)) throw e;
    return { checked: false, safe: true, reason: null };
  }
}

const unsafe = (r: { safe: boolean; reason: string | null }, body: Json, what: string) => {
  if (!r.safe && body.acknowledgeUnsafe !== true) throw new HttpError(409, "unsafe", `Ceph says ${what} is not safe: ${r.reason}. Fix that first, or confirm you understand the risk.`);
};

export function clusterCephWriteRoutes(): Route[] {
  return [
    // ---- Releases and initial configuration
    {
      method: "GET",
      re: /^\/api\/cluster\/ceph\/setup$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const rel = await soft(pve.call<Json[]>("GET", `/nodes/${seg(node)}/ceph/releases`));
          const status = await soft(pve.call<Json>("GET", `/nodes/${seg(node)}/ceph/status`));
          const releases = (rel.data ?? []).map((r) => ({ name: String(r.release ?? r.name ?? ""), version: typeof r.version === "string" ? r.version : null, installable: r.installable === undefined && r["can-install"] === undefined ? null : flag(r.installable ?? r["can-install"]) })).filter((r) => r.name);
          const installed = !status.error && !status.denied && status.data !== null;
          const choice = releases.find((r) => r.installable !== false) ?? releases[0] ?? null;
          return {
            node,
            installed,
            releases,
            denied: rel.denied,
            // Installing packages is a shell step in Proxmox too; the command is for the person to run on the node.
            installCommand: `pveceph install --repository no-subscription${choice ? ` --version ${choice.name}` : ""}`,
            initCommand: "pveceph init --network <CIDR>",
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/cluster\/ceph\/init$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "network", "clusterNetwork", "size", "minSize", "disableCephx", "confirmCephx", "confirm"]);
        confirmed(body, "ceph", "writing the first Ceph configuration");
        const network = body.network === undefined || body.network === "" ? undefined : cidr(body.network);
        const clusterNetwork = body.clusterNetwork === undefined || body.clusterNetwork === "" ? undefined : cidr(body.clusterNetwork);
        const size = body.size === undefined ? undefined : intIn(body.size, 2, 7, "Copies per object");
        const minSize = body.minSize === undefined ? undefined : intIn(body.minSize, 1, 7, "Minimum copies");
        if (size !== undefined && minSize !== undefined && minSize > size) bad("The minimum number of copies can't be more than the number of copies");
        // Cephx is what stops any machine on the network from reading and writing the cluster.
        if (body.disableCephx === true) confirmed({ confirm: body.confirmCephx }, "disable cephx", "turning Ceph authentication off");
        await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          await pve.call("POST", `/nodes/${seg(node)}/ceph/init`, { network, "cluster-network": clusterNetwork, size, min_size: minSize, disable_cephx: body.disableCephx === true ? true : undefined });
        });
        c.json(200, { ok: true });
      },
    },

    // ---- OSDs: create and destroy
    {
      method: "POST",
      re: /^\/api\/cluster\/ceph\/osds$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "dev", "dbDev", "walDev", "dbSizeGiB", "walSizeGiB", "encrypted", "perDevice", "deviceClass", "confirm"]);
        const dev = devicePath(body.dev, "The drive");
        // Creating an OSD erases the drive, so its name is typed the same way as Wipe in Disks.
        if (body.confirm !== dev && body.confirm !== dev.replace(/^\/dev\//, "")) throw new HttpError(400, "confirm", `Type “${dev.replace(/^\/dev\//, "")}” to confirm erasing it`);
        const dbDev = body.dbDev === undefined || body.dbDev === "" ? undefined : devicePath(body.dbDev, "The database drive");
        const walDev = body.walDev === undefined || body.walDev === "" ? undefined : devicePath(body.walDev, "The log drive");
        if ([dev, dbDev, walDev].filter(Boolean).length !== new Set([dev, dbDev, walDev].filter(Boolean)).size) bad("Each of the drives has to be a different one");
        const dbSize = body.dbSizeGiB === undefined ? undefined : gib(body.dbSizeGiB, 1, "The database size");
        const walSize = body.walSizeGiB === undefined ? undefined : gib(body.walSizeGiB, 0.5, "The log size");
        const perDevice = body.perDevice === undefined ? undefined : intIn(body.perDevice, 1, 16, "OSDs per drive");
        const deviceClass = body.deviceClass === undefined || body.deviceClass === "" ? undefined : typeof body.deviceClass === "string" && CLASS.test(body.deviceClass) ? body.deviceClass : bad("A device class is a short lowercase word such as ssd, hdd or nvme");
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          // The same refusal as Disks: a drive that holds something else is not offered to Ceph.
          const disks = await pve.call<Json[]>("GET", `/nodes/${seg(node)}/disks/list`);
          const d = disks.find((x) => x.devpath === dev);
          if (d && (d.mounted === true || /efi|bios boot|mounted|lvm|zfs|device mapper/i.test(String(d.used ?? "")))) throw new HttpError(409, "in_use", `${dev} is in use (${String(d.used ?? "mounted")}). Free it first in Disks.`);
          return pve.call<string>("POST", `/nodes/${seg(node)}/ceph/osd`, { dev, db_dev: dbDev, wal_dev: walDev, db_dev_size: dbSize, wal_dev_size: walSize, encrypted: body.encrypted === true ? true : undefined, "osds-per-device": perDevice, "crush-device-class": deviceClass });
        });
        c.json(200, { task });
      },
    },
    {
      method: "POST",
      re: /^\/api\/cluster\/ceph\/osd\/(\d+)\/destroy$/,
      run: async (c, m) => {
        c.sameSite();
        const id = intIn(m[1], 0, 100_000, "The OSD number");
        const body = await c.readJson();
        noExtra(body, ["node", "cleanup", "confirm", "acknowledgeUnsafe"]);
        confirmed(body, `osd.${id}`, `destroying osd.${id} and giving up its data`);
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          // Proxmox refuses an OSD that is up or in; say so first, in words, instead of passing its raw refusal on.
          const tree = asRecord(await pve.call<unknown>("GET", `/nodes/${seg(node)}/ceph/osd`));
          const found = findOsd(tree.root as Json | undefined, id);
          if (!found) throw new HttpError(404, "no_osd", `This node has no osd.${id}. Open Ceph on the node that holds the drive.`);
          if (found.status === "up" || flag(found.in)) throw new HttpError(409, "not_ready", `osd.${id} is still ${found.status === "up" ? "running" : "in the cluster"}. Take it out and stop it first, then wait until Ceph has moved its data (health OK).`);
          unsafe(await safety(pve, node, "osd", String(id), "destroy"), body, `destroying osd.${id}`);
          return pve.call<string>("DELETE", `/nodes/${seg(node)}/ceph/osd/${id}`, { cleanup: body.cleanup === true ? true : undefined });
        });
        c.json(200, { task });
      },
    },

    // ---- Pools: delete
    {
      method: "POST",
      re: /^\/api\/cluster\/ceph\/pools\/([^/]+)\/delete$/,
      run: async (c, m) => {
        c.sameSite();
        const pool = name(decodeURIComponent(m[1]), "A pool name");
        const body = await c.readJson();
        noExtra(body, ["node", "confirm", "acknowledgeData", "force", "removeStorages", "removeEcProfile"]);
        confirmed(body, pool, `deleting the pool ${pool} and everything in it`);
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          const st = await soft(pve.call<Json>("GET", `/nodes/${seg(node)}/ceph/pool/${seg(pool)}/status`));
          const used = typeof asRecord(st.data).bytes_used === "number" ? (asRecord(st.data).bytes_used as number) : null;
          // A pool that holds data needs a second, deliberate yes: the data cannot be brought back.
          if ((used === null || used > 0) && body.acknowledgeData !== true) throw new HttpError(409, "has_data", used === null ? `Ceph didn't say whether ${pool} holds data. Confirm you want it destroyed anyway.` : `${pool} still holds data. Deleting it destroys that data for good.`);
          return pve.call<string>("DELETE", `/nodes/${seg(node)}/ceph/pool/${seg(pool)}`, { force: body.force === true ? true : undefined, remove_storages: body.removeStorages === true ? true : undefined, remove_ecprofile: body.removeEcProfile === false ? false : undefined });
        });
        c.json(200, { task });
      },
    },

    // ---- Monitors, managers, metadata servers
    {
      method: "POST",
      re: /^\/api\/cluster\/ceph\/(mon|mgr|mds)$/,
      run: async (c, m) => {
        c.sameSite();
        const kind = m[1] as "mon" | "mgr" | "mds";
        const body = await c.readJson();
        noExtra(body, ["node", "id", "address", "hotStandby"]);
        const id = body.id === undefined || body.id === "" ? undefined : name(body.id, "The name");
        const address = body.address === undefined || body.address === "" ? undefined : typeof body.address === "string" && body.address.length <= 200 && body.address.split(",").every((a) => /^[0-9a-fA-F:.]+$/.test(a.trim())) ? body.address.trim() : bad("Enter monitor addresses as IP addresses, separated by commas");
        if (address && kind !== "mon") bad("Only monitors take an address");
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          const target = id ?? node;
          const path = `/nodes/${seg(node)}/ceph/${kind}/${seg(target)}`;
          if (kind === "mon") return pve.call<string>("POST", path, { "mon-address": address });
          if (kind === "mgr") return pve.call<string>("POST", path);
          return pve.call<string>("POST", path, { hotstandby: body.hotStandby === true ? true : undefined });
        });
        c.json(200, { task });
      },
    },
    {
      method: "POST",
      re: /^\/api\/cluster\/ceph\/(mon|mgr|mds)\/([^/]+)\/destroy$/,
      run: async (c, m) => {
        c.sameSite();
        const kind = m[1] as "mon" | "mgr" | "mds";
        const id = name(decodeURIComponent(m[2]), "The name");
        const body = await c.readJson();
        noExtra(body, ["node", "confirm", "acknowledgeUnsafe"]);
        confirmed(body, `${kind}.${id}`, `removing ${kind}.${id}`);
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          if (kind === "mon") {
            // Quorum needs a majority of the monitors; removing one must leave enough running.
            const mons = (await soft(pve.call<Json[]>("GET", `/nodes/${seg(node)}/ceph/mon`))).data ?? [];
            const left = mons.filter((x) => String(x.name) !== id);
            const inQuorum = left.filter((x) => x.quorum === undefined || flag(x.quorum)).length;
            if (mons.length && left.length === 0) throw new HttpError(409, "last_monitor", "This is the last monitor. Without one, Ceph cannot work at all.");
            if (mons.length > 1 && inQuorum < Math.floor(left.length / 2) + 1) throw new HttpError(409, "quorum", `Removing ${id} would leave ${inQuorum} of ${left.length} monitors answering, which is not a majority. Ceph would stop. Bring the others back first.`);
            unsafe(await safety(pve, node, "mon", id, "destroy"), body, `removing mon.${id}`);
          }
          if (kind === "mds") unsafe(await safety(pve, node, "mds", id, "destroy"), body, `removing mds.${id}`);
          if (kind === "mgr") {
            const mgrs = (await soft(pve.call<Json[]>("GET", `/nodes/${seg(node)}/ceph/mgr`))).data ?? [];
            if (mgrs.length === 1 && String(mgrs[0].name) === id && body.acknowledgeUnsafe !== true) throw new HttpError(409, "last_manager", "This is the only manager. Statistics and the dashboard stop until another is created.");
          }
          return pve.call<string>("DELETE", `/nodes/${seg(node)}/ceph/${kind}/${seg(id)}`);
        });
        c.json(200, { task });
      },
    },

    // ---- CephFS
    {
      method: "POST",
      re: /^\/api\/cluster\/ceph\/fs$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "name", "pgNum", "addStorage"]);
        const fs = body.name === undefined || body.name === "" ? "cephfs" : name(body.name, "The file system name");
        const pgNum = body.pgNum === undefined ? undefined : intIn(body.pgNum, 8, 32768, "Placement groups");
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          const mds = (await soft(pve.call<Json[]>("GET", `/nodes/${seg(node)}/ceph/mds`))).data ?? [];
          if (!mds.length) throw new HttpError(409, "no_mds", "A file system needs a metadata server. Create one first (Services).");
          return pve.call<string>("POST", `/nodes/${seg(node)}/ceph/fs/${seg(fs)}`, { pg_num: pgNum, "add-storage": body.addStorage === true ? true : undefined });
        });
        c.json(200, { task });
      },
    },
    {
      method: "POST",
      re: /^\/api\/cluster\/ceph\/fs\/([^/]+)\/destroy$/,
      run: async (c, m) => {
        c.sameSite();
        const fs = name(decodeURIComponent(m[1]), "The file system name");
        const body = await c.readJson();
        noExtra(body, ["node", "confirm", "removePools", "removeStorages", "acknowledgeData"]);
        confirmed(body, fs, `destroying the file system ${fs}`);
        // Taking the pools along destroys every file in the file system.
        if (body.removePools === true && body.acknowledgeData !== true) throw new HttpError(409, "has_data", `Removing the pools of ${fs} destroys its files for good. Confirm that too.`);
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          return pve.call<string>("DELETE", `/nodes/${seg(node)}/ceph/fs/${seg(fs)}`, { "remove-pools": body.removePools === true ? true : undefined, "remove-storages": body.removeStorages === true ? true : undefined });
        });
        c.json(200, { task });
      },
    },

    // ---- Service start, stop, restart
    {
      method: "POST",
      re: /^\/api\/cluster\/ceph\/service\/(start|stop|restart)$/,
      run: async (c, m) => {
        c.sameSite();
        const action = m[1] as "start" | "stop" | "restart";
        const body = await c.readJson();
        noExtra(body, ["node", "service", "confirm", "acknowledgeUnsafe"]);
        const service = typeof body.service === "string" && SERVICE.test(body.service) ? body.service : bad("Pick a Ceph service such as osd.1, mon.pve or ceph.target");
        // Stopping interrupts storage; a restart drops it for a moment. Starting changes nothing that was running.
        if (action !== "start") confirmed(body, service, `${action === "stop" ? "stopping" : "restarting"} ${service}`);
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          const d = service.match(/^(osd|mon|mds)\.(.+)$/);
          if (d && action !== "start") unsafe(await safety(pve, node, d[1] as "osd" | "mon" | "mds", d[2], "stop"), body, `${action === "stop" ? "stopping" : "restarting"} ${service}`);
          return pve.call<string | null>("POST", `/nodes/${seg(node)}/ceph/${action}`, { service });
        });
        c.json(200, { task: task ?? null });
      },
    },

    // ---- CRUSH map, to read
    {
      method: "GET",
      re: /^\/api\/cluster\/ceph\/crush$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const r = await soft(pve.call<unknown>("GET", `/nodes/${seg(node)}/ceph/crush`));
          const text = typeof r.data === "string" ? r.data.slice(0, 400_000) : null;
          return { node, denied: r.denied, error: r.error, text, summary: text ? crushSummary(text) : null };
        });
        c.json(200, out);
      },
    },
  ];
}

function findOsd(root: Json | undefined, id: number): Json | null {
  if (!root) return null;
  const walk = (n: Json): Json | null => {
    if (n.type === "osd" && Number(n.id) === id) return n;
    for (const ch of (n.children ?? []) as Json[]) {
      const r = walk(ch);
      if (r) return r;
    }
    return null;
  };
  return walk(root);
}

/** The readable parts of a decompiled CRUSH map: its rules and bucket count, so the page can show more than a wall of text. */
export function crushSummary(text: string): { rules: { name: string; type: string | null; steps: string[] }[]; buckets: number; devices: number; tunables: string[] } {
  const rules: { name: string; type: string | null; steps: string[] }[] = [];
  const re = /^rule\s+(\S+)\s*\{([\s\S]*?)^\}/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const body = m[2];
    rules.push({ name: m[1], type: body.match(/^\s*type\s+(\S+)/m)?.[1] ?? null, steps: [...body.matchAll(/^\s*step\s+(.+)$/gm)].map((s) => s[1].trim()) });
  }
  return {
    rules,
    buckets: (text.match(/^(host|root|rack|chassis|row|pdu|pod|room|datacenter|zone|region|osd)\s+\S+\s*\{/gm) ?? []).filter((l) => !l.startsWith("osd")).length,
    devices: (text.match(/^device\s+\d+/gm) ?? []).length,
    tunables: [...text.matchAll(/^tunable\s+(.+)$/gm)].map((t) => t[1].trim()).slice(0, 20),
  };
}
