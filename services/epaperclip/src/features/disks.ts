import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { STORAGE_DEFS, SECRET_KEYS, STORAGE_ID_RE, buildStorageParams, parseBwlimit, parsePrune, storageDef, type StorageTypeDef } from "@papercliped-engine/proxmox-client/storage-schema";
import type { FeatureCtx, FeatureHandler } from "./index.ts";
import { handleGuestDisks } from "./disksGuest.ts";
import { CheckError, device, diskInUse, matchesDevice, storageName, zfsSpec } from "./disksCheck.ts";

/**
 * Physical disks, storage created on them, storage definitions (Datacenter -> Storage) and per-machine disks. Proxmox
 * decides who may do what; this file validates input first, enforces typed confirmation for anything destructive and
 * never returns or logs a secret.
 */

type Json = Record<string, unknown>;
const POOL_NAME = /^[A-Za-z0-9][\w.+-]{0,127}$/;
const KINDS = ["directory", "lvm", "lvmthin", "zfs"] as const;
type Kind = (typeof KINDS)[number];

const seg = encodeURIComponent;
const task = (t: unknown) => (typeof t === "string" && t.startsWith("UPID:") ? t : null);

interface RawDisk {
  devpath: string;
  size: number;
  type?: string;
  model?: string;
  serial?: string;
  vendor?: string;
  wwn?: string;
  used?: string;
  mounted?: boolean;
  gpt?: boolean;
  health?: string;
  wearout?: number | string;
  rpm?: number;
  parent?: string;
}

export function mapDisk(d: RawDisk) {
  const wear = d.wearout === undefined || d.wearout === "N/A" ? null : Number(d.wearout);
  return {
    devpath: d.devpath,
    name: d.devpath.replace(/^\/dev\//, ""),
    type: d.type ?? "unknown",
    sizeBytes: d.size,
    model: d.model ?? null,
    vendor: d.vendor?.trim() || null,
    serial: d.serial ?? null,
    wwn: d.wwn ?? null,
    usedBy: d.used && d.used !== "unused" ? d.used : null,
    mounted: d.mounted === true,
    gpt: d.gpt === true,
    health: d.health ?? null,
    // Proxmox reports the wear it has left as a percentage "used"; 100 minus that is life remaining.
    wearoutPct: wear !== null && Number.isFinite(wear) ? wear : null,
    rpm: typeof d.rpm === "number" ? d.rpm : null,
    parent: d.parent ?? null,
    inUseReason: diskInUse({ used: d.used, mounted: d.mounted }),
  };
}

const listDisks = async (pve: ProxmoxClient, node: string, partitions = false) =>
  (await pve.call<RawDisk[]>("GET", `/nodes/${seg(node)}/disks/list`, partitions ? { "include-partitions": true } : {})).map(mapDisk);

/** What a storage definition looks like to the console: no secret ever, only whether one is set. */
export function publicStorage(raw: Json) {
  const type = String(raw.type ?? "");
  const config: Json = {};
  const secretsSet: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if ((SECRET_KEYS as readonly string[]).includes(k)) {
      if (v !== undefined && v !== "") secretsSet.push(k);
      continue;
    }
    if (["storage", "type", "digest", "content", "nodes", "disable", "shared", "prune-backups", "bwlimit"].includes(k)) continue;
    config[k] = v;
  }
  const list = (v: unknown) => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
  return {
    id: String(raw.storage ?? ""),
    type,
    content: list(raw.content),
    nodes: list(raw.nodes),
    enabled: !(raw.disable === 1 || raw.disable === true || raw.disable === "1"),
    shared: raw.shared === 1 || raw.shared === true || raw.shared === "1" || !!storageDef(type)?.alwaysShared,
    prune: raw["prune-backups"] !== undefined ? parsePrune(raw["prune-backups"]) : null,
    bwlimit: raw.bwlimit !== undefined ? parseBwlimit(raw.bwlimit) : null,
    config,
    secretsSet,
    digest: typeof raw.digest === "string" ? raw.digest : null,
  };
}

