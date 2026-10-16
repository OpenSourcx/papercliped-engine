import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { parsePrune, prunePropertyString, type PruneSettings } from "@papercliped-engine/proxmox-client/storage-schema";
import { HttpError } from "../http.ts";
import type { FeatureCtx } from "./index.ts";
import { asRecord, flag, seg, vmidOf } from "./clusterCommon.ts";
import { DRIVE_KEY_RE, DISK_BUSES, freeKey } from "./disksCheck.ts";
import { bad, confirmed, noExtra, query, resolveNode, soft, type Route } from "./nodeCommon.ts";
import { routeTable } from "./w3Router.ts";

/**
 * Storage content in depth: what fills a storage and when, retention (prune with a preview), new and copied volumes,
 * importing disk images into a machine, snippets, verifying a downloaded file, and where to get an ISO. Everything runs
 * as the signed-in person. Proxmox has no API for uploading a snippet or checking a file that is already stored, so
 * those two are guides with a command to copy, built from validated input.
 */

type Json = Record<string, any>;

const STORAGE_RE = /^[A-Za-z][\w.-]{0,63}$/;
const ALGOS = ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"] as const;
const DIGEST_LEN: Record<string, number> = { md5: 32, sha1: 40, sha224: 56, sha256: 64, sha384: 96, sha512: 128 };
const IMPORT_FILE = /^\w[\w.+-]{0,200}\.(ova|ovf|qcow2|raw|vmdk)$/i;
const ISO_FILE = /^\w[\w.+-]{0,200}\.(iso|img)$/i;
const TMPL_FILE = /^\w[\w.+-]{0,200}\.tar\.(gz|xz|zst)$/;

const storageId = (v: unknown): string => (typeof v === "string" && STORAGE_RE.test(v) ? v : bad("Unknown storage"));
export function volumeOf(v: unknown, storage: string): string {
  if (typeof v !== "string" || !v.startsWith(`${storage}:`) || v.length > 300 || v.includes("..") || !/^[\w.-]+:[\w./+:@-]+$/.test(v)) return bad("Unknown file");
  return v;
}
export function checksumOf(c: unknown, a: unknown): { checksum?: string; algorithm?: string } {
  if (c === undefined || c === null || c === "") return {};
  if (typeof a !== "string" || !(ALGOS as readonly string[]).includes(a)) return bad("Pick a checksum algorithm");
  if (typeof c !== "string" || !/^[0-9a-fA-F]+$/.test(c.trim()) || c.trim().length !== DIGEST_LEN[a]) return bad(`A ${a} checksum has ${DIGEST_LEN[a]} hexadecimal characters`);
  return { checksum: c.trim().toLowerCase(), algorithm: a };
}
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const pageUrl = (v: unknown): URL => {
  let u: URL;
  try {
    u = new URL(String(v));
  } catch {
    return bad("Enter a full http(s) address");
  }
  return (u.protocol === "https:" || u.protocol === "http:") && String(v).length <= 2048 ? u : bad("Enter a full http(s) address");
};

