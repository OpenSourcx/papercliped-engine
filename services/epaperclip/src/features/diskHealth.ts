import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import type { FeatureCtx } from "./index.ts";
import { asRecord, flag, seg } from "./clusterCommon.ts";
import { DEVICE_RE, diskInUse } from "./disksCheck.ts";
import { mapDisk } from "./disks.ts";
import { bad, noExtra, query, resolveNode, soft, type Route } from "./nodeCommon.ts";
import { routeTable } from "./w3Router.ts";

/**
 * How the storage is doing, in one place: every disk's health and wear, the ZFS pools, thin pools and storages that are
 * filling up, with alerts at thresholds the administrator can change. Proxmox keeps no SMART history, so the host
 * service records a sample of each disk now and then (at most one every six hours) and shows the trend.
 *
 * ZFS has no maintenance calls in Proxmox's API (scrub, trim, replace a disk, attach, detach, export, import all happen
 * in a shell there). For those the screen gives the exact commands, built from validated names and checked against the
 * pool's real disks, with what each one does and risks.
 */

type Json = Record<string, any>;
type Level = "ok" | "warning" | "critical";

export interface Thresholds {
  wearWarn: number;
  wearCrit: number;
  usageWarn: number;
  usageCrit: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = { wearWarn: 25, wearCrit: 10, usageWarn: 85, usageCrit: 95 };
const SETTINGS_KEY = "diskhealth.thresholds";
const HISTORY_KEY = "diskhealth.history";
const SAMPLE_EVERY_S = 6 * 3600;
const KEEP_SAMPLES = 120;

export function readThresholds(raw: unknown): Thresholds {
  const r = asRecord(raw);
  const n = (k: keyof Thresholds) => (typeof r[k] === "number" && Number.isFinite(r[k]) ? (r[k] as number) : DEFAULT_THRESHOLDS[k]);
  return { wearWarn: n("wearWarn"), wearCrit: n("wearCrit"), usageWarn: n("usageWarn"), usageCrit: n("usageCrit") };
}
export function checkThresholds(b: Json): Thresholds {
  noExtra(b, ["wearWarn", "wearCrit", "usageWarn", "usageCrit"]);
  const t = readThresholds(b);
  for (const k of Object.keys(b)) if (typeof b[k] !== "number" || !Number.isFinite(b[k])) bad("Thresholds are numbers");
  if (t.wearCrit < 1 || t.wearWarn > 90 || t.wearCrit >= t.wearWarn) bad("Wear alerts count life left: the warning has to be higher than the critical one, for example 25 and 10");
  if (t.usageWarn < 50 || t.usageCrit > 99 || t.usageWarn >= t.usageCrit) bad("Usage alerts: the warning has to be lower than the critical one, for example 85 and 95");
  return t;
}

/** The facts worth showing from a SMART answer, whichever way the disk reports them (ATA table or NVMe text). */
export function smartFacts(raw: Json): { temperature: number | null; powerOnHours: number | null; reallocated: number | null; pending: number | null; percentUsed: number | null; spare: number | null } {
  const out = { temperature: null as number | null, powerOnHours: null as number | null, reallocated: null as number | null, pending: null as number | null, percentUsed: null as number | null, spare: null as number | null };
  const rawNum = (v: unknown): number | null => {
    const m = String(v ?? "").match(/^\s*(\d+)/);
    return m ? Number(m[1]) : null;
  };
  for (const a of Array.isArray(raw.attributes) ? (raw.attributes as Json[]) : []) {
    const id = Number(a.id);
    const name = String(a.name ?? "").toLowerCase();
    if (id === 5 || name.startsWith("reallocated_sector")) out.reallocated = rawNum(a.raw);
    else if (id === 197 || name.startsWith("current_pending")) out.pending = rawNum(a.raw);
    else if (id === 9 || name.startsWith("power_on_hours")) out.powerOnHours = rawNum(a.raw);
    else if (id === 194 || id === 190 || name.startsWith("temperature")) out.temperature ??= rawNum(a.raw);
  }
  const text = typeof raw.text === "string" ? raw.text : "";
  const grab = (re: RegExp) => {
    const m = text.match(re);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  };
  out.temperature ??= grab(/^Temperature:\s+(\d+)/im);
  out.powerOnHours ??= grab(/^Power On Hours:\s+([\d,]+)/im);
  out.percentUsed ??= grab(/^Percentage Used:\s+(\d+)%/im);
  out.spare = grab(/^Available Spare:\s+(\d+)%/im);
  return out;
}

const worse = (a: Level, b: Level): Level => (a === "critical" || b === "critical" ? "critical" : a === "warning" || b === "warning" ? "warning" : "ok");

export interface Alert {
  level: Exclude<Level, "ok">;
  kind: "disk-health" | "disk-wear" | "disk-errors" | "pool-health" | "pool-usage" | "storage-usage" | "thin-usage";
  subject: string;
  message: string;
}

export function summarize(input: { disks: Json[]; facts: Map<string, ReturnType<typeof smartFacts>>; pools: Json[]; thin: Json[]; storages: Json[]; thresholds: Thresholds }) {
  const t = input.thresholds;
  const alerts: Alert[] = [];
  const add = (level: Alert["level"], kind: Alert["kind"], subject: string, message: string) => alerts.push({ level, kind, subject, message });
  const disks = input.disks.map((d) => {
    const f = input.facts.get(String(d.devpath)) ?? null;
    let level: Level = "ok";
    const name = String(d.devpath);
    if (String(d.health ?? "").toUpperCase() === "FAILED") {
      level = "critical";
      add("critical", "disk-health", name, `${name} failed its SMART health check. Replace it and keep a copy of what is on it.`);
    }
    const wear = typeof d.wearoutPct === "number" ? d.wearoutPct : null;
    if (wear !== null) {
      if (wear <= t.wearCrit) {
        level = "critical";
        add("critical", "disk-wear", name, `${name} has ${wear}% of its life left. Plan a replacement now.`);
      } else if (wear <= t.wearWarn) {
        level = worse(level, "warning");
        add("warning", "disk-wear", name, `${name} has ${wear}% of its life left.`);
      }
    }
    if (f && ((f.reallocated ?? 0) > 0 || (f.pending ?? 0) > 0)) {
      level = worse(level, "warning");
      add("warning", "disk-errors", name, `${name} has ${f.reallocated ?? 0} reallocated and ${f.pending ?? 0} pending sectors. A drive that is remapping sectors tends to get worse.`);
    }
    if (f?.spare !== null && f?.spare !== undefined && f.spare <= 10) {
      level = "critical";
      add("critical", "disk-wear", name, `${name} has only ${f.spare}% spare capacity left.`);
    }
    return { devpath: name, type: d.type, model: d.model, serial: d.serial, sizeBytes: d.sizeBytes, usedBy: d.usedBy, health: d.health, wearoutPct: wear, level, facts: f };
  });
  const pools = input.pools.map((p) => {
    const health = String(p.health ?? "UNKNOWN");
    const size = typeof p.size === "number" ? p.size : 0;
    const used = size ? (Number(p.alloc ?? 0) / size) * 100 : null;
    let level: Level = "ok";
    if (health !== "ONLINE") {
      level = health === "DEGRADED" ? "warning" : "critical";
      add(level, "pool-health", String(p.name), `The ZFS pool ${p.name} is ${health.toLowerCase()}.${health === "DEGRADED" ? " It still works, but a disk has failed or is missing; replace it before another one goes." : ""}`);
    }
    if (used !== null && used >= t.usageCrit) (level = "critical"), add("critical", "pool-usage", String(p.name), `The pool ${p.name} is ${Math.round(used)}% full. ZFS slows down badly near full.`);
    else if (used !== null && used >= t.usageWarn) (level = worse(level, "warning")), add("warning", "pool-usage", String(p.name), `The pool ${p.name} is ${Math.round(used)}% full.`);
    return { name: String(p.name), health, sizeBytes: size, allocBytes: Number(p.alloc ?? 0), freeBytes: Number(p.free ?? 0), fragmentation: typeof p.frag === "number" ? p.frag : null, percentUsed: used === null ? null : Math.round(used * 10) / 10, level };
  });
  const thin = input.thin.map((x) => {
    const size = Number(x.lv_size ?? 0);
    const used = size ? (Number(x.used ?? 0) / size) * 100 : null;
    const meta = Number(x.metadata_size ?? 0) ? (Number(x.metadata_used ?? 0) / Number(x.metadata_size)) * 100 : null;
    let level: Level = "ok";
    for (const [what, pct] of [["data", used], ["metadata", meta]] as const) {
      if (pct === null) continue;
      // A thin pool that fills up stops every machine on it, and metadata is the part that runs out first.
      if (pct >= t.usageCrit) (level = "critical"), add("critical", "thin-usage", `${x.vg}/${x.lv}`, `The thin pool ${x.vg}/${x.lv} has its ${what} ${Math.round(pct)}% full. Machines on it will stop when it fills.`);
      else if (pct >= t.usageWarn) (level = worse(level, "warning")), add("warning", "thin-usage", `${x.vg}/${x.lv}`, `The thin pool ${x.vg}/${x.lv} has its ${what} ${Math.round(pct)}% full.`);
    }
    return { name: `${x.vg}/${x.lv}`, sizeBytes: size, percentUsed: used === null ? null : Math.round(used * 10) / 10, metadataPercent: meta === null ? null : Math.round(meta * 10) / 10, level };
  });
  const storages = input.storages.filter((s) => flag(s.active) && typeof s.total === "number" && s.total > 0).map((s) => {
    const pct = (Number(s.used ?? 0) / s.total) * 100;
    let level: Level = "ok";
    if (pct >= t.usageCrit) (level = "critical"), add("critical", "storage-usage", String(s.storage), `Storage ${s.storage} is ${Math.round(pct)}% full.`);
    else if (pct >= t.usageWarn) (level = "warning"), add("warning", "storage-usage", String(s.storage), `Storage ${s.storage} is ${Math.round(pct)}% full.`);
    return { storage: String(s.storage), type: String(s.type ?? ""), shared: flag(s.shared), total: s.total as number, used: Number(s.used ?? 0), percentUsed: Math.round(pct * 10) / 10, level };
  });
  const inactive = input.storages.filter((s) => s.active !== undefined && !flag(s.active) && !flag(s.disable)).map((s) => String(s.storage));
  for (const s of inactive) add("warning", "storage-usage", s, `Storage ${s} is configured but not active on this node.`);
  const level = alerts.some((a) => a.level === "critical") ? "critical" : alerts.length ? "warning" : "ok";
  return { level: level as Level, alerts: alerts.sort((a, b) => (a.level === b.level ? 0 : a.level === "critical" ? -1 : 1)), disks, pools, thin, storages, inactive };
}

interface Sample {
  t: number;
  wear: number | null;
  health: string | null;
  temperature: number | null;
  hours: number | null;
  reallocated: number | null;
  pending: number | null;
}
type History = Record<string, Sample[]>;

const histKey = (d: { serial?: unknown; devpath?: unknown }) => String(d.serial || d.devpath);

function record(ctx: FeatureCtx, node: string, disks: ReturnType<typeof summarize>["disks"], raw: Json[]): void {
  const all = ctx.state.getSetting<Record<string, History>>(HISTORY_KEY) ?? {};
  const mine: History = all[node] ?? {};
  const now = Math.floor(ctx.now() / 1000);
  let changed = false;
  for (const d of disks) {
    const src = raw.find((r) => r.devpath === d.devpath);
    const key = histKey({ serial: src?.serial, devpath: d.devpath });
    const list = mine[key] ?? [];
    const last = list[list.length - 1];
    if (last && now - last.t < SAMPLE_EVERY_S) continue;
    list.push({ t: now, wear: d.wearoutPct, health: typeof d.health === "string" ? d.health : null, temperature: d.facts?.temperature ?? null, hours: d.facts?.powerOnHours ?? null, reallocated: d.facts?.reallocated ?? null, pending: d.facts?.pending ?? null });
    mine[key] = list.slice(-KEEP_SAMPLES);
    changed = true;
  }
  if (changed) ctx.state.setSetting(HISTORY_KEY, { ...all, [node]: mine });
}

// ---- ZFS commands

const POOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const VDEV = /^(?!.*\.\.)\/?[A-Za-z0-9][A-Za-z0-9/_.:+-]{0,200}$/;
const RESERVED_POOL = /^(mirror|raidz[123]?|draid\d*|spare|log|cache|special|dedup)(-\d+)?$/;

export interface ZfsStep {
  title: string;
  command: string | null;
  note: string | null;
  risk: "none" | "low" | "high";
}

export function leafNames(tree: Json | null | undefined): string[] {
  const out: string[] = [];
  const walk = (n: Json) => {
    if (n.leaf === 1 || n.leaf === true || !Array.isArray(n.children) || !n.children.length) out.push(String(n.name));
    for (const ch of (n.children ?? []) as Json[]) walk(ch);
  };
  for (const ch of (tree?.children ?? []) as Json[]) walk(ch);
  return out;
}

export function zfsGuide(action: string, pool: string, p: { device: string | null; newDevice: string | null; members: string[]; storages: string[]; importName: string | null }): { steps: ZfsStep[]; cautions: string[] } {
  const needDevice = () => {
    if (!p.device) return bad("Pick the disk in the pool");
    if (p.members.length && !p.members.some((m) => m === p.device || p.device!.endsWith(`/${m}`) || m.endsWith(`/${p.device}`))) return bad(`${p.device} isn't one of the disks in ${pool}`);
    return p.device;
  };
  const needNew = () => (p.newDevice ? p.newDevice : bad("Pick the new disk"));
  const steps: ZfsStep[] = [];
  const cautions: string[] = [];
  switch (action) {
    case "scrub":
      steps.push({ title: "Start a scrub", command: `zpool scrub ${pool}`, note: "Reads every block and repairs what it can from the other copies. It runs in the background and slows the pool down while it works.", risk: "low" }, { title: "Watch it", command: `zpool status ${pool}`, note: "The scan line shows progress and any errors found.", risk: "none" });
      cautions.push("Schedule scrubs for quiet hours. Proxmox already runs one monthly on its own.");
      break;
    case "scrub-stop":
      steps.push({ title: "Stop the scrub", command: `zpool scrub -s ${pool}`, note: "The next scrub starts from the beginning.", risk: "none" });
      break;
    case "scrub-pause":
      steps.push({ title: "Pause the scrub", command: `zpool scrub -p ${pool}`, note: "Run the scrub command again to carry on from where it stopped.", risk: "none" });
      break;
    case "trim":
      steps.push({ title: "Trim free space", command: `zpool trim ${pool}`, note: "Tells SSDs which blocks are free. Only useful on SSD or NVMe pools.", risk: "low" }, { title: "Watch it", command: `zpool status -t ${pool}`, note: null, risk: "none" });
      break;
    case "trim-stop":
      steps.push({ title: "Stop trimming", command: `zpool trim -s ${pool}`, note: null, risk: "none" });
      break;
    case "autotrim":
      steps.push({ title: "Trim automatically from now on", command: `zpool set autotrim=on ${pool}`, note: "Continuous trim adds a little work to every delete. A weekly manual trim is gentler on some drives.", risk: "low" });
      break;
    case "clear":
      steps.push({ title: "Clear the error counters", command: `zpool clear ${pool}`, note: "Only resets the counters. If errors come back, the disk or its cable is the cause.", risk: "low" });
      break;
    case "offline": {
      const d = needDevice();
      steps.push({ title: "Take the disk offline", command: `zpool offline ${pool} ${d}`, note: "The pool keeps working on its other disks, with less protection until it is back.", risk: "low" });
      cautions.push("On a pool with no redundancy, taking a disk offline is refused.");
      break;
    }
    case "online": {
      const d = needDevice();
      steps.push({ title: "Bring the disk online", command: `zpool online ${pool} ${d}`, note: "It catches up (resilvers) with what it missed.", risk: "none" });
      break;
    }
    case "replace": {
      const d = needDevice();
      const n = needNew();
      if (d === n) bad("The new disk has to be a different disk");
      steps.push(
        { title: "Replace the disk", command: `zpool replace ${pool} ${d} ${n}`, note: "ZFS copies the data onto the new disk (resilvering). The old disk stays in use until that finishes.", risk: "high" },
        { title: "Watch the resilver", command: `zpool status ${pool}`, note: "Wait until it says resilvered and the pool is ONLINE before removing the old disk.", risk: "none" },
      );
      cautions.push(`Everything on ${n} is erased.`, "Use /dev/disk/by-id names so the pool still finds its disks if device letters change.", "Keep the pool's other disks healthy while it resilvers; a second failure during a resilver on RAID-Z1 or a mirror can lose the pool.");
      break;
    }
    case "attach": {
      const d = needDevice();
      const n = needNew();
      steps.push({ title: "Add a mirror copy", command: `zpool attach ${pool} ${d} ${n}`, note: "Turns a single disk into a mirror, or adds one more copy to a mirror. The new disk is filled by resilvering.", risk: "high" });
      cautions.push(`Everything on ${n} is erased.`, "The new disk must be at least as large as the one it mirrors.");
      break;
    }
    case "detach": {
      const d = needDevice();
      steps.push({ title: "Remove a disk from a mirror", command: `zpool detach ${pool} ${d}`, note: "Only for a disk in a mirror. The pool keeps one copy fewer.", risk: "high" });
      cautions.push("On the last copy, ZFS refuses. On a two-way mirror this leaves the pool without redundancy.");
      break;
    }
    case "export":
      steps.push({ title: "Stop everything using the pool", command: null, note: p.storages.length ? `Storage ${p.storages.join(", ")} uses this pool. Stop or move the machines on it and disable the storage first.` : "Stop anything that uses the pool.", risk: "high" }, { title: "Export", command: `zpool export ${pool}`, note: "The pool becomes unavailable on this node, and can be imported on this or another one. It is not deleted.", risk: "high" });
      cautions.push("Machines running from this pool will stop working.");
      break;
    case "import": {
      const n = p.importName ?? pool;
      steps.push({ title: "See what can be imported", command: "zpool import", note: "Lists pools found on the disks. Nothing is changed.", risk: "none" }, { title: "Import", command: `zpool import ${n}${p.importName && p.importName !== pool ? ` ${pool}` : ""}`, note: "Brings the pool in under its name (or renames it with the second name).", risk: "low" });
      cautions.push("A pool still in use by another node will refuse to import. Export it there first; forcing it (-f) can corrupt it if the other node is still writing.");
      break;
    }
    case "status":
      steps.push({ title: "Detailed status", command: `zpool status -v ${pool}`, note: "-v also lists files with unrecoverable errors.", risk: "none" }, { title: "I/O per disk", command: `zpool iostat -v ${pool} 5`, note: "Press Ctrl+C to stop.", risk: "none" });
      break;
    default:
      return bad("Choose scrub, trim, replace, attach, detach, offline, online, clear, export, import or status");
  }
  return { steps, cautions };
}

/** Datasets and zvols on a pool, as far as Proxmox lists them: the volumes on the storages that use the pool. */
async function poolVolumes(pve: ProxmoxClient, node: string, pool: string) {
  const defs = ((await soft(pve.call<Json[]>("GET", "/storage"))).data ?? []).filter((s) => s.type === "zfspool" && typeof s.pool === "string" && (s.pool === pool || s.pool.startsWith(`${pool}/`)));
  const mine = defs.filter((s) => !s.nodes || String(s.nodes).split(",").includes(node));
  const volumes: { storage: string; dataset: string; volid: string; kind: "zvol" | "dataset"; sizeBytes: number | null; vmid: number | null; format: string | null }[] = [];
  await Promise.all(
    mine.map(async (s) => {
      const items = (await soft(pve.call<Json[]>("GET", `/nodes/${seg(node)}/storage/${seg(String(s.storage))}/content`))).data ?? [];
      for (const i of items) {
        const volid = String(i.volid);
        const name = volid.split(":")[1] ?? volid;
        volumes.push({ storage: String(s.storage), dataset: `${s.pool}/${name}`, volid, kind: i.format === "subvol" || name.startsWith("subvol-") ? "dataset" : "zvol", sizeBytes: typeof i.size === "number" ? i.size : null, vmid: typeof i.vmid === "number" ? i.vmid : null, format: typeof i.format === "string" ? i.format : null });
      }
    }),
  );
  return { storages: mine.map((s) => String(s.storage)), volumes: volumes.sort((a, b) => a.dataset.localeCompare(b.dataset)) };
}

export function diskHealthRoutes(): Route[] {
  return [
    {
      method: "GET",
      re: /^\/api\/disk-health$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const base = `/nodes/${seg(node)}`;
          const [list, pools, thin, storages] = await Promise.all([
            soft(pve.call<Json[]>("GET", `${base}/disks/list`)),
            soft(pve.call<Json[]>("GET", `${base}/disks/zfs`)),
            soft(pve.call<Json[]>("GET", `${base}/disks/lvmthin`)),
            soft(pve.call<Json[]>("GET", `${base}/storage`)),
          ]);
          if (list.denied && storages.denied) throw new HttpError(403, "forbidden", "Your Proxmox account doesn't have permission for this");
          const mapped = (list.data ?? []).map((d) => mapDisk(d as never) as unknown as Json).filter((d) => !d.parent);
          // SMART gives temperature, hours and sector counts the list does not; one call per disk, a few at a time.
          const facts = new Map<string, ReturnType<typeof smartFacts>>();
          const physical = mapped.filter((d) => d.type !== "unknown").slice(0, 32);
          for (let i = 0; i < physical.length; i += 8) {
            await Promise.all(
              physical.slice(i, i + 8).map(async (d) => {
                const r = await soft(pve.call<Json>("GET", `${base}/disks/smart`, { disk: String(d.devpath) }));
                if (r.data) facts.set(String(d.devpath), smartFacts(r.data));
              }),
            );
          }
          const thresholds = readThresholds(c.state.getSetting(SETTINGS_KEY));
          const summary = summarize({ disks: mapped, facts, pools: pools.data ?? [], thin: thin.data ?? [], storages: storages.data ?? [], thresholds });
          try {
            record(c, node, summary.disks, list.data ?? []);
          } catch {
            // The trend is a convenience; a full disk on this host never hides the health summary.
          }
          return { node, thresholds, ...summary, denied: { disks: list.denied, pools: pools.denied, storages: storages.denied } };
        });
        c.json(200, out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/disk-health\/settings$/,
      run: async (c) => c.json(200, { thresholds: readThresholds(c.state.getSetting(SETTINGS_KEY)), defaults: DEFAULT_THRESHOLDS }),
    },
    {
      method: "PUT",
      re: /^\/api\/disk-health\/settings$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        const t = checkThresholds(body);
        await c.asUser(async (pve) => {
          // The thresholds are shared by everyone who looks at this node, so only an administrator sets them.
          if (!(await c.isNodeAdmin(pve))) throw new HttpError(403, "forbidden", "Your Proxmox account doesn't have permission for this");
        });
        c.state.setSetting(SETTINGS_KEY, t);
        c.json(200, { thresholds: t });
      },
    },
    {
      method: "GET",
      re: /^\/api\/disk-health\/history$/,
      run: async (c) => {
        const disk = query(c, "disk");
        if (typeof disk !== "string" || !DEVICE_RE.test(disk)) bad("Pick a disk");
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const list = (await pve.call<Json[]>("GET", `/nodes/${seg(node)}/disks/list`)).find((d) => d.devpath === disk);
          if (!list) throw new HttpError(404, "not_found", "That disk isn't on this node");
          const all = c.state.getSetting<Record<string, History>>(HISTORY_KEY) ?? {};
          const samples = all[node]?.[histKey(list)] ?? [];
          return { node, disk, serial: list.serial ?? null, samples, every: "about every six hours", note: "Proxmox keeps no SMART history. These are samples taken while someone had this page open." };
        });
        c.json(200, out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/disk-health\/zfs\/([^/]+)$/,
      run: async (c, m) => {
        const pool = decodeURIComponent(m[1]);
        if (!POOL_NAME.test(pool) || RESERVED_POOL.test(pool)) bad("That isn't a pool name");
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const detail = await soft(pve.call<Json>("GET", `/nodes/${seg(node)}/disks/zfs/${seg(pool)}`));
          if (detail.denied) throw new HttpError(403, "forbidden", "Your Proxmox account doesn't have permission for this");
          if (detail.error) throw new HttpError(404, "not_found", `This node has no ZFS pool called ${pool}`);
          const d = asRecord(detail.data);
          const vols = await poolVolumes(pve, node, pool);
          return {
            node,
            name: pool,
            state: String(d.state ?? "UNKNOWN"),
            status: typeof d.status === "string" ? d.status : null,
            action: typeof d.action === "string" ? d.action : null,
            scan: typeof d.scan === "string" ? d.scan : null,
            errors: typeof d.errors === "string" ? d.errors : null,
            tree: d.children ?? [],
            disks: leafNames(d),
            storages: vols.storages,
            volumes: vols.volumes,
            actions: ["scrub", "scrub-stop", "scrub-pause", "trim", "trim-stop", "autotrim", "clear", "offline", "online", "replace", "attach", "detach", "export", "import", "status"],
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/disk-health\/zfs\/([^/]+)\/guide$/,
      run: async (c, m) => {
        const pool = decodeURIComponent(m[1]);
        if (!POOL_NAME.test(pool) || RESERVED_POOL.test(pool)) bad("That isn't a pool name");
        const action = query(c, "action") ?? "status";
        const vdev = (k: string): string | null => {
          const v = query(c, k);
          if (v === null || v === "") return null;
          return VDEV.test(v) ? v : bad("That isn't a disk name");
        };
        const device = vdev("device");
        const newDevice = vdev("newDevice");
        const importName = vdev("importName");
        if (importName && !POOL_NAME.test(importName)) bad("That isn't a pool name");
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const detail = await soft(pve.call<Json>("GET", `/nodes/${seg(node)}/disks/zfs/${seg(pool)}`));
          const members = action === "import" ? [] : leafNames(asRecord(detail.data));
          if (action !== "import" && detail.error) throw new HttpError(404, "not_found", `This node has no ZFS pool called ${pool}`);
          // A new disk must be free, or ZFS would be told to erase something in use.
          if (newDevice && (action === "replace" || action === "attach")) {
            const disks = (await soft(pve.call<Json[]>("GET", `/nodes/${seg(node)}/disks/list`, { "include-partitions": true }))).data ?? [];
            const target = disks.find((d) => d.devpath === newDevice || String(d.devpath).endsWith(`/${newDevice}`));
            if (!target && newDevice.startsWith("/dev/") && !newDevice.startsWith("/dev/disk/")) throw new HttpError(404, "no_disk", `${newDevice} isn't a disk on this node`);
            const why = target ? diskInUse({ used: target.used as string | undefined, mounted: target.mounted === true }) : null;
            if (why) throw new HttpError(409, "in_use", `${newDevice} is in use: ${why}.`);
          }
          const vols = await poolVolumes(pve, node, pool);
          return { node, pool, action, ...zfsGuide(action, pool, { device, newDevice, members, storages: vols.storages, importName }) };
        });
        c.json(200, out);
      },
    },
  ];
}

export const handleDiskHealth = routeTable("/api/disk-health", diskHealthRoutes());
