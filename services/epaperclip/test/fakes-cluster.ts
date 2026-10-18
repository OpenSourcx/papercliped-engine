import type { Transport } from "@papercliped-engine/proxmox-client";
import { fakePve } from "./fakes.ts";

/**
 * A Proxmox with the cluster endpoints: a three-node cluster (pve and pve2 online, pve3 switched off) or a single
 * device, HA with groups (version 8) or rules (version 9), replication jobs, migration preconditions and tasks, Ceph,
 * the cluster log and backups per node. It wraps another fake (sign-in, tickets) and answers the cluster paths first.
 * sam@pve is an administrator; lee@pve may read a little and change nothing (403 on writes, as Proxmox answers).
 */

const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ status: 200, body: JSON.stringify({ data, ...extra }) });
const fail = (status: number, message: string) => ({ status, body: JSON.stringify({ message: `${message}\n` }) });
const deny = { status: 403, body: JSON.stringify({ message: "Permission check failed\n" }) };
const unimplemented = (m: string, p: string) => fail(501, `Method '${m} ${p}' not implemented`);

export const FINGERPRINT = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
export const ROOT_PASSWORD = "peer-root-pw-9X";

export interface ClusterFakeOptions {
  /** A device that isn't in a cluster. */
  single?: boolean;
  /** "9.0.3" has HA rules; "8.4.1" has HA groups only. */
  pveVersion?: string;
  /** Whether Ceph is set up. */
  ceph?: boolean;
  /** A standalone host whose HA calls fail with "no cluster" (500), as a real one does. */
  haNoCluster?: boolean;
}

interface FakeGuest { vmid: number; node: string; type: "qemu" | "lxc"; name: string; status: string; template?: number; lock?: string }

