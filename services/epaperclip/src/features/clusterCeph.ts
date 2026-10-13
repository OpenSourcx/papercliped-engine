import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import { asRecord, flag, intIn, seg } from "./clusterCommon.ts";
import { bad, confirmed, noExtra, resolveNode, soft, type Route } from "./nodeCommon.ts";

/**
 * Ceph, read first: health, monitors, managers, metadata servers, OSDs, pools and CephFS, the cluster flags and the
 * configuration. The writes that are reversible and can't lose data are here: bringing an OSD in or out and scrubbing
 * it, setting a cluster flag, muting a health warning, creating a pool and tuning one. Installing Ceph, creating or
 * destroying monitors, OSDs and pools, and starting or stopping its services stay in Proxmox (pveceph), where the
 * long-running work and its prompts belong.
 */

const FLAGS = ["nobackfill", "nodeep-scrub", "nodown", "noin", "noout", "norebalance", "norecover", "noscrub", "notieragent", "noup", "pause"] as const;
const NOT_SET_UP = /ceph|rados|not (been )?(installed|initialized|configured)|binary|no valid/i;
const POOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

type Json = Record<string, any>;

async function listOf(pve: ProxmoxClient, path: string) {
  return soft(pve.call<Json[]>("GET", path));
}

function summarizeStatus(raw: Json) {
  const health = asRecord(raw.health);
  const checks = Object.entries(asRecord(health.checks)).map(([code, v]) => {
    const c = asRecord(v);
    return { code, severity: String(c.severity ?? ""), message: String(asRecord(c.summary).message ?? ""), muted: flag(c.muted) };
  });
  const pg = asRecord(raw.pgmap);
  const osd = asRecord(raw.osdmap);
  const mon = asRecord(raw.monmap);
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    health: String(health.status ?? "UNKNOWN"),
    checks,
    fsid: typeof raw.fsid === "string" ? raw.fsid : null,
    monitors: { total: num(mon.num_mons), quorum: Array.isArray(raw.quorum_names) ? (raw.quorum_names as string[]) : [] },
    osds: { total: num(osd.num_osds ?? asRecord(osd.osdmap).num_osds), up: num(osd.num_up_osds ?? asRecord(osd.osdmap).num_up_osds), in: num(osd.num_in_osds ?? asRecord(osd.osdmap).num_in_osds) },
    pgs: { total: num(pg.num_pgs), states: ((pg.pgs_by_state ?? []) as Json[]).map((s) => ({ state: String(s.state_name), count: Number(s.count) })) },
    usage: { used: num(pg.bytes_used), available: num(pg.bytes_avail), total: num(pg.bytes_total) },
    io: { readBytes: num(pg.read_bytes_sec), writeBytes: num(pg.write_bytes_sec), readOps: num(pg.read_op_per_sec), writeOps: num(pg.write_op_per_sec) },
  };
}

/** The OSD tree, flattened to OSDs with the host each lives on. */
function flattenOsds(tree: Json): { osds: Json[]; flags: string[] } {
  const osds: Json[] = [];
  const walk = (n: Json, host: string | null) => {
    if (n.type === "osd") {
      osds.push({
        id: Number(n.id),
        name: String(n.name ?? `osd.${n.id}`),
        host: (n.host as string | undefined) ?? host,
        status: String(n.status ?? "unknown"),
        in: n.in === undefined ? null : flag(n.in),
        deviceClass: (n.device_class as string | undefined) ?? null,
        used: typeof n.bytes_used === "number" ? n.bytes_used : null,
        total: typeof n.total_space === "number" ? n.total_space : null,
        percentUsed: typeof n.percent_used === "number" ? n.percent_used : null,
        pgs: typeof n.pgs === "number" ? n.pgs : null,
        commitLatencyMs: typeof n.commit_latency_ms === "number" ? n.commit_latency_ms : null,
        applyLatencyMs: typeof n.apply_latency_ms === "number" ? n.apply_latency_ms : null,
        version: (n.version as string | undefined) ?? null,
      });
    }
    for (const ch of (n.children ?? []) as Json[]) walk(ch, n.type === "host" ? String(n.name) : host);
  };
  const root = asRecord(tree.root);
  if (Object.keys(root).length) walk(root, null);
  const flags = typeof tree.flags === "string" && tree.flags ? tree.flags.split(",").filter(Boolean) : [];
  return { osds: osds.sort((a, b) => a.id - b.id), flags };
}

