import { asNumber, checkDc, STORAGE_ID, withDelete } from "./dcCommon.ts";
import { DC_SCHEMAS } from "./dcSchema.ts";
import { bad, confirmed, noExtra, query, resolveNode, seg, soft, type Deps, type Route } from "./nodeCommon.ts";
import { readGroup } from "./nodeValidate.ts";

/**
 * Backups beyond the basics: scheduled jobs with every option Proxmox has (guest selection by list, pool or "all",
 * excludes, mode, compression, retention, notification, notes template, fleecing, bandwidth, performance, repeat
 * missed), machines no job covers, what a job includes, backups per storage with protection and notes, their
 * configuration, pruning with a preview, restore with options, and the file browser for Proxmox Backup Server backups.
 */

type Raw = Record<string, any>;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const storageOf = (v: unknown, what = "storage"): string => (typeof v === "string" && STORAGE_ID.test(v) ? v : bad(`Pick the ${what}`));

/** A backup volume id: storage:backup/<name>. Names are restricted to what vzdump and Proxmox Backup Server produce. */
const VOLID = /^([A-Za-z][A-Za-z0-9_.-]{0,99}):backup\/([A-Za-z0-9][A-Za-z0-9_.:/+=-]{2,200})$/;
export function backupVolume(v: unknown, storage?: string): { storage: string; volid: string; type: "qemu" | "lxc" | null; vmid: number | null } {
  const m = typeof v === "string" ? v.match(VOLID) : null;
  if (!m || m[2].includes("..") || (storage && m[1] !== storage)) return bad("That isn't a backup");
  const file = m[2];
  const a = file.match(/^vzdump-(qemu|lxc|openvz)-(\d+)-/);
  const b = file.match(/^(vm|ct)\/(\d+)\//);
  const type = a ? (a[1] === "qemu" ? "qemu" : "lxc") : b ? (b[1] === "vm" ? "qemu" : "lxc") : null;
  const vmid = a ? Number(a[2]) : b ? Number(b[2]) : null;
  return { storage: m[1], volid: v as string, type, vmid };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function describeJob(raw: Raw) {
  const values = readGroup(DC_SCHEMAS.backupJob, raw);
  return { id: String(raw.id ?? ""), values, nextRun: num(raw["next-run"]), type: typeof raw.type === "string" ? raw.type : "vzdump", digest: typeof raw.digest === "string" ? raw.digest : null };
}

/** "Keep everything" can't be combined with limits (Proxmox refuses it too; this says why before asking). */
function checkRetention(p: Record<string, unknown>) {
  const r = p["prune-backups"];
  if (typeof r === "string" && /(^|,)keep-all=1(,|$)/.test(r) && /keep-(last|hourly|daily|weekly|monthly|yearly)=/.test(r)) bad("Keep everything can't be combined with the other keep settings; turn it off to limit how many backups are kept");
}

/** The guest selection is one of: everything, a list (with nothing else), or a pool. Proxmox's UI offers the same three. */
function checkSelection(p: Record<string, unknown>, creating: boolean) {
  const picks = ["all", "vmid", "pool"].filter((k) => p[k] !== undefined && p[k] !== 0 && p[k] !== "");
  if (creating && picks.length === 0) bad("Choose what to back up: every machine, a list, or a pool");
  if (picks.length > 1) bad("Choose one way to select machines: every machine, a list, or a pool");
  if (creating && p.exclude !== undefined && !(p.all !== undefined && p.all !== 0) && p.pool === undefined) bad("Excludes only apply when backing up every machine or a pool");
}

export function backupRoutes(_d: Deps): Route[] {
  return [
    // ---- Jobs
    {
      method: "GET",
      re: /^\/api\/node\/backup\/jobs$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const [jobs, notBacked, storages, pools] = await Promise.all([
            soft(pve.call<Raw[]>("GET", "/cluster/backup")),
            soft(pve.call<Raw[]>("GET", "/cluster/backup-info/not-backed-up")),
            soft(pve.call<Raw[]>("GET", "/storage")),
            soft(pve.call<Raw[]>("GET", "/pools")),
          ]);
          return {
            jobs: (jobs.data ?? []).map(describeJob),
            denied: jobs.denied,
            uncovered: (notBacked.data ?? []).map((g) => ({ vmid: num(g.vmid), name: typeof g.name === "string" ? g.name : null, type: g.type === "lxc" ? "lxc" : "qemu" })).filter((g) => g.vmid !== null),
            uncoveredDenied: notBacked.denied,
            storages: (storages.data ?? []).filter((s) => typeof s.content === "string" && s.content.split(",").includes("backup")).map((s) => String(s.storage)),
            pools: (pools.data ?? []).map((p) => String(p.poolid)),
            schema: DC_SCHEMAS.backupJob,
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/node\/backup\/jobs\/([A-Za-z0-9][\w-]{0,63})$/,
      run: async (c, m) => {
        const raw = await c.asUser((pve) => pve.call<Raw>("GET", `/cluster/backup/${seg(m[1])}`));
        c.json(200, describeJob({ id: m[1], ...raw }));
      },
    },
    {
      method: "GET",
      re: /^\/api\/node\/backup\/jobs\/([A-Za-z0-9][\w-]{0,63})\/volumes$/,
      run: async (c, m) => {
        const raw = await c.asUser((pve) => pve.call<Raw>("GET", `/cluster/backup/${seg(m[1])}/included_volumes`));
        const kids: Raw[] = Array.isArray(raw?.children) ? raw.children : [];
        c.json(200, {
          guests: kids.slice(0, 500).map((g) => ({
            vmid: num(g.id) ?? Number(g.id) ?? null,
            name: typeof g.name === "string" ? g.name : null,
            type: g.type === "lxc" ? "lxc" : "qemu",
            volumes: (Array.isArray(g.children) ? g.children : []).slice(0, 100).map((v: Raw) => ({ id: String(v.id ?? ""), name: typeof v.name === "string" ? v.name : null, included: v.included === 1 || v.included === true, reason: typeof v.reason === "string" ? v.reason : null })),
          })),
        });
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/backup\/jobs$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(100_000);
        noExtra(body, ["id", "values"]);
        const values = (body.values ?? {}) as Record<string, unknown>;
        const checked = checkDc(DC_SCHEMAS.backupJob, values);
        checkSelection(checked.params, true);
        checkRetention(checked.params);
        if (checked.params.schedule === undefined) bad("Set when the job runs");
        if (checked.params.storage === undefined) bad("Pick the storage to back up to");
        const id = body.id === undefined || body.id === "" ? undefined : JOB_ID.test(String(body.id)) ? String(body.id) : bad("A job name uses letters, numbers, - and _");
        await c.asUser((pve) => pve.call("POST", "/cluster/backup", { ...checked.params, id } as Record<string, string | number | string[]>));
        c.json(201, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/backup\/jobs\/([A-Za-z0-9][\w-]{0,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const body = await c.readJson(100_000);
        noExtra(body, ["values", "digest"]);
        const checked = checkDc(DC_SCHEMAS.backupJob, (body.values ?? {}) as Record<string, unknown>);
        checkSelection(checked.params, false);
        checkRetention(checked.params);
        if (!Object.keys(checked.params).length && !checked.remove.length) bad("Nothing to change");
        const digest = typeof body.digest === "string" && /^[0-9a-f]{20,64}$/i.test(body.digest) ? body.digest : undefined;
        // Picking one way to select machines clears the others, as Proxmox's own form does.
        const sel = ["all", "vmid", "pool"];
        const picked = sel.find((k) => checked.params[k] !== undefined && checked.params[k] !== 0);
        const clear = picked ? sel.filter((k) => k !== picked && !checked.remove.includes(k)) : [];
        const merged = { ...checked, remove: [...checked.remove, ...clear] };
        await c.asUser((pve) => pve.call("PUT", `/cluster/backup/${seg(m[1])}`, withDelete(merged, { digest })));
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/node\/backup\/jobs\/([A-Za-z0-9][\w-]{0,63})$/,
      run: async (c, m) => {
        c.sameSite();
        confirmed(await c.readJson(), m[1], `deleting the backup job ${m[1]}`);
        await c.asUser((pve) => pve.call("DELETE", `/cluster/backup/${seg(m[1])}`));
        c.json(200, { ok: true });
      },
    },

    // ---- Backups on a storage
    {
      method: "GET",
      re: /^\/api\/node\/backup\/archives$/,
      run: async (c) => {
        const storage = storageOf(query(c, "storage"));
        const vm = query(c, "vmid");
        if (vm !== null && !/^\d{3,9}$/.test(vm)) bad("Unknown machine");
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const list = await pve.call<Raw[]>("GET", `/nodes/${seg(node)}/storage/${seg(storage)}/content`, { content: "backup", vmid: vm === null ? undefined : Number(vm) });
          return {
            node,
            storage,
            archives: list
              .filter((i) => typeof i.volid === "string" && VOLID.test(i.volid))
              .slice(0, 5000)
              .map((i) => ({ volid: i.volid as string, vmid: num(i.vmid), type: i.subtype === "lxc" ? "lxc" : i.subtype === "qemu" ? "qemu" : backupVolume(i.volid).type, format: typeof i.format === "string" ? i.format : null, size: num(i.size), ctime: num(i.ctime), notes: typeof i.notes === "string" ? i.notes : null, protected: i.protected === 1 || i.protected === true, verified: i.verification && typeof i.verification === "object" ? String((i.verification as Raw).state ?? "") || null : null }))
              .sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0)),
          };
        });
        c.json(200, out);
      },
    },
    {
      // Protect a backup (it can't be pruned or deleted until protection is removed) and edit its notes.
      method: "PUT",
      re: /^\/api\/node\/backup\/archives$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(50_000);
        noExtra(body, ["node", "storage", "volid", "protected", "notes"]);
        const storage = storageOf(body.storage);
        const v = backupVolume(body.volid, storage);
        const notes = body.notes === undefined ? undefined : typeof body.notes === "string" && body.notes.length <= 4096 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body.notes) ? body.notes : bad("Keep the notes to plain text under 4096 characters");
        if (notes === undefined && typeof body.protected !== "boolean") bad("Nothing to change");
        await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          await pve.call("PUT", `/nodes/${seg(node)}/storage/${seg(storage)}/content/${seg(v.volid)}`, { notes, protected: typeof body.protected === "boolean" ? body.protected : undefined });
        });
        c.json(200, { ok: true });
      },
    },
    {
      // The guest configuration stored inside a backup.
      method: "GET",
      re: /^\/api\/node\/backup\/archives\/config$/,
      run: async (c) => {
        const v = backupVolume(query(c, "volid"), storageOf(query(c, "storage")));
        const config = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          return pve.call<string>("GET", `/nodes/${seg(node)}/vzdump/extractconfig`, { volume: v.volid });
        });
        c.json(200, { config: typeof config === "string" ? config.slice(0, 200_000) : "" });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/node\/backup\/archives$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "storage", "volid", "confirm"]);
        const storage = storageOf(body.storage);
        const v = backupVolume(body.volid, storage);
        confirmed(body, v.volid.split("/").pop() ?? v.volid, "deleting this backup");
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          return pve.call<string | null>("DELETE", `/nodes/${seg(node)}/storage/${seg(storage)}/content/${seg(v.volid)}`);
        });
        c.json(200, { task: typeof task === "string" ? task : null });
      },
    },

    // ---- Prune: preview what a retention setting would remove, then do it
    {
      method: "POST",
      re: /^\/api\/node\/backup\/prune$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(50_000);
        noExtra(body, ["node", "storage", "vmid", "type", "retention", "dryRun", "confirm"]);
        const storage = storageOf(body.storage);
        const vmid = body.vmid === undefined || body.vmid === null || body.vmid === "" ? undefined : asNumber(body.vmid, "Machine", 100, 999999999);
        const type = body.type === undefined || body.type === null || body.type === "" ? undefined : body.type === "qemu" || body.type === "lxc" ? body.type : bad("Type is qemu or lxc");
        // The retention is optional: without it Proxmox uses the storage's own setting.
        let retention: string | number | string[] | undefined;
        if (body.retention !== undefined && body.retention !== null) {
          const checked = checkDc({ "prune-backups": DC_SCHEMAS.backupJob["prune-backups"] }, { "prune-backups": body.retention });
          checkRetention(checked.params);
          retention = checked.params["prune-backups"];
        }
        const dry = body.dryRun !== false;
        if (!dry) confirmed(body, storage, `removing backups from ${storage}`);
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          const path = `/nodes/${seg(node)}/storage/${seg(storage)}/prunebackups`;
          const params = { "prune-backups": retention as string | undefined, vmid, type };
          if (dry) {
            const list = await pve.call<Raw[]>("GET", path, params);
            return { plan: list.slice(0, 5000).map((p) => ({ volid: String(p.volid ?? ""), vmid: num(p.vmid), type: String(p.type ?? ""), ctime: num(p.ctime), mark: String(p.mark ?? "keep") })), task: null };
          }
          return { plan: null, task: await pve.call<string>("DELETE", path, params) };
        });
        c.json(dry ? 200 : 202, out);
      },
    },

    // ---- Restore with options
    {
      method: "POST",
      re: /^\/api\/node\/backup\/restore$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(50_000);
        noExtra(body, ["node", "storage", "volid", "target", "vmid", "replace", "unique", "start", "bwlimit", "pool", "liveRestore"]);
        const storage = storageOf(body.storage, "backup storage");
        const v = backupVolume(body.volid, storage);
        if (!v.type || v.vmid === null) bad("That isn't a machine backup");
        const target = body.target === undefined || body.target === null || body.target === "" ? undefined : storageOf(body.target, "storage to restore to");
        const bwlimit = body.bwlimit === undefined || body.bwlimit === null || body.bwlimit === "" ? undefined : asNumber(body.bwlimit, "Bandwidth limit", 0, 1_000_000_000);
        const pool = body.pool === undefined || body.pool === null || body.pool === "" ? undefined : typeof body.pool === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/.test(body.pool) ? body.pool : bad("Unknown pool");
        const replace = body.replace === true;
        if (replace && body.vmid !== undefined && body.vmid !== null && Number(body.vmid) !== v.vmid) bad("Restoring over a machine uses its own number");
        if (body.liveRestore === true && v.type !== "qemu") bad("Live restore only works for virtual machines");
        const created = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          let vmid: number;
          if (replace) {
            vmid = v.vmid!;
            const g = (await pve.clusterResources()).find((r) => r.vmid === vmid);
            if (g && g.status === "running") throw new c.HttpError(409, "running", "Stop the machine before restoring over it");
          } else if (body.vmid !== undefined && body.vmid !== null && body.vmid !== "") {
            vmid = asNumber(body.vmid, "Machine number", 100, 999999999);
            await pve.checkVmidFree(vmid);
          } else vmid = await pve.nextId();
          const common = { vmid, storage: target, force: replace ? 1 : undefined, unique: body.unique === false ? 0 : replace ? undefined : 1, start: body.start === true ? 1 : undefined, bwlimit, pool };
          const task = v.type === "lxc" ? await pve.call<string>("POST", `/nodes/${seg(node)}/lxc`, { ...common, ostemplate: v.volid, restore: 1 }) : await pve.call<string>("POST", `/nodes/${seg(node)}/qemu`, { ...common, archive: v.volid, "live-restore": body.liveRestore === true ? 1 : undefined });
          return { vmid, task };
        });
        c.json(202, created);
      },
    },

    // ---- File browser (Proxmox Backup Server snapshots only: that is all Proxmox's file-restore supports)
    {
      method: "GET",
      re: /^\/api\/node\/backup\/files$/,
      run: async (c) => {
        const v = backupVolume(query(c, "volid"), storageOf(query(c, "storage")));
        const path = query(c, "path") ?? "/";
        if (path.length > 1024 || path.includes("\u0000") || !path.startsWith("/")) bad("That isn't a path");
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const list = await pve.call<Raw[]>("GET", `/nodes/${seg(node)}/storage/${seg(v.storage)}/file-restore/list`, { volume: v.volid, filepath: Buffer.from(path, "utf8").toString("base64") });
          return list.slice(0, 5000).map((e) => ({ name: typeof e.text === "string" ? e.text : "", path: typeof e.filepath === "string" ? Buffer.from(e.filepath, "base64").toString("utf8").slice(0, 1024) : "", type: e.type === "d" ? "directory" : e.type === "l" ? "link" : e.type === "f" ? "file" : String(e.type ?? "other"), size: num(e.size), mtime: num(e.mtime), leaf: e.leaf === 1 || e.leaf === true }));
        });
        c.json(200, { path, entries: out.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name)) });
      },
    },
  ];
}
