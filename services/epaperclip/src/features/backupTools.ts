import { parsePrune, prunePropertyString, type PruneSettings } from "@papercliped-engine/proxmox-client/storage-schema";
import { HttpError } from "../http.ts";
import { asRecord, flag, intIn, knownNodes, requireNode, schedule, seg, vmidOf } from "./clusterCommon.ts";
import { bad, confirmed, noExtra, query, resolveNode, soft, type Route } from "./nodeCommon.ts";
import { ownerOf, volumeOf } from "./storageTools.ts";
import { routeTable } from "./w3Router.ts";

/**
 * Backups, the parts around the job list: every option a job can have (selection by pool or exclusion, notes,
 * notifications, fleecing, speed, compression, retention), guests no job covers, what a job includes, a backup's guest
 * configuration, browsing a Proxmox Backup Server snapshot, and restoring with the options Proxmox's own screen offers.
 */

type Json = Record<string, any>;

const MODES = ["snapshot", "suspend", "stop"] as const;
const COMPRESS = ["0", "gzip", "lzo", "zstd"] as const;
const NOTIFY = ["auto", "legacy-sendmail", "notification-system"] as const;
const DETECT = ["legacy", "data", "metadata"] as const;
const JOB_ID = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
const STORAGE_RE = /^[A-Za-z][\w.-]{0,63}$/;
const POOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST = /^[0-9a-f]{40}$/;
const storageId = (v: unknown): string => (typeof v === "string" && STORAGE_RE.test(v) ? v : bad("Unknown storage"));

const parseKv = (s: unknown): Json => {
  if (s && typeof s === "object") return s as Json;
  if (typeof s !== "string") return {};
  return Object.fromEntries(s.split(",").filter(Boolean).map((p) => { const i = p.indexOf("="); return i < 0 ? [p, true] : [p.slice(0, i), p.slice(i + 1)]; }));
};
const vmidList = (v: unknown, what: string): number[] => {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",").filter(Boolean) : null;
  if (!list || list.length > 1000) return bad(`${what} is a list of machine numbers`);
  const out = list.map((x) => vmidOf(typeof x === "string" ? x.trim() : x));
  return [...new Set(out)];
};

export function mapJob(j: Json) {
  const fleecing = parseKv(j.fleecing);
  const perf = parseKv(j.performance);
  const prune = j["prune-backups"] !== undefined ? parsePrune(j["prune-backups"]) : null;
  const vmids = typeof j.vmid === "string" ? j.vmid.split(",").filter(Boolean).map(Number) : [];
  const exclude = typeof j.exclude === "string" ? j.exclude.split(",").filter(Boolean).map(Number) : [];
  const selection = flag(j.all) || exclude.length ? "all" : typeof j.pool === "string" && j.pool ? "pool" : "vmids";
  return {
    id: String(j.id),
    enabled: j.enabled === undefined ? true : flag(j.enabled),
    schedule: typeof j.schedule === "string" ? j.schedule : null,
    storage: typeof j.storage === "string" ? j.storage : null,
    node: typeof j.node === "string" ? j.node : null,
    mode: typeof j.mode === "string" ? j.mode : "snapshot",
    compress: typeof j.compress === "string" || typeof j.compress === "number" ? String(j.compress) : null,
    selection,
    vmids,
    exclude,
    pool: typeof j.pool === "string" ? j.pool : null,
    comment: typeof j.comment === "string" ? j.comment : "",
    notesTemplate: typeof j["notes-template"] === "string" ? j["notes-template"] : null,
    notificationMode: typeof j["notification-mode"] === "string" ? j["notification-mode"] : null,
    fleecing: { enabled: flag(fleecing.enabled), storage: typeof fleecing.storage === "string" ? fleecing.storage : null },
    bwlimit: typeof j.bwlimit === "number" ? j.bwlimit : null,
    performance: { maxWorkers: perf["max-workers"] !== undefined ? Number(perf["max-workers"]) : null, pbsEntriesMax: perf["pbs-entries-max"] !== undefined ? Number(perf["pbs-entries-max"]) : null },
    zstd: typeof j.zstd === "number" ? j.zstd : null,
    ionice: typeof j.ionice === "number" ? j.ionice : null,
    repeatMissed: flag(j["repeat-missed"]),
    protected: flag(j.protected),
    stdexcludes: j.stdexcludes === undefined ? true : flag(j.stdexcludes),
    excludePath: Array.isArray(j["exclude-path"]) ? j["exclude-path"].map(String) : typeof j["exclude-path"] === "string" ? [j["exclude-path"]] : [],
    pbsChangeDetectionMode: typeof j["pbs-change-detection-mode"] === "string" ? j["pbs-change-detection-mode"] : null,
    stopwait: typeof j.stopwait === "number" ? j.stopwait : null,
    prune,
    nextRun: typeof j["next-run"] === "number" ? j["next-run"] : null,
    digest: typeof j.digest === "string" ? j.digest : null,
  };
}

