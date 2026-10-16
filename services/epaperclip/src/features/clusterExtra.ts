import { HttpError } from "../http.ts";
import { asRecord, flag, intIn, isAddress, seg, vmidOf } from "./clusterCommon.ts";
import { bad, confirmed, guarded, noExtra, query, soft, type Route } from "./nodeCommon.ts";

/**
 * The rest of the cluster work:
 *
 *  - the quorum device and corosync links, which Proxmox only changes with `pvecm` and by editing a file, so they get
 *    a guided, copyable command set built from validated input instead of a button that cannot work;
 *  - moving a machine to ANOTHER cluster (remote migration), with the other cluster's API token written once and never
 *    returned, logged, or left in an error message;
 *  - cluster-wide resource views.
 */

type Json = Record<string, any>;

// ---- Guides (no API: validated input in, commands out)

const IP = /^[0-9a-fA-F:.]{2,45}$/;
const addr = (v: unknown, what: string): string => (typeof v === "string" && isAddress(v) && IP.test(v) ? v : bad(`${what} needs an IP address`));
const linkNo = (v: unknown): number => intIn(v ?? 0, 0, 7, "The link number");

interface Step { title: string; where: string; command: string | null; note: string | null }

export function qdeviceGuide(action: string, address: string | null): { steps: Step[]; cautions: string[] } {
  if (action === "remove") {
    return {
      steps: [{ title: "Remove the quorum device", where: "any cluster node, as root", command: "pvecm qdevice remove", note: "Takes effect at once on every node. The external server can then be shut down." }],
      cautions: ["With an even number of nodes, the cluster loses its tie-breaker. Two nodes then stop when one is lost."],
    };
  }
  if (!address) return bad("Enter the address of the machine that will act as the quorum device");
  return {
    steps: [
      { title: "Install the vote server", where: `the external machine ${address} (Debian based, not a cluster node, not a guest of this cluster)`, command: "apt install corosync-qnetd", note: null },
      { title: "Install the vote client", where: "every cluster node, as root", command: "apt install corosync-qdevice", note: "Proxmox needs it on all nodes before it will set the device up." },
      { title: "Let the cluster reach it with ssh", where: "the external machine", command: null, note: "Setup copies keys with ssh as root, so root login by password must be allowed on that machine while it runs. You can turn it off again afterwards." },
      { title: "Set it up", where: "any one cluster node, as root", command: `pvecm qdevice setup ${address}`, note: "Run it on one node only. It asks for the external machine's root password once." },
      { title: "Check", where: "any cluster node", command: "pvecm status", note: "Look for the Qdevice line under the quorum information, and one extra vote." },
    ],
    cautions: [
      "All nodes must be online while it is set up.",
      "A cluster with an odd number of nodes gains nothing from a quorum device; Proxmox only recommends one for an even number.",
      "The external machine must be reachable on port 5403 from every node.",
    ],
  };
}

export function corosyncGuide(action: string, p: { address: string | null; link: number; node: string | null }): { steps: Step[]; cautions: string[] } {
  const cautions = [
    "Corosync decides who is in the cluster. A mistake can split it, so change it one step at a time with every node online.",
    "Keep the old link until the new one is working, then remove it.",
  ];
  if (action === "expected-votes") {
    return {
      steps: [{ title: "Let this node work alone", where: "the node that lost quorum, as root", command: "pvecm expected 1", note: "Only for getting a stranded node working again, never as a way of life. Machines on other nodes may then be started twice." }],
      cautions: ["Use it only when the other nodes are really off. Two nodes that both think they are the cluster can corrupt shared disks."],
    };
  }
  if (action !== "add-link" && action !== "change-link") return bad("Choose add-link, change-link or expected-votes");
  if (!p.address) return bad("Enter the new link address");
  const n = p.node ?? "<node name>";
  return {
    steps: [
      { title: "Copy the file", where: "any node, as root", command: "cp /etc/pve/corosync.conf /etc/pve/corosync.conf.new", note: "Always edit a copy; the cluster picks up the real file the moment it is saved." },
      { title: action === "add-link" ? "Add the address to each node" : "Change the address of the node", where: "the copy, /etc/pve/corosync.conf.new", command: `ring${p.link}_addr: ${p.address}`, note: `In the nodelist section, in the block for ${n}. Every node needs a ring${p.link}_addr line.` },
      { title: "Raise the version", where: "the copy", command: "config_version: <old number + 1>", note: "In the totem section. Without a higher number, nodes ignore the change." },
      { title: "Keep a backup of the old file", where: "any node", command: "cp /etc/pve/corosync.conf /root/corosync.conf.bak", note: null },
      { title: "Put it in place", where: "any node, as root", command: "mv /etc/pve/corosync.conf.new /etc/pve/corosync.conf", note: "Corosync reloads on every node by itself." },
      { title: "Check", where: "any node", command: "corosync-cfgtool -s && pvecm status", note: "Every link should show connected to every node." },
    ],
    cautions,
  };
}