export function fakeCluster(opts: ClusterFakeOptions = {}, inner: Transport = fakePve().transport) {
  const single = opts.single === true;
  const version = opts.pveVersion ?? "9.0.3";
  const rules = Number(version.split(".")[0]) >= 9;
  const calls: { method: string; path: string; body: string; user: string }[] = [];
  const st = {
    clustered: !single,
    name: "lab",
    version: 4,
    nodes: single
      ? [{ node: "pve", online: true, ip: "10.0.0.2", nodeid: 1, votes: 1 }]
      : [
          { node: "pve", online: true, ip: "10.0.0.2", nodeid: 1, votes: 1 },
          { node: "pve2", online: true, ip: "10.0.0.3", nodeid: 2, votes: 1 },
          { node: "pve3", online: false, ip: "10.0.0.4", nodeid: 3, votes: 1 },
        ],
    guests: [
      { vmid: 101, node: "pve", type: "lxc", name: "web", status: "running" },
      { vmid: 102, node: "pve", type: "qemu", name: "db", status: "stopped" },
      { vmid: 103, node: "pve2", type: "qemu", name: "app", status: "running" },
      { vmid: 104, node: "pve2", type: "lxc", name: "cache", status: "stopped" },
      { vmid: 9000, node: "pve", type: "qemu", name: "tpl", status: "stopped", template: 1 },
    ] as FakeGuest[],
    options: { keyboard: "en-us", fencing: "watchdog", migration: "type=secure" } as Record<string, unknown>,
    ha: {
      digest: "h1",
      resources: new Map<string, Record<string, unknown>>(single ? [] : [["vm:103", { sid: "vm:103", state: "started", group: rules ? undefined : "prefer-pve2", max_restart: 1, max_relocate: 1, comment: "app server" }]]),
      groups: new Map<string, Record<string, unknown>>(rules ? [] : [["prefer-pve2", { group: "prefer-pve2", nodes: "pve2:2,pve:1", restricted: 0, nofailback: 0, digest: "g1" }]]),
      rules: new Map<string, Record<string, unknown>>(rules ? [["keep-app-home", { rule: "keep-app-home", type: "node-affinity", resources: "vm:103", nodes: "pve2:2,pve:1", strict: 0, affinity: "positive", digest: "r1" }]] : []),
      armed: "armed",
    },
    replication: new Map<string, Record<string, unknown>>(single ? [] : [["101-0", { id: "101-0", type: "local", guest: 101, jobnum: 0, target: "pve2", schedule: "*/15", comment: "web copy", source: "pve", digest: "p1" }]]),
    replStatus: new Map<string, Record<string, unknown>>(single ? [] : [["101-0", { id: "101-0", guest: 101, jobnum: 0, source: "pve", target: "pve2", schedule: "*/15", last_sync: 1_760_000_000, last_try: 1_760_000_000, next_sync: 1_760_000_900, duration: 4.2, fail_count: 0 }]]),
    replLog: ["start replication job", "end replication job"] as string[],
    ceph: opts.ceph === true && !single,
    cephFlags: new Map<string, boolean>([["noout", false], ["pause", false], ["noscrub", false]]),
    cephOsdIn: new Map<number, boolean>([[0, true], [1, true], [2, true]]),
    cephPools: [{ pool: 1, pool_name: "vm-pool", size: 3, min_size: 2, pg_num: 128, pg_autoscale_mode: "on", crush_rule_name: "replicated_rule", application_metadata: { rbd: {} }, bytes_used: 3e9, percent_used: 0.05, type: "replicated" }] as Record<string, unknown>[],
    mutes: [] as string[],
    log: [{ time: 1_760_000_000, node: "pve", user: "root@pam", tag: "pvedaemon", pid: 100, pri: 6, msg: "starting cluster" }] as Record<string, unknown>[],
    tasks: [] as { upid: string; node: string; type: string; user: string; start: number; end?: number; status?: string; log: string[] }[],
    joinedWith: null as null | Record<string, string>,
    removed: [] as string[],
  };
  let n = 0;
  const task = (node: string, type: string, user: string, over: Partial<(typeof st.tasks)[number]> = {}) => {
    const upid = `UPID:${node}:0000${++n}:00000001:${(0x65000000 + n).toString(16)}:${type}::${user}:`;
    st.tasks.push({ upid, node, type, user, start: 1_700_000_000 + n, log: [`${type} started`], ...over });
    return upid;
  };
  const guest = (id: number) => st.guests.find((g) => g.vmid === id);
  const nodeOnline = (name: string) => st.nodes.find((x) => x.node === name)?.online === true;
  const stale = (current: unknown, given: string | null) => given !== null && given !== current;
  const bump = () => (st.ha.digest = `h${Number(st.ha.digest.slice(1)) + 1}`);

  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const path = u.pathname.replace("/api2/json", "");
    const ticket = decodeURIComponent((req.headers.Cookie ?? "").replace("PVEAuthCookie=", ""));
    const user = ticket.split(":")[1] ?? "";
    const known = path !== "/access/ticket" && ticket && (await inner({ ...req, method: "GET", url: `${u.origin}/api2/json/version`, body: undefined })).status === 200;
    if (!known) return inner(req);
    const admin = user === "sam@pve";
    const f = new URLSearchParams(req.body ?? "");
    const q = u.searchParams;
    const m = req.method;
    calls.push({ method: m, path: decodeURIComponent(path), body: req.body ?? "", user });
    if (m !== "GET" && !admin) return deny;

    if (path === "/version") return ok({ version, release: version.split(".").slice(0, 2).join(".") });
    if (path === "/nodes" && m === "GET") return ok(st.nodes.map((x) => (x.online ? { node: x.node, status: "online", cpu: 0.1, maxcpu: 4, mem: 2e9, maxmem: 8e9, uptime: 5000 } : { node: x.node, status: "offline" })));
    if (path === "/cluster/status") {
      if (!admin) return deny;
      return ok([
        ...(st.clustered ? [{ type: "cluster", name: st.name, nodes: st.nodes.length, quorate: st.nodes.filter((x) => x.online).length * 2 > st.nodes.length ? 1 : 0, version: st.version, id: "cluster" }] : []),
        ...st.nodes.map((x) => ({ type: "node", name: x.node, online: x.online ? 1 : 0, local: x.node === "pve" ? 1 : 0, ip: x.ip, nodeid: x.nodeid, id: `node/${x.node}` })),
      ]);
    }
    if (path === "/cluster/resources" && q.get("type") === "vm") return ok(st.guests.map((g) => ({ ...g, id: `${g.type}/${g.vmid}` })));
    if (path === "/cluster/resources" && q.get("type") === "node") return ok(st.nodes.filter((x) => x.online).map((x) => ({ type: "node", node: x.node, status: "online", cpu: 0.2, maxcpu: 4, mem: 3e9, maxmem: 8e9, uptime: 9000 })));
    if (path === "/cluster/options") return m === "GET" ? ok(st.options) : ok(null);
    if (path === "/cluster/log") return ok(st.log.slice(0, Number(q.get("max") ?? 50)));

    // ---- Cluster configuration
    if (path === "/cluster/config" && m === "POST") {
      if (st.clustered) return fail(500, "this node is already in a cluster");
      (st as any).created = req.body;
      st.clustered = true;
      st.name = f.get("clustername")!;
      return ok(task("pve", "clustercreate", user));
    }
    if (path === "/cluster/config/nodes" && m === "GET") return st.clustered ? ok(st.nodes.map((x) => ({ name: x.node, node: x.node, nodeid: x.nodeid, quorum_votes: x.votes, ring0_addr: x.ip, pve_addr: x.ip }))) : fail(500, "no such cluster: corosync.conf: No such file or directory");
    const rm = path.match(/^\/cluster\/config\/nodes\/([\w-]+)$/);
    if (rm && m === "DELETE") {
      if (!st.nodes.some((x) => x.node === rm[1])) return fail(500, `no such node '${rm[1]}'`);
      st.removed.push(rm[1]);
      st.nodes = st.nodes.filter((x) => x.node !== rm[1]);
      return ok(null);
    }
    if (path === "/cluster/config/totem") return st.clustered ? ok({ cluster_name: st.name, version: "2", ip_version: "ipv4-6", secauth: "on", link_mode: "passive", interface: { "0": { linknumber: "0" } } }) : fail(500, "no cluster");
    if (path === "/cluster/config/qdevice") return ok({});
    if (path === "/cluster/config/apiversion") return ok(1);
    if (path === "/cluster/config/join" && m === "GET") {
      if (!st.clustered) return fail(500, "no such cluster: corosync.conf: No such file or directory");
      return ok({ config_digest: "cd1", preferred_node: "pve", totem: { cluster_name: st.name, version: "2" }, nodelist: st.nodes.map((x) => ({ name: x.node, nodeid: x.nodeid, quorum_votes: x.votes, ring0_addr: x.ip, pve_addr: x.ip, pve_fp: FINGERPRINT })) });
    }
    if (path === "/cluster/config/join" && m === "POST") {
      if (f.get("password") !== ROOT_PASSWORD) return fail(500, `authentication failure for ${f.get("hostname")} with password ${f.get("password")}`);
      if (f.get("fingerprint") !== FINGERPRINT) return fail(500, "fingerprint mismatch");
      st.joinedWith = Object.fromEntries(f.entries());
      return ok(task("pve", "clusterjoin", user));
    }

    // ---- High availability
    if (opts.haNoCluster && path.startsWith("/cluster/ha/")) return fail(500, "no such cluster: corosync.conf: No such file or directory");
    if (path === "/cluster/ha/resources" && m === "GET") return ok([...st.ha.resources.values()].map((r) => ({ ...r, digest: st.ha.digest })));
    if (path === "/cluster/ha/resources" && m === "POST") {
      const sid = f.get("sid")!;
      if (st.ha.resources.has(sid)) return fail(500, `resource ID '${sid}' already defined`);
      st.ha.resources.set(sid, Object.fromEntries([...f.entries()]));
      (st as any).haPost = req.body;
      bump();
      return ok(null);
    }
    const hr = decodeURIComponent(path).match(/^\/cluster\/ha\/resources\/((?:vm|ct):\d+)(?:\/(migrate|relocate))?$/);
    if (hr) {
      const r = st.ha.resources.get(hr[1]);
      if (!r) return fail(500, `no such resource '${hr[1]}'`);
      if (hr[2]) return ((st as any).haMove = { sid: hr[1], how: hr[2], node: f.get("node") }), ok(null);
      if (m === "DELETE") return st.ha.resources.delete(hr[1]), bump(), ok(null);
      if (m === "PUT") {
        if (stale(st.ha.digest, f.get("digest"))) return fail(500, "detected modified configuration - file changed by other user! Try again.");
        (st as any).haPut = req.body;
        for (const [k, v] of f.entries()) if (k !== "delete" && k !== "digest") r[k] = v;
        for (const k of (f.get("delete") ?? "").split(",").filter(Boolean)) delete r[k];
        bump();
        return ok(null);
      }
      return ok({ ...r, digest: st.ha.digest });
    }
    if (path === "/cluster/ha/groups") {
      if (m === "GET") return ok([...st.ha.groups.values()]);
      st.ha.groups.set(f.get("group")!, Object.fromEntries(f.entries()));
      return ok(null);
    }
    const hg = path.match(/^\/cluster\/ha\/groups\/([\w-]+)$/);
    if (hg) {
      if (m === "DELETE") return st.ha.groups.delete(hg[1]), ok(null);
      if (m === "PUT") {
        (st as any).groupPut = req.body;
        return ok(null);
      }
      return ok(st.ha.groups.get(hg[1]) ?? null);
    }
    if (path === "/cluster/ha/rules") {
      if (!rules) return unimplemented(m, path);
      if (m === "GET") return ok([...st.ha.rules.values()].map((r) => ({ rule: r.rule })));
      st.ha.rules.set(f.get("rule")!, Object.fromEntries(f.entries()));
      return ok(null);
    }
    const hl = path.match(/^\/cluster\/ha\/rules\/([\w-]+)$/);
    if (hl) {
      if (!rules) return unimplemented(m, path);
      if (m === "DELETE") return st.ha.rules.delete(hl[1]), ok(null);
      if (m === "PUT") {
        if (stale("r1", f.get("digest"))) return fail(500, "detected modified configuration");
        (st as any).rulePut = req.body;
        return ok(null);
      }
      return ok(st.ha.rules.get(hl[1]) ?? null);
    }
    if (path === "/cluster/ha/status/current") {
      return ok([
        { id: "quorum", type: "quorum", node: "pve", status: "OK", quorate: 1 },
        { id: "master", type: "master", node: "pve", status: "pve (active, Tue Oct 13 03:00:00 2026)", timestamp: 1_760_000_000 },
        ...st.nodes.map((x) => ({ id: `lrm:${x.node}`, type: "lrm", node: x.node, status: x.online ? `${x.node} (idle, Tue Oct 13 03:00:00 2026)` : `${x.node} (old timestamp - dead?)`, timestamp: 1_760_000_000 })),
        ...[...st.ha.resources.keys()].map((sid) => ({ id: `service:${sid}`, type: "service", sid, node: "pve2", state: "started", crm_state: "started", request_state: "started", status: `${sid} (pve2, started)` })),
        ...(rules ? [{ id: "fencing", type: "fencing", node: "pve", status: "armed", "armed-state": st.ha.armed }] : []),
      ]);
    }
    if (path === "/cluster/ha/status/manager_status") return ok({ manager_status: { master_node: "pve" } });
    if (path === "/cluster/ha/status/disarm-ha") return rules ? ((st.ha.armed = "disarmed"), (st as any).disarm = req.body, ok(null)) : unimplemented(m, path);
    if (path === "/cluster/ha/status/arm-ha") return rules ? ((st.ha.armed = "armed"), ok(null)) : unimplemented(m, path);

    // ---- Replication
    if (path === "/cluster/replication" && m === "GET") return ok([...st.replication.values()]);
    if (path === "/cluster/replication" && m === "POST") {
      const id = f.get("id")!;
      if (st.replication.has(id)) return fail(500, "job already exists");
      (st as any).replPost = req.body;
      st.replication.set(id, { ...Object.fromEntries(f.entries()), guest: Number(id.split("-")[0]), jobnum: Number(id.split("-")[1]), source: guest(Number(id.split("-")[0]))?.node, digest: "p1" });
      return ok(null);
    }
    const rj = path.match(/^\/cluster\/replication\/([\d-]+)$/);
    if (rj) {
      const j = st.replication.get(rj[1]);
      if (!j) return fail(500, "no such job");
      if (m === "DELETE") return ((st as any).replDelete = { id: rj[1], body: req.body }), st.replication.delete(rj[1]), ok(null);
      if (m === "PUT") {
        if (stale("p1", f.get("digest"))) return fail(500, "detected modified configuration");
        (st as any).replPut = req.body;
        Object.assign(j, Object.fromEntries([...f.entries()].filter(([k]) => k !== "delete" && k !== "digest")));
        return ok(null);
      }
      return ok(j);
    }
    const rn = path.match(/^\/nodes\/([\w-]+)\/replication$/);
    if (rn) return nodeOnline(rn[1]) ? ok([...st.replStatus.values()].filter((s) => s.source === rn[1] && (!q.get("guest") || String(s.guest) === q.get("guest")))) : fail(500, "node offline");
    const rs = path.match(/^\/nodes\/([\w-]+)\/replication\/([\d-]+)\/(status|log|schedule_now)$/);
    if (rs) {
      if (rs[3] === "schedule_now") return ((st as any).replNow = { node: rs[1], id: rs[2] }), ok(null);
      if (rs[3] === "log") return ok(st.replLog.slice(Number(q.get("start") ?? 0)).map((t, i) => ({ n: i + 1, t })), { total: st.replLog.length });
      return ok(st.replStatus.get(rs[2]) ?? null);
    }

    // ---- Migration
    const mg = path.match(/^\/nodes\/([\w-]+)\/(qemu|lxc)\/(\d+)\/migrate$/);
    if (mg) {
      const g = guest(Number(mg[3]));
      if (!g || g.node !== mg[1]) return fail(500, "no such guest");
      if (m === "GET") {
        const target = q.get("target");
        const notAllowed: Record<string, unknown> = {};
        if (g.vmid === 102) notAllowed.pve3 = { unavailable_storages: ["local-lvm"] };
        if (g.vmid === 103) notAllowed.pve3 = { "blocking-ha-resources": [{ sid: "vm:104", cause: "resource-affinity" }] };
        const allowed = st.nodes.filter((x) => x.node !== g.node && x.online && !(x.node in notAllowed)).map((x) => x.node);
        void target;
        const lxc = g.type === "lxc";
        return ok({ [lxc ? "allowed-nodes" : "allowed_nodes"]: allowed, [lxc ? "not-allowed-nodes" : "not_allowed_nodes"]: notAllowed, running: g.status === "running", ...(lxc ? {} : { local_disks: g.vmid === 102 ? [{ volid: "local-lvm:vm-102-disk-0", size: 34359738368, is_unused: false, cdrom: false }] : [], local_resources: g.vmid === 103 ? [] : [], "has-dbus-vmstate": true }) });
      }
      if (g.lock) return fail(500, `VM is locked (${g.lock})`);
      (st as any).migratePost = { path, body: req.body };
      return ok(task(g.node, `${g.type === "lxc" ? "vz" : "qm"}migrate`, user, { log: [`starting migration of ${g.type === "lxc" ? "CT" : "VM"} ${g.vmid} to node '${f.get("target")}'`, "migration finished successfully"], end: 1_700_000_100, status: "OK" }));
    }
    const sg = path.match(/^\/nodes\/([\w-]+)\/storage$/);
    if (sg) return ok([{ storage: "local-lvm", type: "lvmthin", shared: 0, avail: 5e11, total: 1e12 }, { storage: "ceph", type: "rbd", shared: 1, avail: 9e11, total: 1e12 }]);
    const vz = path.match(/^\/nodes\/([\w-]+)\/vzdump$/);
    if (vz && m === "POST") {
      ((st as any).vzdump ??= []).push({ node: vz[1], body: req.body });
      return ok(task(vz[1], "vzdump", user));
    }

    // ---- Ceph
    const cp = path.match(/^\/nodes\/([\w-]+)\/ceph(?:\/(.*))?$/);
    if (cp || path.startsWith("/cluster/ceph")) {
      if (!st.ceph) return fail(500, "binary not installed: /usr/bin/ceph-mon");
      const rest = cp ? cp[2] ?? "" : "";
      if (rest === "status") return ok({ fsid: "f00d", health: { status: [...st.cephFlags.values()].some(Boolean) ? "HEALTH_WARN" : "HEALTH_OK", checks: [...st.cephFlags].filter(([, v]) => v).length ? { OSDMAP_FLAGS: { severity: "HEALTH_WARN", summary: { message: "flag(s) set" }, muted: st.mutes.includes("OSDMAP_FLAGS") } } : {} }, monmap: { num_mons: 2 }, quorum_names: ["pve", "pve2"], osdmap: { num_osds: 3, num_up_osds: 3, num_in_osds: [...st.cephOsdIn.values()].filter(Boolean).length }, pgmap: { num_pgs: 128, pgs_by_state: [{ state_name: "active+clean", count: 128 }], bytes_used: 3e9, bytes_avail: 6e11, bytes_total: 6.03e11, read_bytes_sec: 1000, write_bytes_sec: 2000, read_op_per_sec: 3, write_op_per_sec: 4 } });
      if (rest === "mon") return ok([{ name: "pve", host: "pve", addr: "10.0.0.2:6789", rank: 0, quorum: 1, state: "leader", ceph_version_short: "19.2.1" }, { name: "pve2", host: "pve2", addr: "10.0.0.3:6789", rank: 1, quorum: 1, state: "peon", ceph_version_short: "19.2.1" }]);
      if (rest === "mgr") return ok([{ name: "pve", host: "pve", addr: "10.0.0.2", state: "active" }]);
      if (rest === "mds") return ok([]);
      if (rest === "fs") return ok([]);
      if (rest === "osd" && m === "GET") return ok({ flags: [...st.cephFlags].filter(([, v]) => v).map(([k]) => k).join(","), root: { id: -1, name: "default", type: "root", children: [{ id: -2, name: "pve", type: "host", children: [{ id: 0, name: "osd.0", type: "osd", status: "up", in: st.cephOsdIn.get(0) ? 1 : 0, host: "pve", device_class: "ssd", bytes_used: 1e9, total_space: 2e11, percent_used: 0.5, pgs: 40, commit_latency_ms: 1, apply_latency_ms: 1, version: "19.2.1" }, { id: 1, name: "osd.1", type: "osd", status: "up", in: st.cephOsdIn.get(1) ? 1 : 0, host: "pve", device_class: "ssd", bytes_used: 1e9, total_space: 2e11, pgs: 44 }] }, { id: -3, name: "pve2", type: "host", children: [{ id: 2, name: "osd.2", type: "osd", status: "up", in: st.cephOsdIn.get(2) ? 1 : 0, host: "pve2", device_class: "ssd", bytes_used: 1e9, total_space: 2e11, pgs: 44 }] }] } });
      const oa = rest.match(/^osd\/(\d+)\/(in|out|scrub)$/);
      if (oa && m === "POST") {
        ((st as any).osdActions ??= []).push({ node: cp![1], id: Number(oa[1]), action: oa[2], body: req.body });
        if (oa[2] !== "scrub") st.cephOsdIn.set(Number(oa[1]), oa[2] === "in");
        return ok(null);
      }
      if (rest === "pool" && m === "GET") return ok(st.cephPools);
      if (rest === "pool" && m === "POST") {
        ((st as any).poolPost ??= []).push(req.body);
        st.cephPools.push({ pool: 2, pool_name: f.get("name"), size: Number(f.get("size") ?? 3), min_size: Number(f.get("min_size") ?? 2), pg_num: 128 });
        return ok(task(cp![1], "cephcreatepool", user));
      }
      const pp = rest.match(/^pool\/([\w.-]+)$/);
      if (pp && m === "PUT") return ((st as any).poolPut = { name: pp[1], body: req.body }), ok(null);
      if (rest === "cfg/raw") return ok("[global]\n\tfsid = f00d\n\tkey = SECRETKEYSECRET\n\tmon_host = 10.0.0.2");
      if (rest === "rules") return ok([{ name: "replicated_rule", rule_id: 0 }]);
      if (rest === "log") return ok([{ n: 1, t: "cluster [INF] overall HEALTH_OK" }]);
      if (path === "/cluster/ceph/flags" && m === "GET") return ok([...st.cephFlags].map(([name, value]) => ({ name, description: `${name} flag`, value: value ? 1 : 0 })));
      const cf = path.match(/^\/cluster\/ceph\/flags\/([\w-]+)$/);
      if (cf && m === "PUT") return st.cephFlags.set(cf[1], f.get("value") === "1"), ok(null);
      if (path === "/cluster/ceph/health-mute" && m === "GET") return ok(st.mutes.map((code) => ({ code })));
      const hm = path.match(/^\/cluster\/ceph\/health-mute\/([A-Z0-9_]+)$/);
      if (hm && m === "PUT") {
        ((st as any).muteCalls ??= []).push({ code: hm[1], body: req.body });
        if (f.get("value") === "1") st.mutes.push(hm[1]);
        else st.mutes = st.mutes.filter((x) => x !== hm[1]);
        return ok(null);
      }
    }

    // ---- Tasks
    const td = path.match(/^\/nodes\/([\w-]+)\/tasks\/([^/]+)(?:\/(status|log))?$/);
    if (td) {
      const t = st.tasks.find((x) => x.upid === decodeURIComponent(td[2]));
      if (!t) return fail(500, "no such task");
      if (td[3] === "log") return ok(t.log.slice(Number(q.get("start") ?? 0)).map((l, i) => ({ n: i + 1, t: l })), { total: t.log.length });
      return ok({ status: t.end === undefined ? "running" : "stopped", exitstatus: t.status });
    }
    return inner(req);
  };

  return { transport, calls, st, task };
}