const JOB_KEYS = ["id", "enabled", "schedule", "storage", "node", "mode", "compress", "selection", "vmids", "exclude", "pool", "comment", "notesTemplate", "notificationMode", "fleecing", "bwlimit", "performance", "zstd", "ionice", "repeatMissed", "protected", "stdexcludes", "excludePath", "pbsChangeDetectionMode", "stopwait", "prune", "digest"];

/** A job definition checked field by field; `unset` lists settings that were emptied so an edit can send `delete`. */
export function jobParams(b: Json, known: { node: string }[], creating: boolean): { set: Json; unset: string[] } {
  noExtra(b, JOB_KEYS);
  const set: Json = {};
  const unset: string[] = [];
  const empty = (v: unknown) => v === null || v === "";
  const opt = (key: string, wire: string, f: (v: unknown) => unknown) => {
    if (b[key] === undefined) return;
    if (empty(b[key])) unset.push(wire);
    else set[wire] = f(b[key]);
  };
  if (b.id !== undefined) {
    if (!creating) bad("A job keeps its name");
    set.id = typeof b.id === "string" && JOB_ID.test(b.id) ? b.id : bad("A job name starts with a letter and uses letters, numbers, - and _ (3 to 64 characters)");
  }
  if (b.enabled !== undefined) set.enabled = typeof b.enabled === "boolean" ? b.enabled : bad("Enabled is on or off");
  if (creating || b.schedule !== undefined) set.schedule = schedule(b.schedule ?? "21:00");
  if (creating || b.storage !== undefined) set.storage = storageId(b.storage);
  opt("node", "node", (v) => requireNode(v, known));
  if (b.mode !== undefined) set.mode = (MODES as readonly unknown[]).includes(b.mode) ? b.mode : bad("The mode is snapshot, suspend or stop");
  if (b.compress !== undefined) set.compress = (COMPRESS as readonly unknown[]).includes(String(b.compress)) ? String(b.compress) : bad("Compression is none, gzip, lzo or zstd");

  // Which machines: everything (minus some), a list, or a pool. Exactly one.
  if (b.selection !== undefined || creating) {
    const sel = b.selection ?? "vmids";
    if (sel === "all") {
      set.all = true;
      const ex = b.exclude === undefined ? [] : vmidList(b.exclude, "The excluded machines");
      if (ex.length) set.exclude = ex.join(",");
      unset.push("vmid", "pool");
      if (!ex.length) unset.push("exclude");
    } else if (sel === "pool") {
      if (typeof b.pool !== "string" || !POOL_RE.test(b.pool)) bad("Pick a pool");
      set.pool = b.pool;
      unset.push("vmid", "exclude");
      set.all = false;
    } else if (sel === "vmids") {
      const v = vmidList(b.vmids ?? [], "The machines");
      if (!v.length) bad("Pick the machines to back up");
      set.vmid = v.join(",");
      unset.push("pool", "exclude");
      set.all = false;
    } else bad("Back up all machines, a list, or a pool");
  }

  if (b.comment !== undefined) opt("comment", "comment", (v) => (typeof v === "string" && v.length <= 512 && !/[\u0000-\u001f]/.test(v) ? v : bad("Keep the description to one line")));
  opt("notesTemplate", "notes-template", (v) => (typeof v === "string" && v.length <= 1024 && !/[\u0000-\u0008\u000b-\u001f]/.test(v) ? v : bad("Keep the notes template under 1024 characters")));
  opt("notificationMode", "notification-mode", (v) => ((NOTIFY as readonly unknown[]).includes(v) ? v : bad("Notifications are auto, legacy-sendmail or notification-system")));
  if (b.fleecing !== undefined) {
    const f = asRecord(b.fleecing);
    noExtra(f, ["enabled", "storage"]);
    if (f.enabled === true) set.fleecing = `enabled=1${f.storage ? `,storage=${storageId(f.storage)}` : ""}`;
    else unset.push("fleecing");
  }
  opt("bwlimit", "bwlimit", (v) => intIn(v, 0, 1e9, "The speed limit (KiB/s)"));
  if (b.performance !== undefined) {
    const p = asRecord(b.performance);
    noExtra(p, ["maxWorkers", "pbsEntriesMax"]);
    const parts: string[] = [];
    if (!empty(p.maxWorkers) && p.maxWorkers !== undefined) parts.push(`max-workers=${intIn(p.maxWorkers, 1, 256, "Workers")}`);
    if (!empty(p.pbsEntriesMax) && p.pbsEntriesMax !== undefined) parts.push(`pbs-entries-max=${intIn(p.pbsEntriesMax, 1, 1e9, "PBS entries")}`);
    if (parts.length) set.performance = parts.join(",");
    else unset.push("performance");
  }
  opt("zstd", "zstd", (v) => intIn(v, 0, 256, "Zstd threads"));
  opt("ionice", "ionice", (v) => intIn(v, 0, 8, "IO priority"));
  opt("stopwait", "stopwait", (v) => intIn(v, 0, 10080, "Stop wait (minutes)"));
  if (b.repeatMissed !== undefined) set["repeat-missed"] = typeof b.repeatMissed === "boolean" ? b.repeatMissed : bad("Repeat missed is on or off");
  if (b.protected !== undefined) set.protected = typeof b.protected === "boolean" ? b.protected : bad("Protected is on or off");
  if (b.stdexcludes !== undefined) set.stdexcludes = typeof b.stdexcludes === "boolean" ? b.stdexcludes : bad("Standard excludes is on or off");
  if (b.excludePath !== undefined) {
    if (!Array.isArray(b.excludePath) || b.excludePath.length > 64 || b.excludePath.some((x: unknown) => typeof x !== "string" || !x || x.length > 512 || /[\u0000-\u001f]/.test(x))) bad("Excluded paths are a list of paths or patterns");
    if (b.excludePath.length) set["exclude-path"] = b.excludePath;
    else unset.push("exclude-path");
  }
  opt("pbsChangeDetectionMode", "pbs-change-detection-mode", (v) => ((DETECT as readonly unknown[]).includes(v) ? v : bad("Change detection is legacy, data or metadata")));
  if (b.prune !== undefined) {
    if (empty(b.prune)) unset.push("prune-backups");
    else {
      try {
        const text = prunePropertyString(asRecord(b.prune) as Partial<PruneSettings>);
        if (text) set["prune-backups"] = text;
        else unset.push("prune-backups");
      } catch (e) {
        bad(e instanceof Error ? e.message : "Check the retention numbers");
      }
    }
  }
  return { set, unset };
}