// ---- Remote migration

const FINGERPRINT = /^([A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/;
const TOKEN_ID = /^[^\s!@=,:]{1,64}@[A-Za-z0-9][A-Za-z0-9._-]{0,31}![A-Za-z][A-Za-z0-9._-]{1,63}$/;
const TOKEN_SECRET = /^[A-Za-z0-9-]{8,128}$/;
const BRIDGE = /^[A-Za-z][A-Za-z0-9_]{0,9}$/;

/** bridge-pair-list: one bridge for all, or <source>:<target>{,<source>:<target>}*. */
export function bridgePairs(v: unknown): string {
  if (typeof v !== "string" || !v || v.length > 512) return bad("Pick the bridge on the other cluster");
  for (const p of v.split(",")) {
    const ids = p.split(":");
    if (ids.length > 2 || ids.some((b) => !BRIDGE.test(b))) return bad("Bridge mappings are written source:target, separated by commas");
  }
  return v;
}
const STORAGE_PAIRS = /^[A-Za-z][A-Za-z0-9._-]{0,254}(:[A-Za-z][A-Za-z0-9._-]{0,254})?(,[A-Za-z][A-Za-z0-9._-]{0,254}(:[A-Za-z][A-Za-z0-9._-]{0,254})?)*$/;
const storageMap = (v: unknown): string => (typeof v === "string" && v.length <= 1024 && STORAGE_PAIRS.test(v) ? v : bad("Storage mappings are written source:target, separated by commas"));

async function locate(pve: import("@papercliped-engine/proxmox-client").ProxmoxClient, vmid: number) {
  const all = await pve.call<Json[]>("GET", "/cluster/resources", { type: "vm" });
  const g = all.find((r) => r.vmid === vmid && (r.type === "qemu" || r.type === "lxc"));
  if (!g) throw new HttpError(404, "not_found", `There is no machine ${vmid} in this cluster`);
  return { node: String(g.node), type: g.type as "qemu" | "lxc", name: String(g.name ?? vmid), status: String(g.status ?? "unknown"), template: g.template === 1 };
}

/** The bridges and storages a machine uses, from its configuration lines, for filling in the mapping. */
export function usedBridgesAndStorages(cfg: Json): { bridges: string[]; storages: string[] } {
  const bridges = new Set<string>();
  const storages = new Set<string>();
  for (const [k, raw] of Object.entries(cfg)) {
    if (typeof raw !== "string") continue;
    if (/^net\d+$/.test(k)) {
      const b = raw.match(/(?:^|,)bridge=([^,]+)/)?.[1];
      if (b) bridges.add(b);
    } else if (/^(scsi|virtio|sata|ide|efidisk|tpmstate|unused|mp)\d*$/.test(k) || k === "rootfs") {
      const s = raw.match(/^([A-Za-z][A-Za-z0-9._-]*):(?!iso\/)/)?.[1];
      if (s && !/(^|,)media=cdrom/.test(raw)) storages.add(s);
    }
  }
  return { bridges: [...bridges].sort(), storages: [...storages].sort() };
}

// ---- Cluster-wide resources

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function summarizeResources(rows: Json[]) {
  const nodes = rows.filter((r) => r.type === "node");
  const guests = rows.filter((r) => r.type === "qemu" || r.type === "lxc");
  const sum = (list: Json[], k: string) => list.reduce((a, r) => a + (num(r[k]) ?? 0), 0);
  // A shared storage appears once per node but is one pool of space.
  const seen = new Set<string>();
  const stores = rows.filter((r) => r.type === "storage").filter((s) => {
    const key = flag(s.shared) ? String(s.storage) : `${s.node}/${s.storage}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const online = nodes.filter((n) => n.status === "online");
  return {
    nodes: { total: nodes.length, online: online.length },
    cpu: { cores: sum(online, "maxcpu"), usedCores: online.reduce((a, n) => a + (num(n.cpu) ?? 0) * (num(n.maxcpu) ?? 0), 0) },
    memory: { used: sum(online, "mem"), total: sum(online, "maxmem") },
    storage: { used: sum(stores, "disk"), total: sum(stores, "maxdisk") },
    guests: {
      vms: { running: guests.filter((g) => g.type === "qemu" && g.status === "running" && g.template !== 1).length, total: guests.filter((g) => g.type === "qemu" && g.template !== 1).length },
      containers: { running: guests.filter((g) => g.type === "lxc" && g.status === "running" && g.template !== 1).length, total: guests.filter((g) => g.type === "lxc" && g.template !== 1).length },
      templates: guests.filter((g) => g.template === 1).length,
    },
  };
}

export function clusterExtraRoutes(): Route[] {
  return [
    // ---- Quorum device and corosync: read, plus guided commands
    {
      method: "GET",
      re: /^\/api\/cluster\/qdevice$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const [cfg, q, nodes] = await Promise.all([
            soft(pve.call<Json[]>("GET", "/cluster/config/nodes")),
            soft(pve.call<unknown>("GET", "/cluster/config/qdevice")),
            pve.call<Json[]>("GET", "/nodes"),
          ]);
          const raw = q.data;
          const text = typeof raw === "string" ? raw.slice(0, 20_000) : raw && typeof raw === "object" ? JSON.stringify(raw, null, 2).slice(0, 20_000) : null;
          const rec = asRecord(raw);
          const members = cfg.data ?? [];
          return {
            clustered: members.length > 0 || nodes.length > 1,
            // Proxmox answers with an empty object, or an error saying no device is configured, when there is none.
            configured: Object.keys(rec).length > 0 || (typeof raw === "string" && raw.trim().length > 0 && !/not configured|no qdevice/i.test(raw)),
            text,
            denied: q.denied,
            nodes: nodes.length,
            evenNodes: nodes.length % 2 === 0,
            recommendation: nodes.length < 2 ? "A single device has nothing to break a tie with." : nodes.length % 2 === 0 ? "An even number of nodes can split evenly. A quorum device adds the tie-breaking vote." : "An odd number of nodes already has a majority. A quorum device adds little.",
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/cluster\/qdevice\/guide$/,
      run: async (c) => {
        const action = query(c, "action") ?? "setup";
        if (action !== "setup" && action !== "remove") bad("Choose setup or remove");
        const address = action === "setup" ? addr(query(c, "address"), "The quorum device") : null;
        c.json(200, qdeviceGuide(action, address));
      },
    },
    {
      method: "GET",
      re: /^\/api\/cluster\/corosync\/guide$/,
      run: async (c) => {
        const action = query(c, "action") ?? "add-link";
        const address = query(c, "address");
        const node = query(c, "node");
        if (node !== null && !/^[A-Za-z0-9]([A-Za-z0-9-]{0,62})$/.test(node)) bad("That isn't a node name");
        c.json(200, corosyncGuide(action, { address: action === "expected-votes" ? null : address === null ? null : addr(address, "The link"), link: linkNo(query(c, "link")), node }));
      },
    },

    // ---- Remote migration (to another cluster)
    {
      method: "GET",
      re: /^\/api\/cluster\/remote-migrate\/(\d+)$/,
      run: async (c, m) => {
        const vmid = vmidOf(m[1]);
        const out = await c.asUser(async (pve) => {
          const g = await locate(pve, vmid);
          const cfg = asRecord(await pve.call<unknown>("GET", `/nodes/${seg(g.node)}/${g.type}/${vmid}/config`));
          const ha = await soft(pve.call<Json[]>("GET", "/cluster/ha/resources"));
          const used = usedBridgesAndStorages(cfg);
          const sid = `${g.type === "lxc" ? "ct" : "vm"}:${vmid}`;
          const blockers: string[] = [];
          if (g.template) blockers.push("Templates can't be moved to another cluster.");
          if ((ha.data ?? []).some((r) => r.sid === sid)) blockers.push("This machine is managed by high availability. Remove it from HA first; the other cluster has its own.");
          if (typeof cfg.lock === "string") blockers.push(`It is locked (${cfg.lock}).`);
          return { vmid, name: g.name, type: g.type, node: g.node, running: g.status === "running", ...used, blockers, experimental: true };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/cluster\/remote-migrate\/(\d+)$/,
      run: async (c, m) => {
        c.sameSite();
        const vmid = vmidOf(m[1]);
        const body = await c.readJson();
        noExtra(body, ["host", "port", "fingerprint", "tokenId", "tokenSecret", "targetStorage", "targetBridge", "targetVmid", "online", "restart", "delete", "bwlimit", "timeout", "confirm", "confirmDelete"]);
        const host = typeof body.host === "string" && isAddress(body.host) ? body.host : bad("The other cluster needs an address (a name or an IP address)");
        const port = body.port === undefined || body.port === "" ? undefined : intIn(body.port, 1, 65535, "The port");
        // Without the fingerprint, anyone on the path could stand in for the other cluster and receive the machine.
        const fingerprint = typeof body.fingerprint === "string" && FINGERPRINT.test(body.fingerprint.trim()) ? body.fingerprint.trim().toUpperCase() : bad("Enter the other cluster's certificate fingerprint (32 pairs of hex digits separated by colons)");
        const tokenId = typeof body.tokenId === "string" && TOKEN_ID.test(body.tokenId) ? body.tokenId : bad("The API token is written user@realm!tokenname");
        const secret = typeof body.tokenSecret === "string" && TOKEN_SECRET.test(body.tokenSecret) ? body.tokenSecret : bad("Enter the API token's secret");
        const targetStorage = storageMap(body.targetStorage);
        const targetBridge = bridgePairs(body.targetBridge);
        const targetVmid = body.targetVmid === undefined || body.targetVmid === "" ? undefined : vmidOf(body.targetVmid);
        const bwlimit = body.bwlimit === undefined || body.bwlimit === "" ? undefined : intIn(body.bwlimit, 0, 100_000_000, "The bandwidth limit");
        const timeout = body.timeout === undefined || body.timeout === "" ? undefined : intIn(body.timeout, 1, 86_400, "The shutdown timeout");
        confirmed(body, String(vmid), `moving machine ${vmid} to another cluster`);
        // Deleting the original after the copy leaves no way back if something is wrong on the other side.
        if (body.delete === true) confirmed({ confirm: body.confirmDelete }, "delete", "deleting the original after the move");
        const endpoint = `apitoken=PVEAPIToken=${tokenId}=${secret},host=${host}${port ? `,port=${port}` : ""},fingerprint=${fingerprint}`;
        const task = await c.asUser(async (pve) => {
          const g = await locate(pve, vmid);
          if (g.template) throw new HttpError(409, "template", "Templates can't be moved to another cluster");
          const ha = await soft(pve.call<Json[]>("GET", "/cluster/ha/resources"));
          if ((ha.data ?? []).some((r) => r.sid === `${g.type === "lxc" ? "ct" : "vm"}:${vmid}`)) throw new HttpError(409, "ha", "This machine is managed by high availability. Remove it from HA first.");
          const params: Record<string, string | number | boolean | undefined> = {
            "target-endpoint": endpoint,
            "target-storage": targetStorage,
            "target-bridge": targetBridge,
            "target-vmid": targetVmid,
            bwlimit,
            delete: body.delete === true ? true : undefined,
            online: body.online === true ? true : undefined,
          };
          if (g.type === "lxc") {
            params.restart = body.restart === true ? true : undefined;
            params.timeout = timeout;
          }
          // Proxmox repeats parts of the request in its errors; the token secret is stripped from anything said back.
          return guarded([secret, endpoint], () => pve.call<string>("POST", `/nodes/${seg(g.node)}/${g.type}/${vmid}/remote_migrate`, params));
        });
        c.json(200, { task });
      },
    },

    // ---- Cluster-wide resources
    {
      method: "GET",
      re: /^\/api\/cluster\/resources$/,
      run: async (c) => {
        const type = query(c, "type");
        if (type !== null && !["vm", "storage", "node", "sdn"].includes(type)) bad("The type is vm, storage, node or sdn");
        const out = await c.asUser(async (pve) => {
          const [rows, pools] = await Promise.all([pve.call<Json[]>("GET", "/cluster/resources", type ? { type } : undefined), soft(pve.call<Json[]>("GET", "/pools"))]);
          const pick = (r: Json) => ({
            id: String(r.id ?? ""),
            type: String(r.type ?? ""),
            node: typeof r.node === "string" ? r.node : null,
            name: typeof r.name === "string" ? r.name : null,
            vmid: num(r.vmid),
            status: typeof r.status === "string" ? r.status : null,
            storage: typeof r.storage === "string" ? r.storage : null,
            shared: flag(r.shared),
            pool: typeof r.pool === "string" ? r.pool : null,
            template: r.template === 1,
            cpu: num(r.cpu),
            maxcpu: num(r.maxcpu),
            mem: num(r.mem),
            maxmem: num(r.maxmem),
            disk: num(r.disk),
            maxdisk: num(r.maxdisk),
            uptime: num(r.uptime),
            hastate: typeof r.hastate === "string" ? r.hastate : null,
            tags: typeof r.tags === "string" && r.tags ? r.tags.split(/[;,]/).filter(Boolean) : [],
            content: typeof r.content === "string" ? r.content.split(",") : [],
            plugintype: typeof r.plugintype === "string" ? r.plugintype : null,
            lock: typeof r.lock === "string" ? r.lock : null,
          });
          return { summary: summarizeResources(rows), resources: rows.map(pick), pools: (pools.data ?? []).map((p) => String(p.poolid)), generated: c.now() };
        });
        c.json(200, out);
      },
    },
  ];
}