/** Where a machine backup or a guest disk belongs, from the volume id. */
export function ownerOf(volid: string): { vmid: number; type: "qemu" | "lxc" | null } | null {
  const a = volid.match(/:backup\/vzdump-(lxc|qemu|openvz)-(\d+)-/);
  if (a) return { vmid: Number(a[2]), type: a[1] === "qemu" ? "qemu" : "lxc" };
  const b = volid.match(/:backup\/(vm|ct)\/(\d+)\//);
  if (b) return { vmid: Number(b[2]), type: b[1] === "vm" ? "qemu" : "lxc" };
  const c = volid.match(/:(?:vm|base|subvol)-(\d+)-/) ?? volid.match(/\/(?:vm|base|subvol)-(\d+)-/);
  return c ? { vmid: Number(c[1]), type: null } : null;
}

const KIND_LABEL: Record<string, string> = { images: "Machine disks", rootdir: "Container volumes", vztmpl: "Container templates", iso: "ISO images", backup: "Backups", snippets: "Snippets", import: "Import files" };

export const ISO_SOURCES = [
  { id: "debian", name: "Debian", page: "https://www.debian.org/distrib/", files: "https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/", checksums: "SHA256SUMS in the same folder" },
  { id: "ubuntu", name: "Ubuntu Server", page: "https://ubuntu.com/download/server", files: "https://releases.ubuntu.com/", checksums: "SHA256SUMS in each release folder" },
  { id: "fedora", name: "Fedora Server", page: "https://fedoraproject.org/server/download", files: "https://download.fedoraproject.org/pub/fedora/linux/releases/", checksums: "A CHECKSUM file next to each image" },
  { id: "alma", name: "AlmaLinux", page: "https://almalinux.org/get-almalinux/", files: "https://repo.almalinux.org/almalinux/", checksums: "CHECKSUM in each release folder" },
  { id: "rocky", name: "Rocky Linux", page: "https://rockylinux.org/download", files: "https://download.rockylinux.org/pub/rocky/", checksums: "CHECKSUM files next to each image" },
  { id: "alpine", name: "Alpine Linux", page: "https://alpinelinux.org/downloads/", files: "https://dl-cdn.alpinelinux.org/alpine/", checksums: "A .sha256 file next to each image" },
  { id: "virtio", name: "VirtIO drivers for Windows", page: "https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers", files: "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/", checksums: "Listed on the Proxmox page" },
  { id: "windows", name: "Windows", page: "https://www.microsoft.com/software-download/", files: "", checksums: "Microsoft publishes the SHA-256 on the download page" },
] as const;

/** The retention a request names, or null to use what the storage is set to. */
function retention(body: Json): { text: string | null; settings: PruneSettings | null } {
  const keys = ["keepAll", "keepLast", "keepHourly", "keepDaily", "keepWeekly", "keepMonthly", "keepYearly"];
  const given = keys.filter((k) => body[k] !== undefined && body[k] !== null && body[k] !== "" && body[k] !== false);
  if (!given.length) return { text: null, settings: null };
  const p: Partial<PruneSettings> = {};
  for (const k of given) (p as Json)[k] = k === "keepAll" ? body[k] === true : typeof body[k] === "number" ? body[k] : /^\d+$/.test(String(body[k])) ? Number(body[k]) : bad("Retention is whole numbers");
  try {
    const text = prunePropertyString(p);
    return { text, settings: text ? parsePrune(text) : null };
  } catch (e) {
    return bad(e instanceof Error ? e.message : "Check the retention numbers");
  }
}

const KEEP_QUERY = ["keepAll", "keepLast", "keepHourly", "keepDaily", "keepWeekly", "keepMonthly", "keepYearly"];
const fromQuery = (c: FeatureCtx): Json => {
  const o: Json = {};
  for (const k of KEEP_QUERY) {
    const v = c.url.searchParams.get(k);
    if (v !== null && v !== "") o[k] = k === "keepAll" ? v === "true" || v === "1" : v;
  }
  return o;
};

function pruneArgs(c: FeatureCtx, body: Json | null): { vmid?: number; type?: "qemu" | "lxc"; prune?: string; settings: PruneSettings | null } {
  const src = body ?? {};
  const vm = body ? src.vmid : query(c, "vmid");
  const ty = body ? src.type : query(c, "type");
  const vmid = vm === undefined || vm === null || vm === "" ? undefined : vmidOf(vm);
  const type = ty === undefined || ty === null || ty === "" ? undefined : ty === "qemu" || ty === "lxc" ? ty : bad("The type is qemu or lxc");
  const { text, settings } = retention(body ?? fromQuery(c));
  return { vmid, type, prune: text ?? undefined, settings };
}

async function readConfig(pve: ProxmoxClient, node: string, vmid: number) {
  const all = await pve.call<Json[]>("GET", "/cluster/resources", { type: "vm" });
  const g = all.find((r) => r.vmid === vmid && r.type === "qemu");
  if (!g) throw new HttpError(404, "not_found", `There is no virtual machine ${vmid} in this cluster`);
  const where = String(g.node ?? node);
  const cfg = asRecord(await pve.call<unknown>("GET", `/nodes/${seg(where)}/qemu/${vmid}/config`));
  return { node: where, cfg, status: String(g.status ?? "unknown") };
}

export function storageToolsRoutes(): Route[] {
  return [
    {
      method: "GET",
      re: /^\/api\/storage-tools\/iso-sources$/,
      run: async (c) => c.json(200, { sources: ISO_SOURCES, note: "These are the publishers' own pages. Copy a file's address and its checksum from there into Download from URL; Proxmox checks the checksum as it downloads." }),
    },
    {
      method: "GET",
      re: /^\/api\/storage-tools\/url-metadata$/,
      run: async (c) => {
        const u = pageUrl(query(c, "url"));
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const r = asRecord(await pve.call<unknown>("GET", `/nodes/${seg(node)}/query-url-metadata`, { url: u.href, "verify-certificates": query(c, "verifyCertificates") === "false" ? false : undefined }));
          const name = typeof r.filename === "string" ? r.filename : null;
          return { url: u.href, filename: name, size: typeof r.size === "number" ? r.size : null, mimetype: typeof r.mimetype === "string" ? r.mimetype : null, suggestedContent: name ? (ISO_FILE.test(name) ? "iso" : TMPL_FILE.test(name) ? "vztmpl" : IMPORT_FILE.test(name) ? "import" : null) : null };
        });
        c.json(200, out);
      },
    },

    // ---- Usage
    {
      method: "GET",
      re: /^\/api\/storage-tools\/([^/]+)\/usage$/,
      run: async (c, m) => {
        const id = storageId(decodeURIComponent(m[1]));
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const [status, content] = await Promise.all([soft(pve.call<Json>("GET", `/nodes/${seg(node)}/storage/${seg(id)}/status`)), soft(pve.call<Json[]>("GET", `/nodes/${seg(node)}/storage/${seg(id)}/content`))]);
          if (status.denied && content.denied) throw new HttpError(403, "forbidden", "Your Proxmox account doesn't have permission for this");
          const items = content.data ?? [];
          const byKind = new Map<string, { count: number; bytes: number }>();
          const byGuest = new Map<number, { count: number; bytes: number }>();
          for (const i of items) {
            const k = String(i.content ?? "other");
            const e = byKind.get(k) ?? { count: 0, bytes: 0 };
            e.count++;
            e.bytes += typeof i.size === "number" ? i.size : 0;
            byKind.set(k, e);
            if (typeof i.vmid === "number") {
              const g = byGuest.get(i.vmid) ?? { count: 0, bytes: 0 };
              g.count++;
              g.bytes += typeof i.size === "number" ? i.size : 0;
              byGuest.set(i.vmid, g);
            }
          }
          const s = asRecord(status.data);
          const total = typeof s.total === "number" ? s.total : null;
          const used = typeof s.used === "number" ? s.used : null;
          const counted = [...byKind.values()].reduce((a, k) => a + k.bytes, 0);
          return {
            node,
            storage: id,
            type: typeof s.type === "string" ? s.type : null,
            active: s.active === undefined ? null : flag(s.active),
            shared: flag(s.shared),
            total,
            used,
            avail: typeof s.avail === "number" ? s.avail : null,
            percent: total && used !== null ? Math.round((used / total) * 1000) / 10 : null,
            byType: [...byKind.entries()].map(([content, v]) => ({ content, label: KIND_LABEL[content] ?? content, count: v.count, bytes: v.bytes })).sort((a, b) => b.bytes - a.bytes),
            // Space the storage uses that its volumes don't account for (metadata, snapshots, other files, reserved space).
            other: used !== null ? Math.max(0, used - counted) : null,
            byGuest: [...byGuest.entries()].map(([vmid, v]) => ({ vmid, ...v })).sort((a, b) => b.bytes - a.bytes).slice(0, 20),
            largest: items.filter((i) => typeof i.size === "number").sort((a, b) => b.size - a.size).slice(0, 10).map((i) => ({ volid: String(i.volid), content: String(i.content ?? ""), size: i.size as number, vmid: typeof i.vmid === "number" ? i.vmid : null })),
            denied: { status: status.denied, content: content.denied },
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/storage-tools\/([^/]+)\/rrd$/,
      run: async (c, m) => {
        const id = storageId(decodeURIComponent(m[1]));
        const tf = query(c, "timeframe") ?? "day";
        if (!["hour", "day", "week", "month", "year"].includes(tf)) bad("The time frame is hour, day, week, month or year");
        const cf = query(c, "cf") ?? "AVERAGE";
        if (cf !== "AVERAGE" && cf !== "MAX") bad("The consolidation is AVERAGE or MAX");
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const rows = await pve.call<Json[]>("GET", `/nodes/${seg(node)}/storage/${seg(id)}/rrddata`, { timeframe: tf, cf });
          const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
          return { node, storage: id, timeframe: tf, points: rows.map((r) => ({ time: Number(r.time), used: num(r.used), total: num(r.total) })).filter((p) => Number.isFinite(p.time)) };
        });
        c.json(200, out);
      },
    },

    // ---- Retention: preview, then prune
    {
      method: "GET",
      re: /^\/api\/storage-tools\/([^/]+)\/prune$/,
      run: async (c, m) => {
        const id = storageId(decodeURIComponent(m[1]));
        const a = pruneArgs(c, null);
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const [plan, content, def] = await Promise.all([
            pve.call<Json[]>("GET", `/nodes/${seg(node)}/storage/${seg(id)}/prunebackups`, { "prune-backups": a.prune, vmid: a.vmid, type: a.type }),
            soft(pve.call<Json[]>("GET", `/nodes/${seg(node)}/storage/${seg(id)}/content`, { content: "backup" })),
            soft(pve.call<Json>("GET", `/storage/${seg(id)}`)),
          ]);
          const sizes = new Map((content.data ?? []).map((i) => [String(i.volid), typeof i.size === "number" ? i.size : 0]));
          const items = plan.map((p) => ({ volid: String(p.volid), vmid: typeof p.vmid === "number" ? p.vmid : (ownerOf(String(p.volid))?.vmid ?? null), type: typeof p.type === "string" ? p.type : null, ctime: typeof p.ctime === "number" ? p.ctime : null, mark: String(p.mark ?? "keep"), size: sizes.get(String(p.volid)) ?? null }));
          const remove = items.filter((i) => i.mark === "remove");
          const stored = asRecord(def.data)["prune-backups"];
          return {
            node,
            storage: id,
            using: a.settings ? "these settings" : "the storage's own retention",
            retention: a.settings ?? (stored !== undefined ? parsePrune(stored) : null),
            items,
            counts: { keep: items.filter((i) => i.mark === "keep").length, remove: remove.length, protected: items.filter((i) => i.mark === "protected").length, renamed: items.filter((i) => i.mark === "renamed").length },
            bytesToFree: remove.reduce((s, i) => s + (i.size ?? 0), 0),
            note: "A preview. Backups made or removed before you prune can change it.",
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/storage-tools\/([^/]+)\/prune$/,
      run: async (c, m) => {
        c.sameSite();
        const id = storageId(decodeURIComponent(m[1]));
        const body = await c.readJson();
        noExtra(body, ["node", "vmid", "type", "confirm", ...KEEP_QUERY]);
        // Pruning deletes backup files for good; the storage's name is typed.
        confirmed(body, id, `deleting old backups from ${id}`);
        const a = pruneArgs(c, body);
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          const plan = await pve.call<Json[]>("GET", `/nodes/${seg(node)}/storage/${seg(id)}/prunebackups`, { "prune-backups": a.prune, vmid: a.vmid, type: a.type });
          if (!plan.some((p) => p.mark === "remove")) throw new HttpError(409, "nothing_to_prune", "With these settings no backup would be removed, so there is nothing to do.");
          return pve.call<string | null>("DELETE", `/nodes/${seg(node)}/storage/${seg(id)}/prunebackups`, { "prune-backups": a.prune, vmid: a.vmid, type: a.type });
        });
        c.json(200, { task: task ?? null });
      },
    },

    // ---- A volume: details and how to check it
    {
      method: "GET",
      re: /^\/api\/storage-tools\/([^/]+)\/volume$/,
      run: async (c, m) => {
        const id = storageId(decodeURIComponent(m[1]));
        const volid = volumeOf(query(c, "volid"), id);
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const v = asRecord(await pve.call<unknown>("GET", `/nodes/${seg(node)}/storage/${seg(id)}/content/${seg(volid)}`));
          const path = typeof v.path === "string" ? v.path : null;
          const isFile = path !== null && path.startsWith("/");
          return {
            node,
            volid,
            path,
            format: typeof v.format === "string" ? v.format : null,
            size: typeof v.size === "number" ? v.size : null,
            used: typeof v.used === "number" ? v.used : null,
            notes: typeof v.notes === "string" ? v.notes : null,
            protected: flag(v.protected),
            owner: ownerOf(volid),
            // Proxmox has no call that checks a stored file; the person runs one of these on the node.
            verify: isFile ? ALGOS.filter((a) => a !== "md5" && a !== "sha1" && a !== "sha224").map((algorithm) => ({ algorithm, command: `${algorithm}sum ${shq(path)}` })) : [],
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/storage-tools\/([^/]+)\/snippets$/,
      run: async (c, m) => {
        const id = storageId(decodeURIComponent(m[1]));
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const [def, items] = await Promise.all([soft(pve.call<Json>("GET", `/storage/${seg(id)}`)), soft(pve.call<Json[]>("GET", `/nodes/${seg(node)}/storage/${seg(id)}/content`, { content: "snippets" }))]);
          const d = asRecord(def.data);
          const enabled = typeof d.content === "string" ? d.content.split(",").includes("snippets") : null;
          const dir = typeof d.path === "string" ? `${d.path.replace(/\/+$/, "")}/snippets` : null;
          return {
            node,
            storage: id,
            enabled,
            directory: dir,
            files: (items.data ?? []).map((i) => ({ volid: String(i.volid), name: String(i.volid).split("/").pop() ?? "", size: typeof i.size === "number" ? i.size : null, ctime: typeof i.ctime === "number" ? i.ctime : null })),
            // The API accepts uploads of ISO images, templates and import files only; a snippet is a file in a folder.
            guide: dir ? [{ title: "Copy the file to the node", command: `scp hookscript.sh root@${node}:${dir}/`, note: "Run this where the file is. Use the node's address if its name does not resolve." }, { title: "Make a hook script runnable", command: `chmod +x ${dir}/hookscript.sh`, note: "Only for hook scripts. Cloud-init files do not need it." }] : [],
            reason: "Proxmox's API does not take snippet uploads, so the file is copied to the storage folder and then listed here.",
          };
        });
        c.json(200, out);
      },
    },

    // ---- New and copied volumes
    {
      method: "POST",
      re: /^\/api\/storage-tools\/([^/]+)\/allocate$/,
      run: async (c, m) => {
        c.sameSite();
        const id = storageId(decodeURIComponent(m[1]));
        const body = await c.readJson();
        noExtra(body, ["node", "vmid", "name", "sizeGiB", "format"]);
        const vmid = vmidOf(body.vmid);
        const size = typeof body.sizeGiB === "number" && body.sizeGiB >= 0.001 && body.sizeGiB <= 1_048_576 ? body.sizeGiB : bad("The size is a number of GiB");
        const format = body.format === undefined ? undefined : ["raw", "qcow2", "vmdk", "subvol"].includes(String(body.format)) ? String(body.format) : bad("The format is raw, qcow2, vmdk or subvol");
        const name = typeof body.name === "string" && new RegExp(`^(vm|base)-${vmid}-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$`).test(body.name.replace(/\.(raw|qcow2|vmdk)$/, "")) ? body.name : bad(`Name it like vm-${vmid}-disk-1`);
        const volid = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          const exists = (await pve.call<Json[]>("GET", "/cluster/resources", { type: "vm" })).some((r) => r.vmid === vmid);
          if (!exists) throw new HttpError(404, "not_found", `There is no machine ${vmid} in this cluster to own the volume`);
          // The size goes in as GiB with a G suffix, or as KiB for a fraction of one.
          const sz = Number.isInteger(size) ? `${size}G` : String(Math.ceil(size * 1024 * 1024));
          return pve.call<string>("POST", `/nodes/${seg(node)}/storage/${seg(id)}/content`, { vmid, filename: name, size: sz, format });
        });
        c.json(200, { volid });
      },
    },
    {
      method: "POST",
      re: /^\/api\/storage-tools\/([^/]+)\/copy$/,
      run: async (c, m) => {
        c.sameSite();
        const id = storageId(decodeURIComponent(m[1]));
        const body = await c.readJson();
        noExtra(body, ["node", "volume", "target", "targetNode", "acknowledgeExperimental", "confirm"]);
        const volume = volumeOf(body.volume, id);
        const target = volumeOf(body.target, typeof body.target === "string" ? body.target.split(":")[0] : "");
        if (volume === target) bad("The copy needs a different name or storage");
        // Proxmox's own description: "This is experimental code - do not use." So it takes an explicit yes.
        if (body.acknowledgeExperimental !== true) throw new HttpError(409, "experimental", "Proxmox marks copying a volume as experimental. Confirm you understand, and keep a backup of what matters.");
        confirmed(body, volume.split(":")[1].split("/").pop() ?? volume, "copying this volume");
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          const targetNode = body.targetNode === undefined || body.targetNode === "" ? undefined : await resolveNode(c, pve, { node: body.targetNode });
          return pve.call<string | null>("POST", `/nodes/${seg(node)}/storage/${seg(id)}/content/${seg(volume)}`, { target, target_node: targetNode });
        });
        c.json(200, { task: task ?? null });
      },
    },

    // ---- Import files
    {
      method: "POST",
      re: /^\/api\/storage-tools\/([^/]+)\/download-import$/,
      run: async (c, m) => {
        c.sameSite();
        const id = storageId(decodeURIComponent(m[1]));
        const body = await c.readJson();
        noExtra(body, ["node", "url", "filename", "checksum", "algorithm", "verifyCertificates"]);
        const u = pageUrl(body.url);
        const filename = typeof body.filename === "string" && IMPORT_FILE.test(body.filename) ? body.filename : bad("Use a file name ending in .ova, .ovf, .qcow2, .raw or .vmdk");
        const sum = checksumOf(body.checksum, body.algorithm);
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          return pve.downloadUrl(node, id, { url: u.href, content: "import", filename, ...sum, verifyCertificates: body.verifyCertificates !== false });
        });
        c.json(200, { task });
      },
    },
    {
      method: "POST",
      re: /^\/api\/storage-tools\/([^/]+)\/upload-import$/,
      run: async (c, m) => {
        c.sameSite();
        const id = storageId(decodeURIComponent(m[1]));
        const filename = (() => {
          const f = query(c, "filename");
          return typeof f === "string" && IMPORT_FILE.test(f) ? f : bad("Use a file name ending in .ova, .ovf, .qcow2, .raw or .vmdk");
        })();
        const sum = checksumOf(query(c, "checksum") || undefined, query(c, "algorithm"));
        if (c.req.headers["content-type"] !== "application/octet-stream") throw new HttpError(415, "binary_only", "Send the file as application/octet-stream");
        const size = Number(c.req.headers["content-length"]);
        if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(411, "length_required", "The upload needs a Content-Length");
        if (size > 64 * 1024 ** 3) throw new HttpError(413, "too_large", "Uploads are limited to 64 GiB");
        const req = c.req;
        async function* exact() {
          let seen = 0;
          for await (const chunk of req) {
            seen += (chunk as Buffer).length;
            if (seen > size) throw new HttpError(400, "bad_length", "The upload was larger than announced");
            yield chunk as Buffer;
          }
          if (seen !== size) throw new HttpError(400, "bad_length", "The upload ended early");
        }
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          return pve.upload(node, id, { content: "import", filename, size, file: exact(), ...sum });
        });
        c.json(200, { task });
      },
    },
    {
      method: "GET",
      re: /^\/api\/storage-tools\/([^/]+)\/import-metadata$/,
      run: async (c, m) => {
        const id = storageId(decodeURIComponent(m[1]));
        const volume = volumeOf(query(c, "volume"), id);
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const r = asRecord(await pve.call<unknown>("GET", `/nodes/${seg(node)}/storage/${seg(id)}/import-metadata`, { volume }));
          return { node, volume, type: r.type ?? null, source: r.source ?? null, warnings: Array.isArray(r.warnings) ? r.warnings : [], createArgs: asRecord(r["create-args"]), disks: asRecord(r.disks), net: asRecord(r.net) };
        });
        c.json(200, out);
      },
    },
    {
      // Adds an imported image to an existing virtual machine as a new disk (import-from).
      method: "POST",
      re: /^\/api\/storage-tools\/([^/]+)\/import-disk$/,
      run: async (c, m) => {
        c.sameSite();
        const id = storageId(decodeURIComponent(m[1]));
        const body = await c.readJson();
        noExtra(body, ["node", "vmid", "volume", "bus", "targetStorage", "format"]);
        const volume = volumeOf(body.volume, id);
        if (!/\.(qcow2|raw|vmdk|img)$/i.test(volume) && !volume.includes("/import/")) bad("Pick a disk image (qcow2, raw or vmdk) from the import files");
        const vmid = vmidOf(body.vmid);
        const bus = typeof body.bus === "string" && (DISK_BUSES as readonly string[]).includes(body.bus) ? body.bus : bad("Pick SCSI, VirtIO, SATA or IDE");
        const targetStorage = storageId(body.targetStorage);
        const format = body.format === undefined || body.format === "" ? undefined : ["raw", "qcow2", "vmdk"].includes(String(body.format)) ? String(body.format) : bad("The format is raw, qcow2 or vmdk");
        const result = await c.asUser(async (pve) => {
          const { node, cfg } = await readConfig(pve, c.node, vmid);
          if (typeof cfg.lock === "string") throw new HttpError(409, "locked", `Machine ${vmid} is locked (${cfg.lock}). Wait for it to finish.`);
          const key = freeKey(cfg, bus);
          if (!DRIVE_KEY_RE.test(key)) bad("Unknown disk slot");
          const digest = typeof cfg.digest === "string" ? cfg.digest : undefined;
          const value = `${targetStorage}:0,import-from=${volume}${format ? `,format=${format}` : ""}`;
          const task = await pve.call<string | null>("PUT", `/nodes/${seg(node)}/qemu/${vmid}/config`, { [key]: value, digest });
          return { key, task: typeof task === "string" && task.startsWith("UPID:") ? task : null };
        });
        c.json(200, result);
      },
    },
  ];
}

export const handleStorageTools = routeTable("/api/storage-tools/", storageToolsRoutes());