export function clusterCephRoutes(): Route[] {
  return [
    {
      method: "GET",
      re: /^\/api\/cluster\/ceph$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const base = `/nodes/${seg(node)}/ceph`;
          const status = await soft(pve.call<Json>("GET", `${base}/status`));
          if (status.denied) return { node, installed: true, denied: true };
          if (status.error && NOT_SET_UP.test(status.error)) return { node, installed: false, denied: false, reason: status.error };
          if (status.error) throw new HttpError(502, "proxmox_error", status.error);
          const [mons, mgrs, mds, osd, pools, fs, flags, mutes] = await Promise.all([
            listOf(pve, `${base}/mon`),
            listOf(pve, `${base}/mgr`),
            listOf(pve, `${base}/mds`),
            soft(pve.call<Json>("GET", `${base}/osd`)),
            listOf(pve, `${base}/pool`),
            listOf(pve, `${base}/fs`),
            listOf(pve, "/cluster/ceph/flags"),
            soft(pve.call<unknown>("GET", "/cluster/ceph/health-mute")),
          ]);
          const tree = flattenOsds(asRecord(osd.data));
          const map = (l: { data: Json[] | null }, f: (x: Json) => Json) => (l.data ?? []).map(f);
          const flagList = flags.data
            ? flags.data.map((f) => ({ name: String(f.name), description: String(f.description ?? ""), value: flag(f.value) }))
            : FLAGS.map((n) => ({ name: n as string, description: "", value: tree.flags.includes(n) }));
          return {
            node,
            installed: true,
            denied: false,
            status: summarizeStatus(asRecord(status.data)),
            monitors: map(mons, (m) => ({ name: String(m.name), host: (m.host as string | undefined) ?? null, addr: (m.addr as string | undefined) ?? null, rank: m.rank ?? null, quorum: m.quorum === undefined ? null : flag(m.quorum), state: (m.state as string | undefined) ?? null, version: (m.ceph_version_short as string | undefined) ?? null })),
            managers: map(mgrs, (m) => ({ name: String(m.name), host: (m.host as string | undefined) ?? null, addr: (m.addr as string | undefined) ?? null, state: (m.state as string | undefined) ?? null, version: (m.ceph_version_short as string | undefined) ?? null })),
            metadataServers: map(mds, (m) => ({ name: String(m.name), host: (m.host as string | undefined) ?? null, addr: (m.addr as string | undefined) ?? null, state: (m.state as string | undefined) ?? null, standbyReplay: flag(m.standby_replay), rank: m.rank ?? null })),
            osds: tree.osds,
            pools: map(pools, (p) => ({
              name: String(p.pool_name ?? p.pool),
              size: p.size ?? null,
              minSize: p.min_size ?? null,
              pgNum: p.pg_num ?? null,
              autoscale: (p.pg_autoscale_mode as string | undefined) ?? null,
              crushRule: (p.crush_rule_name as string | undefined) ?? (p.crush_rule !== undefined ? String(p.crush_rule) : null),
              application: Object.keys(asRecord(p.application_metadata))[0] ?? null,
              used: typeof p.bytes_used === "number" ? p.bytes_used : null,
              percentUsed: typeof p.percent_used === "number" ? p.percent_used : null,
              type: (p.type as string | undefined) ?? null,
              targetSizeRatio: typeof p.target_size_ratio === "number" ? p.target_size_ratio : null,
            })),
            filesystems: map(fs, (f) => ({ name: String(f.name), metadataPool: (f.metadata_pool as string | undefined) ?? null, dataPool: (f.data_pool as string | undefined) ?? null })),
            flags: flagList,
            mutes: Array.isArray(mutes.data) ? (mutes.data as Json[]).map((m) => String(m.code ?? m)) : [],
            readOnly: { managers: mgrs.denied, monitors: mons.denied, pools: pools.denied },
          };
        });
        c.json(200, out);
      },
    },
    {
      // The configuration file, the placement rules and the log, for reading.
      method: "GET",
      re: /^\/api\/cluster\/ceph\/config$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const base = `/nodes/${seg(node)}/ceph`;
          const [cfg, rules, log] = await Promise.all([
            soft(pve.call<string>("GET", `${base}/cfg/raw`)),
            listOf(pve, `${base}/rules`),
            soft(pve.call<{ n: number; t: string }[]>("GET", `${base}/log`, { limit: 200 })),
          ]);
          // The file holds no keys by design, but a line that looks like one never leaves the host service.
          const text = typeof cfg.data === "string" ? cfg.data.slice(0, 200_000).split("\n").map((l) => (/^\s*(key|secret)\s*=/i.test(l) ? l.replace(/=.*/, "= …") : l)).join("\n") : null;
          return { node, config: text, rules: (rules.data ?? []).map((r) => ({ name: String(r.name ?? r.rule_name), id: r.rule_id ?? null })), log: (log.data ?? []).map((l) => l.t), denied: cfg.denied };
        });
        c.json(200, out);
      },
    },

    // ---- OSDs: in, out and scrub (all reversible)
    {
      method: "POST",
      re: /^\/api\/cluster\/ceph\/osd\/(\d+)\/(in|out|scrub)$/,
      run: async (c, m) => {
        c.sameSite();
        const id = intIn(m[1], 0, 100_000, "The OSD number");
        const action = m[2];
        const body = await c.readJson();
        noExtra(body, ["node", "confirm", "deep"]);
        // Taking an OSD out starts moving its data to the others, which can load the cluster for hours.
        if (action === "out") confirmed(body, `osd.${id}`, `taking osd.${id} out`);
        await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          await pve.call("POST", `/nodes/${seg(node)}/ceph/osd/${id}/${action}`, action === "scrub" ? { deep: body.deep === true ? true : undefined } : undefined);
        });
        c.json(200, { ok: true });
      },
    },

    // ---- Flags and muted health checks
    {
      method: "PUT",
      re: /^\/api\/cluster\/ceph\/flags$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["flag", "value", "confirm"]);
        const name = (FLAGS as readonly unknown[]).includes(body.flag) ? (body.flag as string) : bad("That isn't a Ceph flag");
        if (typeof body.value !== "boolean") bad("A flag is set or cleared");
        // Pause stops every read and write in the cluster.
        if (name === "pause" && body.value === true) confirmed(body, "pause", "pausing all Ceph reads and writes");
        await c.asUser((pve) => pve.call("PUT", `/cluster/ceph/flags/${seg(name)}`, { value: body.value as boolean }));
        c.json(200, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/cluster\/ceph\/health-mute$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["code", "value", "ttl", "sticky"]);
        const code = typeof body.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(body.code) && body.code.length <= 64 ? body.code : bad("That isn't a Ceph health check");
        if (typeof body.value !== "boolean") bad("A check is muted or unmuted");
        const ttl = body.ttl === undefined || body.ttl === "" ? undefined : typeof body.ttl === "string" && /^\d+[ \t]*(s|m|h|d|w)$/.test(body.ttl) ? body.ttl : bad("How long to mute for: a number and s, m, h, d or w (for example 2h)");
        await c.asUser((pve) => pve.call("PUT", `/cluster/ceph/health-mute/${seg(code)}`, { value: body.value as boolean, ttl: body.value ? ttl : undefined, sticky: body.sticky === true ? true : undefined }));
        c.json(200, { ok: true });
      },
    },

    // ---- Pools: create and tune
    {
      method: "POST",
      re: /^\/api\/cluster\/ceph\/pools$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "name", "size", "minSize", "pgNum", "autoscale", "application", "addStorages", "targetSizeRatio"]);
        const name = typeof body.name === "string" && POOL_NAME.test(body.name) ? body.name : bad("A pool name uses letters, numbers, . _ and - (up to 63 characters)");
        const size = body.size === undefined ? 3 : intIn(body.size, 2, 7, "Copies per object");
        const minSize = body.minSize === undefined ? Math.min(2, size) : intIn(body.minSize, 1, 7, "Minimum copies");
        if (minSize > size) bad("The minimum number of copies can't be more than the number of copies");
        const pgNum = body.pgNum === undefined ? undefined : intIn(body.pgNum, 1, 32768, "Placement groups");
        if (body.autoscale !== undefined && !["on", "off", "warn"].includes(String(body.autoscale))) bad("Autoscale is on, off or warn");
        if (body.application !== undefined && !["rbd", "cephfs", "rgw"].includes(String(body.application))) bad("The application is rbd, cephfs or rgw");
        const ratio = body.targetSizeRatio === undefined ? undefined : typeof body.targetSizeRatio === "number" && body.targetSizeRatio >= 0 && body.targetSizeRatio <= 100 ? body.targetSizeRatio : bad("The target ratio is a number from 0 to 100");
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          return pve.call<string>("POST", `/nodes/${seg(node)}/ceph/pool`, { name, size, min_size: minSize, pg_num: pgNum, pg_autoscale_mode: body.autoscale as string | undefined, application: body.application as string | undefined, add_storages: body.addStorages === true ? true : undefined, target_size_ratio: ratio });
        });
        c.json(200, { task });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/cluster\/ceph\/pools\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const name = decodeURIComponent(m[1]);
        if (!POOL_NAME.test(name)) bad("That isn't a pool name");
        const body = await c.readJson();
        noExtra(body, ["node", "size", "minSize", "autoscale", "targetSizeRatio", "confirm"]);
        const set: Record<string, string | number> = {};
        if (body.size !== undefined) {
          set.size = intIn(body.size, 2, 7, "Copies per object");
          // Changing the number of copies copies (or drops) data across the whole pool.
          confirmed(body, name, `changing how many copies ${name} keeps`);
        }
        if (body.minSize !== undefined) set.min_size = intIn(body.minSize, 1, 7, "Minimum copies");
        if (body.autoscale !== undefined) set.pg_autoscale_mode = ["on", "off", "warn"].includes(String(body.autoscale)) ? String(body.autoscale) : bad("Autoscale is on, off or warn");
        if (body.targetSizeRatio !== undefined) set.target_size_ratio = typeof body.targetSizeRatio === "number" && body.targetSizeRatio >= 0 && body.targetSizeRatio <= 100 ? body.targetSizeRatio : bad("The target ratio is a number from 0 to 100");
        if (typeof set.size === "number" && typeof set.min_size === "number" && set.min_size > set.size) bad("The minimum number of copies can't be more than the number of copies");
        if (!Object.keys(set).length) bad("Nothing to change");
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          return pve.call<string | null>("PUT", `/nodes/${seg(node)}/ceph/pool/${seg(name)}`, set);
        });
        c.json(200, { task: task ?? null });
      },
    },
  ];
}