function defFor(type: unknown): StorageTypeDef {
  const d = typeof type === "string" ? storageDef(type) : undefined;
  if (!d) throw new CheckError("Pick a storage type from the list");
  return d;
}

const hostName = /^[A-Za-z0-9]([A-Za-z0-9.:-]{0,250})$/;

export const handleDisks: FeatureHandler = async (ctx: FeatureCtx) => {
  const { method, path } = ctx;
  if (!path.startsWith("/api/disks") && !path.startsWith("/api/storage-config") && !/^\/api\/storage\/[^/]+\/attributes$/.test(path) && !/^\/api\/guests\/\d+\/disks/.test(path)) return false;
  try {
    return await route(ctx, method, path);
  } catch (e) {
    if (e instanceof CheckError) throw new ctx.HttpError(400, "bad_request", e.message);
    throw e;
  }
};

async function route(ctx: FeatureCtx, method: string, path: string): Promise<boolean> {
  const node = ctx.node;
  const { HttpError } = ctx;
  const q = ctx.url.searchParams;

  if (/^\/api\/guests\/\d+\/disks/.test(path)) return handleGuestDisks(ctx);

  // ---- Physical disks
  if (method === "GET" && path === "/api/disks/list") {
    const disks = await ctx.asUser((pve) => listDisks(pve, node, q.get("partitions") === "1"));
    return ctx.json(200, { node, disks }), true;
  }
  if (method === "GET" && path === "/api/disks/smart") {
    const dev = device(q.get("disk"));
    const smart = await ctx.asUser((pve) => pve.call<Json>("GET", `/nodes/${seg(node)}/disks/smart`, { disk: dev }));
    return ctx.json(200, { disk: dev, health: smart.health ?? null, type: smart.type ?? null, text: typeof smart.text === "string" ? smart.text.slice(0, 20000) : null, attributes: Array.isArray(smart.attributes) ? smart.attributes : [] }), true;
  }
  if (method === "POST" && (path === "/api/disks/initgpt" || path === "/api/disks/wipe")) {
    ctx.sameSite();
    const b = await ctx.readJson();
    const dev = device(b.disk);
    if (!matchesDevice(b.confirm, dev)) throw new HttpError(409, "confirm", `Type the disk's name (${dev.replace(/^\/dev\//, "")}) to confirm.`);
    const t = await ctx.asUser(async (pve) => {
      const found = (await listDisks(pve, node, true)).find((d) => d.devpath === dev);
      if (!found) throw new HttpError(404, "not_found", "Proxmox doesn't list that disk");
      if (found.inUseReason) throw new HttpError(409, "in_use", `${found.name} can't be ${path.endsWith("wipe") ? "wiped" : "initialized"}: ${found.inUseReason}.`);
      return path.endsWith("wipe") ? pve.call<string>("PUT", `/nodes/${seg(node)}/disks/wipedisk`, { disk: dev }) : pve.call<string>("POST", `/nodes/${seg(node)}/disks/initgpt`, { disk: dev });
    });
    return ctx.json(202, { task: task(t) }), true;
  }

  const kindList = path.match(/^\/api\/disks\/(directory|lvm|lvmthin|zfs)$/);
  if (kindList && method === "GET") {
    const out = await ctx.asUser((pve) => pve.call<unknown>("GET", `/nodes/${seg(node)}/disks/${kindList[1]}`));
    return ctx.json(200, { items: Array.isArray(out) ? out : (out as Json | null)?.children ?? [] }), true;
  }
  const zfsOne = path.match(/^\/api\/disks\/zfs\/([^/]+)$/);
  if (zfsOne && method === "GET") {
    const name = decodeURIComponent(zfsOne[1]);
    if (!POOL_NAME.test(name)) throw new CheckError("Unknown pool");
    return ctx.json(200, await ctx.asUser((pve) => pve.call<Json>("GET", `/nodes/${seg(node)}/disks/zfs/${seg(name)}`))), true;
  }

  const create = path.match(/^\/api\/disks\/(directory|lvm|lvmthin|zfs)$/);
  if (create && method === "POST") {
    ctx.sameSite();
    const kind = create[1] as Kind;
    const b = await ctx.readJson();
    const t = await ctx.asUser(async (pve) => {
      const disks = await listDisks(pve, node, false);
      const sizes = new Map(disks.map((d) => [d.devpath, d.sizeBytes]));
      const need = (dev: string) => {
        const d = disks.find((x) => x.devpath === dev);
        if (!d) throw new HttpError(404, "not_found", "Proxmox doesn't list that disk");
        if (d.inUseReason) throw new HttpError(409, "in_use", `${d.name} is in use: ${d.inUseReason}.`);
      };
      if (kind === "zfs") {
        const s = zfsSpec(b, sizes);
        s.devices.forEach(need);
        return pve.call<string>("POST", `/nodes/${seg(node)}/disks/zfs`, { name: s.name, devices: s.devices.join(","), raidlevel: s.raidlevel, ashift: s.ashift, compression: s.compression, "draid-config": s.draidConfig ?? undefined, add_storage: s.addStorage });
      }
      const name = storageName(b.name);
      const dev = device(b.device);
      need(dev);
      const fs = kind === "directory" ? (b.filesystem === undefined ? "ext4" : b.filesystem === "ext4" || b.filesystem === "xfs" ? b.filesystem : (() => { throw new CheckError("File system is ext4 or xfs"); })()) : undefined;
      return pve.call<string>("POST", `/nodes/${seg(node)}/disks/${kind}`, { name, device: dev, filesystem: fs, add_storage: b.addStorage === true });
    });
    return ctx.json(202, { task: task(t) }), true;
  }

  const del = path.match(/^\/api\/disks\/(directory|lvm|lvmthin|zfs)\/([^/]+)\/delete$/);
  if (del && method === "POST") {
    ctx.sameSite();
    const kind = del[1] as Kind;
    const name = decodeURIComponent(del[2]);
    if (!POOL_NAME.test(name)) throw new CheckError("Unknown name");
    const b = await ctx.readJson();
    if (b.confirm !== name) throw new HttpError(409, "confirm", `Type the name (${name}) to confirm.`);
    const params: Record<string, string | boolean | undefined> = { "cleanup-config": b.cleanupConfig === true, "cleanup-disks": b.cleanupDisks === true };
    if (kind === "lvmthin") params["volume-group"] = typeof b.volumeGroup === "string" && POOL_NAME.test(b.volumeGroup) ? b.volumeGroup : (() => { throw new CheckError("Say which volume group the thin pool is in"); })();
    const t = await ctx.asUser((pve) => pve.call<string>("DELETE", `/nodes/${seg(node)}/disks/${kind}/${seg(name)}`, params));
    return ctx.json(202, { task: task(t) }), true;
  }

  // ---- Storage definitions
  if (method === "GET" && path === "/api/storage-config/types") return ctx.json(200, { types: STORAGE_DEFS.map((d) => ({ type: d.type, label: d.label })) }), true;

  if (method === "GET" && path === "/api/storage-config") {
    const list = await ctx.asUser((pve) => pve.call<Json[]>("GET", "/storage"));
    return ctx.json(200, { storages: list.map(publicStorage) }), true;
  }
  const one = path.match(/^\/api\/storage-config\/([^/]+)$/);
  if (one && method === "GET" && one[1] !== "scan") {
    const id = decodeURIComponent(one[1]);
    if (!STORAGE_ID_RE.test(id)) throw new CheckError("Unknown storage");
    const raw = await ctx.asUser((pve) => pve.call<Json>("GET", `/storage/${seg(id)}`));
    return ctx.json(200, publicStorage({ storage: id, ...raw })), true;
  }
  if (method === "POST" && path === "/api/storage-config") {
    ctx.sameSite();
    const b = await ctx.readJson();
    const def = defFor(b.type);
    const id = typeof b.storage === "string" && STORAGE_ID_RE.test(b.storage) ? b.storage : (() => { throw new CheckError("Name: 2 to 40 characters, lowercase letters, digits, - _ and ., starting with a letter"); })();
    const r = buildStorageParams(def, b, true);
    if (r.issues.length) throw new HttpError(400, "bad_request", r.issues.map((i) => i.message).join(". "));
    await ctx.asUser((pve) => pve.call("POST", "/storage", { ...r.params, type: def.type, storage: id }));
    return ctx.json(200, { ok: true, storage: id }), true;
  }
  if (one && method === "POST" && one[1] !== "scan") {
    ctx.sameSite();
    const id = decodeURIComponent(one[1]);
    if (!STORAGE_ID_RE.test(id)) throw new CheckError("Unknown storage");
    const b = await ctx.readJson();
    if (typeof b.digest !== "string" || !/^[0-9a-f]{40}$/.test(b.digest)) throw new CheckError("This page is out of date. Reload and try again");
    await ctx.asUser(async (pve) => {
      const current = await pve.call<Json>("GET", `/storage/${seg(id)}`);
      const def = defFor(current.type);
      const r = buildStorageParams(def, b, false);
      if (r.issues.length) throw new HttpError(400, "bad_request", r.issues.map((i) => i.message).join(". "));
      if (!Object.keys(r.params).length && !r.remove.length) throw new HttpError(400, "bad_request", "Nothing to change");
      await pve.call("PUT", `/storage/${seg(id)}`, { ...r.params, delete: r.remove.length ? r.remove.join(",") : undefined, digest: b.digest as string });
    });
    return ctx.json(200, { ok: true }), true;
  }
  const usage = path.match(/^\/api\/storage-config\/([^/]+)\/usage$/);
  if (usage && method === "GET") {
    const id = decodeURIComponent(usage[1]);
    if (!STORAGE_ID_RE.test(id)) throw new CheckError("Unknown storage");
    return ctx.json(200, await ctx.asUser((pve) => storageUsage(pve, node, id))), true;
  }
  const rm = path.match(/^\/api\/storage-config\/([^/]+)\/delete$/);
  if (rm && method === "POST") {
    ctx.sameSite();
    const id = decodeURIComponent(rm[1]);
    if (!STORAGE_ID_RE.test(id)) throw new CheckError("Unknown storage");
    const b = await ctx.readJson();
    if (b.confirm !== id) throw new HttpError(409, "confirm", `Type the storage's name (${id}) to confirm.`);
    await ctx.asUser(async (pve) => {
      const u = await storageUsage(pve, node, id);
      if ((u.guests.length || u.backupJobs.length) && b.acknowledgeInUse !== true) throw new HttpError(409, "in_use", `${id} is still used by ${u.guests.length} machine${u.guests.length === 1 ? "" : "s"} and ${u.backupJobs.length} backup job${u.backupJobs.length === 1 ? "" : "s"}. Confirm that you want to remove it anyway.`);
      await pve.call("DELETE", `/storage/${seg(id)}`);
    });
    return ctx.json(200, { ok: true }), true;
  }

  const scan = path.match(/^\/api\/storage-config\/scan\/(nfs|cifs|pbs|iscsi|lvm|lvmthin|zfs)$/);
  if (scan && method === "POST") {
    ctx.sameSite();
    const b = await ctx.readJson();
    const kind = scan[1];
    const server = () => (typeof b.server === "string" && hostName.test(b.server) ? b.server : (() => { throw new CheckError("Enter the server's address first"); })());
    const text = (k: string, max = 256) => (b[k] === undefined || b[k] === "" ? undefined : typeof b[k] === "string" && (b[k] as string).length <= max && !/[\x00\r\n]/.test(b[k] as string) ? (b[k] as string) : (() => { throw new CheckError(`${k} has characters Proxmox won't accept`); })());
    const params: Record<string, string | number | undefined> = {};
    if (kind === "nfs") params.server = server();
    if (kind === "cifs") Object.assign(params, { server: server(), username: text("username"), password: text("password", 1024), domain: text("domain") });
    if (kind === "pbs") Object.assign(params, { server: server(), username: text("username") ?? (() => { throw new CheckError("Enter the username"); })(), password: text("password", 1024) ?? (() => { throw new CheckError("Enter the password"); })(), fingerprint: text("fingerprint", 100), port: b.port === undefined || b.port === "" ? undefined : Number.isInteger(b.port) && (b.port as number) > 0 && (b.port as number) < 65536 ? (b.port as number) : (() => { throw new CheckError("Port is 1 to 65535"); })() });
    if (kind === "iscsi") params.portal = typeof b.portal === "string" && hostName.test(b.portal) ? b.portal : (() => { throw new CheckError("Enter the portal's address first"); })();
    if (kind === "lvmthin") params.vg = typeof b.vg === "string" && POOL_NAME.test(b.vg) ? b.vg : (() => { throw new CheckError("Pick a volume group first"); })();
    const items = await ctx.asUser((pve) => pve.call<Json[]>("GET", `/nodes/${seg(node)}/scan/${kind}`, params));
    return ctx.json(200, { items: Array.isArray(items) ? items : [] }), true;
  }

  const attrs = path.match(/^\/api\/storage\/([^/]+)\/attributes$/);
  if (attrs && method === "POST") {
    ctx.sameSite();
    const storage = decodeURIComponent(attrs[1]);
    if (!STORAGE_ID_RE.test(storage)) throw new CheckError("Unknown storage");
    const b = await ctx.readJson();
    const volid = typeof b.volid === "string" && b.volid.startsWith(`${storage}:`) && !b.volid.includes("..") && /^[\w.-]+:[\w./+ ()-]+$/.test(b.volid) ? b.volid : (() => { throw new CheckError("Unknown file"); })();
    const params: Record<string, string | boolean | undefined> = {};
    if (b.notes !== undefined) params.notes = typeof b.notes === "string" && b.notes.length <= 2048 ? b.notes : (() => { throw new CheckError("Notes are limited to 2048 characters"); })();
    if (b.protected !== undefined) params.protected = typeof b.protected === "boolean" ? b.protected : (() => { throw new CheckError("Protected is on or off"); })();
    if (!Object.keys(params).length) throw new CheckError("Nothing to change");
    await ctx.asUser((pve) => pve.call("PUT", `/nodes/${seg(node)}/storage/${seg(storage)}/content/${seg(volid)}`, params));
    return ctx.json(200, { ok: true }), true;
  }
  return false;
}

/** What would break if this storage went away: machines with volumes on it, backup jobs writing to it. */
async function storageUsage(pve: ProxmoxClient, node: string, id: string) {
  const [guests, jobs, items] = await Promise.all([
    pve.clusterResources().catch(() => []),
    pve.backupJobs().catch(() => []),
    pve.storageContentAll(node, id).catch(() => null),
  ]);
  const byVmid = new Map<number, number>();
  const counts: Record<string, number> = {};
  for (const i of items ?? []) {
    counts[i.content] = (counts[i.content] ?? 0) + 1;
    if (i.vmid && (i.content === "images" || i.content === "rootdir")) byVmid.set(i.vmid, (byVmid.get(i.vmid) ?? 0) + 1);
  }
  return {
    counts,
    readable: items !== null,
    guests: [...byVmid].map(([vmid, volumes]) => ({ vmid, name: guests.find((g) => g.vmid === vmid)?.name ?? null, volumes })),
    backupJobs: jobs.filter((j) => j.storage === id).map((j) => j.id),
  };
}