const wireParams = (set: Json) => {
  const o: Record<string, string | number | boolean | string[]> = {};
  for (const [k, v] of Object.entries(set)) if (v !== undefined) o[k] = v as never;
  return o;
};

async function jobsList(pve: import("@papercliped-engine/proxmox-client").ProxmoxClient) {
  return (await pve.call<Json[]>("GET", "/cluster/backup")).map(mapJob);
}

/** The guest config text with anything that looks like a password hash hidden. */
export function maskConfig(text: string): string {
  return text.split("\n").map((l) => (/^\s*(cipassword|password)\s*:/i.test(l) ? l.replace(/:.*/, ": …") : l)).join("\n");
}

export function backupToolsRoutes(): Route[] {
  return [
    {
      method: "GET",
      re: /^\/api\/backup-tools\/jobs$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const [jobs, nodes, pools, storages] = await Promise.all([jobsList(pve), knownNodes(pve), soft(pve.call<Json[]>("GET", "/pools")), soft(pve.call<Json[]>("GET", `/nodes/${seg(c.node)}/storage`, { content: "backup" }))]);
          return { jobs, nodes: nodes.map((n) => n.node), pools: (pools.data ?? []).map((p) => String(p.poolid)), storages: (storages.data ?? []).map((s) => String(s.storage)) };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/backup-tools\/jobs$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        await c.asUser(async (pve) => {
          const { set } = jobParams(body, await knownNodes(pve), true);
          await pve.call("POST", "/cluster/backup", wireParams(set));
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/backup-tools\/jobs\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const id = JOB_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a backup job");
        const body = await c.readJson();
        const digest = typeof body.digest === "string" && DIGEST.test(body.digest) ? body.digest : bad("Reload the page: this change needs the version you last saw (digest)");
        const rest = { ...body };
        delete rest.digest;
        await c.asUser(async (pve) => {
          const { set, unset } = jobParams(rest, await knownNodes(pve), false);
          if (!Object.keys(set).length && !unset.length) bad("Nothing to change");
          // Fields that are not part of the chosen selection are dropped from the job, not left behind.
          const del = [...new Set(unset)].filter((k) => !(k in set));
          await pve.call("PUT", `/cluster/backup/${seg(id)}`, { ...wireParams(set), delete: del.length ? del.join(",") : undefined, digest });
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/backup-tools\/jobs\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const id = JOB_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a backup job");
        const body = await c.readJson();
        noExtra(body, ["confirm"]);
        confirmed(body, id, `removing the backup job ${id}`);
        await c.asUser((pve) => pve.call("DELETE", `/cluster/backup/${seg(id)}`));
        c.json(200, { ok: true });
      },
    },
    {
      method: "GET",
      re: /^\/api\/backup-tools\/jobs\/([^/]+)\/volumes$/,
      run: async (c, m) => {
        const id = JOB_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a backup job");
        const out = await c.asUser(async (pve) => {
          const r = asRecord(await pve.call<unknown>("GET", `/cluster/backup/${seg(id)}/included_volumes`));
          const children = (Array.isArray(r.children) ? r.children : []) as Json[];
          return {
            job: id,
            guests: children.map((g) => ({
              id: typeof g.id === "number" || typeof g.id === "string" ? g.id : null,
              name: typeof g.name === "string" ? g.name : null,
              type: typeof g.type === "string" ? g.type : null,
              volumes: ((Array.isArray(g.children) ? g.children : []) as Json[]).map((v) => ({ id: String(v.id ?? ""), name: String(v.name ?? v.id ?? ""), included: flag(v.included), reason: typeof v.reason === "string" ? v.reason : null })),
            })),
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/backup-tools\/not-backed-up$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const [list, all] = await Promise.all([pve.call<Json[]>("GET", "/cluster/backup-info/not-backed-up"), soft(pve.call<Json[]>("GET", "/cluster/resources", { type: "vm" }))]);
          const byId = new Map((all.data ?? []).map((g) => [Number(g.vmid), g]));
          return {
            guests: list.map((g) => {
              const vmid = Number(g.vmid);
              const r = byId.get(vmid);
              return { vmid, name: String(g.name ?? r?.name ?? vmid), type: String(g.type ?? r?.type ?? ""), node: typeof r?.node === "string" ? r.node : null };
            }).filter((g) => Number.isFinite(g.vmid)).sort((a, b) => a.vmid - b.vmid),
          };
        });
        c.json(200, out);
      },
    },

    // ---- A backup file: its guest configuration, and files inside it
    {
      method: "GET",
      re: /^\/api\/backup-tools\/config$/,
      run: async (c) => {
        const storage = storageId(query(c, "storage"));
        const volume = volumeOf(query(c, "volume"), storage);
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const text = await pve.call<unknown>("GET", `/nodes/${seg(node)}/vzdump/extractconfig`, { volume });
          return { volume, owner: ownerOf(volume), config: typeof text === "string" ? maskConfig(text.slice(0, 200_000)) : "" };
        });
        c.json(200, out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/backup-tools\/files$/,
      run: async (c) => {
        const storage = storageId(query(c, "storage"));
        const volume = volumeOf(query(c, "volume"), storage);
        const raw = query(c, "path") ?? "/";
        if (raw.length > 1024 || raw.includes("\0")) bad("That path is too long");
        const filepath = raw === "/" ? "/" : Buffer.from(raw, "utf8").toString("base64");
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const rows = await pve.call<Json[]>("GET", `/nodes/${seg(node)}/storage/${seg(storage)}/file-restore/list`, { volume, filepath });
          return {
            volume,
            path: raw,
            entries: rows.map((e) => ({
              name: String(e.text ?? ""),
              // Proxmox names each entry's path in base64; it is decoded here so the console only ever sees text.
              path: typeof e.filepath === "string" ? Buffer.from(e.filepath, "base64").toString("utf8") : null,
              type: typeof e.type === "string" ? e.type : null,
              leaf: flag(e.leaf),
              size: typeof e.size === "number" ? e.size : null,
              mtime: typeof e.mtime === "number" ? e.mtime : null,
            })),
          };
        });
        c.json(200, out);
      },
    },

    // ---- Restore with options
    {
      method: "POST",
      re: /^\/api\/backup-tools\/restore$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "from", "volid", "mode", "vmid", "storage", "unique", "start", "bwlimit", "liveRestore", "pool", "confirm"]);
        const from = storageId(body.from);
        const volid = volumeOf(body.volid, from);
        const src = ownerOf(volid);
        if (!src || !src.type) bad("That isn't a machine backup");
        const replace = body.mode === "replace";
        if (body.mode !== undefined && body.mode !== "new" && body.mode !== "replace") bad("Restore as a new machine, or replace the original");
        const storage = body.storage === undefined || body.storage === "" ? undefined : storageId(body.storage);
        const bwlimit = body.bwlimit === undefined || body.bwlimit === "" ? undefined : intIn(body.bwlimit, 0, 1e9, "The speed limit (KiB/s)");
        const pool = body.pool === undefined || body.pool === "" ? undefined : typeof body.pool === "string" && POOL_RE.test(body.pool) ? body.pool : bad("Pick a pool");
        if (body.liveRestore === true && src.type !== "qemu") bad("Live restore works for virtual machines only");
        if (body.liveRestore === true && replace) bad("Live restore can't replace a machine that exists");
        const wantedId = body.vmid === undefined || body.vmid === "" ? undefined : vmidOf(body.vmid);
        if (replace) confirmed(body, String(src.vmid), `restoring over machine ${src.vmid}`);
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          const all = await pve.call<Json[]>("GET", "/cluster/resources", { type: "vm" });
          let vmid = src.vmid;
          if (replace) {
            const g = all.find((r) => r.vmid === vmid);
            if (!g) throw new HttpError(404, "not_found", `Machine ${vmid} doesn't exist any more, so there is nothing to replace. Restore it as a new machine.`);
            if (g.status === "running") throw new HttpError(409, "running", "Stop the machine before restoring over it");
          } else {
            vmid = wantedId ?? Number(await pve.call<string | number>("GET", "/cluster/nextid"));
            if (all.some((r) => r.vmid === vmid)) throw new HttpError(409, "exists", `Machine ${vmid} already exists. Pick another number or replace it.`);
          }
          const common = { vmid, storage, force: replace ? true : undefined, unique: !replace && body.unique !== false ? true : undefined, start: body.start === true ? true : undefined, bwlimit, pool };
          const path = `/nodes/${seg(node)}/${src.type}`;
          const task = src.type === "lxc" ? await pve.call<string>("POST", path, { ...common, ostemplate: volid, restore: true }) : await pve.call<string>("POST", path, { ...common, archive: volid, "live-restore": body.liveRestore === true ? true : undefined });
          return { vmid, task };
        });
        c.json(200, out);
      },
    },
  ];
}

export const handleBackupTools = routeTable("/api/backup-tools/", backupToolsRoutes());
