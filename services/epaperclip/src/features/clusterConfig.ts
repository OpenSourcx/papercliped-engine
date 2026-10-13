import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import { asRecord, flag, intIn, isAddress, linkParams, links, major, seg } from "./clusterCommon.ts";
import { bad, guarded, noExtra, query, soft, type Route } from "./nodeCommon.ts";
import { nodeName } from "./nodeValidate.ts";

/**
 * The cluster itself: whether this device is in one, who is in it, create, join, join information and removing a
 * node. Creating or joining changes what this device is, so both need the device's or cluster's name typed, and the
 * root password of the peer travels in the request body only (never a URL, a log or a response).
 */

const FINGERPRINT = /^([A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/;
const CLUSTER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,13}[A-Za-z0-9])?$/;

interface Member {
  name: string;
  nodeid: number | null;
  ip: string | null;
  online: boolean;
  local: boolean;
  votes: number | null;
  links: { n: number; address: string }[];
  level: string | null;
}

async function overview(pve: ProxmoxClient, local: string, admin: boolean) {
  const [status, list, version, config, totem, qdevice, apiversion, guests] = await Promise.all([
    soft(pve.call<Record<string, any>[]>("GET", "/cluster/status")),
    pve.call<{ node: string; status: string }[]>("GET", "/nodes"),
    soft(pve.version()),
    soft(pve.call<Record<string, any>[]>("GET", "/cluster/config/nodes")),
    soft(pve.call<Record<string, unknown>>("GET", "/cluster/config/totem")),
    soft(pve.call<Record<string, unknown>>("GET", "/cluster/config/qdevice")),
    soft(pve.call<unknown>("GET", "/cluster/config/apiversion")),
    soft(pve.call<Record<string, any>[]>("GET", "/cluster/resources", { type: "vm" })),
  ]);
  const entries = status.data ?? [];
  const cluster = entries.find((s) => s.type === "cluster");
  const statusNodes = new Map(entries.filter((s) => s.type === "node").map((s) => [String(s.name), s]));
  const corosync = new Map((config.data ?? []).map((n) => [String(n.name ?? n.node), n]));
  const names = new Set<string>([...list.map((n) => n.node), ...statusNodes.keys(), ...corosync.keys()]);
  const count = (node: string) => {
    const mine = (guests.data ?? []).filter((g) => g.node === node && g.template !== 1);
    return { running: mine.filter((g) => g.status === "running").length, total: mine.length };
  };
  const members: (Member & { guests: { running: number; total: number } })[] = [...names].sort().map((name) => {
    const s = statusNodes.get(name);
    const c = corosync.get(name);
    const l = list.find((n) => n.node === name);
    const ringLinks = Object.entries(c ?? {}).flatMap(([k, v]) => (/^ring\d+_addr$/.test(k) && typeof v === "string" ? [{ n: Number(k.slice(4, -5)), address: v }] : []));
    return {
      name,
      nodeid: typeof (c?.nodeid ?? s?.nodeid) === "number" ? Number(c?.nodeid ?? s?.nodeid) : null,
      ip: (typeof s?.ip === "string" ? s.ip : typeof c?.pve_addr === "string" ? c.pve_addr : null) as string | null,
      online: s ? flag(s.online) : l?.status === "online",
      local: name === local || flag(s?.local),
      votes: typeof c?.quorum_votes === "number" ? c.quorum_votes : null,
      links: ringLinks,
      level: s?.level || null,
      guests: count(name),
    };
  });
  const clustered = !!cluster;
  const t = asRecord(totem.data);
  return {
    clustered,
    name: (cluster?.name as string | undefined) ?? null,
    quorate: cluster ? flag(cluster.quorate) : true,
    configVersion: typeof cluster?.version === "number" ? cluster.version : null,
    local,
    pveVersion: version.data?.version ?? null,
    pveMajor: major(version.data?.version),
    nodes: members,
    onlineCount: members.filter((m) => m.online).length,
    votes: members.reduce((a, m) => a + (m.votes ?? 1), 0),
    totem: clustered ? { clusterName: t.cluster_name ?? null, version: t.version ?? null, ip_version: t.ip_version ?? null, secauth: t.secauth ?? null, link_mode: t.link_mode ?? null, interface: t.interface ?? null } : null,
    qdevice: clustered ? summarizeQdevice(qdevice.data) : null,
    joinApiVersion: typeof apiversion.data === "number" ? apiversion.data : null,
    guestsHere: count(local),
    denied: { status: status.denied, config: config.denied },
    canChange: admin,
  };
}

function summarizeQdevice(raw: unknown): { configured: boolean; text: string | null } {
  const q = asRecord(raw);
  if (!Object.keys(q).length) return { configured: false, text: null };
  const text = typeof q.status === "string" ? q.status : typeof q.output === "string" ? q.output : JSON.stringify(q).slice(0, 600);
  return { configured: true, text };
}

/** The text a person copies from a cluster member and pastes into the node that is joining: the same encoding Proxmox's own UI uses. */
function encodeJoinInfo(info: { ipAddress: string; fingerprint: string; peerLinks: Record<string, string>; ringAddress: string[]; totem: Record<string, unknown> }): string {
  return Buffer.from(JSON.stringify(info), "utf8").toString("base64");
}

export function decodeJoinInfo(text: unknown): { ipAddress: string; fingerprint: string; peerLinks: Record<string, string> } {
  if (typeof text !== "string" || !text.trim() || text.length > 20_000) return bad("Paste the join information from a node in the cluster");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8"));
  } catch {
    return bad("That isn't join information. Copy it again from the Join information button on a node in the cluster.");
  }
  const o = asRecord(parsed);
  if (!isAddress(o.ipAddress)) return bad("The join information has no usable address for the cluster node");
  if (typeof o.fingerprint !== "string" || !FINGERPRINT.test(o.fingerprint)) return bad("The join information has no valid certificate fingerprint");
  const raw = asRecord(o.peerLinks);
  const peerLinks: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!/^link[0-7]$/.test(k) || !isAddress(v)) return bad("The join information lists a link address that isn't valid");
    peerLinks[k] = v;
  }
  return { ipAddress: o.ipAddress, fingerprint: o.fingerprint.toUpperCase(), peerLinks };
}

export function clusterConfigRoutes(): Route[] {
  return [
    {
      method: "GET",
      re: /^\/api\/cluster\/overview$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => overview(pve, c.node, await c.isNodeAdmin(pve)));
        c.json(200, out);
      },
    },
    {
      // What a joining node needs, in the format Proxmox's own screen produces, so either screen can read the other's.
      method: "GET",
      re: /^\/api\/cluster\/join-info$/,
      run: async (c) => {
        const wanted = query(c, "node");
        const out = await c.asUser(async (pve) => {
          const info = await pve.call<Record<string, any>>("GET", "/cluster/config/join", wanted ? { node: nodeName(wanted) } : undefined).catch((e: unknown) => {
            if (e instanceof ProxmoxError && e.status !== 401 && e.status !== 403) throw new HttpError(409, "not_clustered", "This device isn't in a cluster yet, so there is nothing to join.");
            throw e;
          });
          const nodes = (info.nodelist ?? []) as Record<string, any>[];
          const preferred = nodes.find((n) => n.name === info.preferred_node) ?? nodes[0];
          if (!preferred?.pve_addr || !preferred?.pve_fp) throw new HttpError(502, "bad_join_info", "Proxmox didn't return the address and fingerprint of this node");
          const peerLinks: Record<string, string> = {};
          for (const [k, v] of Object.entries(preferred)) if (/^ring\d+_addr$/.test(k) && typeof v === "string") peerLinks[`link${k.slice(4, -5)}`] = v;
          const ringAddress = nodes.flatMap((n) => Object.entries(n).filter(([k, v]) => /^ring\d+_addr$/.test(k) && typeof v === "string").map(([, v]) => v as string));
          const encoded = encodeJoinInfo({ ipAddress: preferred.pve_addr, fingerprint: preferred.pve_fp, peerLinks, ringAddress, totem: asRecord(info.totem) });
          return { info: encoded, ipAddress: preferred.pve_addr as string, fingerprint: preferred.pve_fp as string, node: preferred.name as string, peerLinks };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/cluster\/join-info\/parse$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(30_000);
        noExtra(body, ["text"]);
        c.json(200, decodeJoinInfo(body.text));
      },
    },
    {
      // Creating a cluster makes this device the first member. It can't be undone from the console.
      method: "POST",
      re: /^\/api\/cluster\/create$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(20_000);
        noExtra(body, ["name", "links", "nodeid", "votes", "confirm"]);
        const name = typeof body.name === "string" && CLUSTER_NAME.test(body.name) ? body.name : bad("A cluster name uses letters, numbers and - (up to 15 characters)");
        if (body.confirm !== name) throw new HttpError(400, "confirm", `Type “${name}” to confirm creating the cluster`);
        const list = links(body.links, { priority: true });
        const nodeid = body.nodeid === undefined || body.nodeid === null || body.nodeid === "" ? undefined : intIn(body.nodeid, 1, 4_294_967_295, "The node id");
        const votes = body.votes === undefined || body.votes === null || body.votes === "" ? undefined : intIn(body.votes, 1, 1000, "Votes");
        const out = await c.asUser(async (pve) => {
          const status = await pve.call<Record<string, any>[]>("GET", "/cluster/status").catch(() => []);
          if (status.some((s) => s.type === "cluster")) throw new HttpError(409, "already_clustered", "This device is already in a cluster");
          const task = await pve.call<string>("POST", "/cluster/config", { clustername: name, nodeid, votes, ...linkParams(list) });
          return { task, node: c.node };
        });
        c.json(200, out);
      },
    },
    {
      // Joining replaces this device's cluster state with the cluster's. The root password of the peer is write-only.
      method: "POST",
      re: /^\/api\/cluster\/join$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(20_000);
        noExtra(body, ["hostname", "fingerprint", "password", "links", "nodeid", "votes", "confirm", "force"]);
        const hostname = isAddress(body.hostname) ? body.hostname : bad("Enter the address of a node that is already in the cluster");
        const fingerprint = typeof body.fingerprint === "string" && FINGERPRINT.test(body.fingerprint) ? body.fingerprint.toUpperCase() : bad("The fingerprint is 32 pairs of hex digits separated by colons");
        const password = typeof body.password === "string" && body.password.length >= 1 && body.password.length <= 128 && !/[\u0000-\u001f]/.test(body.password) ? body.password : bad("Enter the root password of that node");
        if (body.confirm !== c.node) throw new HttpError(400, "confirm", `Type “${c.node}” to confirm joining this device to the cluster`);
        const list = links(body.links, { priority: false });
        const nodeid = body.nodeid === undefined || body.nodeid === null || body.nodeid === "" ? undefined : intIn(body.nodeid, 1, 4_294_967_295, "The node id");
        const votes = body.votes === undefined || body.votes === null || body.votes === "" ? undefined : intIn(body.votes, 0, 1000, "Votes");
        const out = await c.asUser(async (pve) => {
          const [status, vms] = await Promise.all([pve.call<Record<string, any>[]>("GET", "/cluster/status").catch(() => []), pve.call<Record<string, any>[]>("GET", "/cluster/resources", { type: "vm" }).catch(() => [])]);
          if (status.some((s) => s.type === "cluster")) throw new HttpError(409, "already_clustered", "This device is already in a cluster");
          const here = vms.filter((g) => g.node === c.node);
          if (here.length) throw new HttpError(409, "has_guests", `This device has ${here.length} ${here.length === 1 ? "machine" : "machines"}. Proxmox won't join a device that has machines; back them up, remove them, join, then restore them.`);
          const task = await guarded([password], () => pve.call<string>("POST", "/cluster/config/join", { hostname, fingerprint, password, force: body.force === true ? true : undefined, nodeid, votes, ...linkParams(list) }));
          return { task, node: c.node, signOutExpected: true };
        });
        c.json(200, out);
      },
    },

    // ---- Removing a node
    {
      method: "GET",
      re: /^\/api\/cluster\/nodes\/([^/]+)\/removal$/,
      run: async (c, m) => {
        const node = nodeName(decodeURIComponent(m[1]));
        const out = await c.asUser(async (pve) => {
          const [status, vms, ha, repl] = await Promise.all([
            pve.call<Record<string, any>[]>("GET", "/cluster/status"),
            soft(pve.call<Record<string, any>[]>("GET", "/cluster/resources", { type: "vm" })),
            soft(pve.call<Record<string, any>[]>("GET", "/cluster/ha/resources")),
            soft(pve.call<Record<string, any>[]>("GET", "/cluster/replication")),
          ]);
          const member = status.find((s) => s.type === "node" && s.name === node);
          if (!member) throw new HttpError(404, "unknown_node", `This cluster has no node called ${node}`);
          const guests = (vms.data ?? []).filter((g) => g.node === node);
          const haOn = new Set(guests.map((g) => `${g.type === "lxc" ? "ct" : "vm"}:${g.vmid}`));
          const replicating = (repl.data ?? []).filter((j) => j.target === node || j.source === node || guests.some((g) => g.vmid === j.guest));
          return {
            node,
            online: flag(member.online),
            local: node === c.node || flag(member.local),
            guests: guests.map((g) => ({ vmid: g.vmid, name: g.name ?? String(g.vmid), type: g.type })),
            haResources: (ha.data ?? []).filter((r) => haOn.has(String(r.sid))).map((r) => String(r.sid)),
            replicationJobs: replicating.map((j) => String(j.id)),
            steps: [
              `Move or back up what you want to keep from ${node}.`,
              `Power ${node} off, and never switch it on again with the same name and address while it is still in this cluster's records.`,
              "Remove it here. Proxmox takes it out of the cluster configuration and lowers the votes needed for quorum.",
              `${node}'s machine files stay under /etc/pve/nodes/${node} on the remaining nodes until you delete that folder yourself.`,
              `To reuse the hardware, reinstall Proxmox on it instead of switching it on.`,
            ],
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/cluster\/nodes\/([^/]+)\/remove$/,
      run: async (c, m) => {
        c.sameSite();
        const node = nodeName(decodeURIComponent(m[1]));
        const body = await c.readJson();
        noExtra(body, ["confirm"]);
        if (body.confirm !== node) throw new HttpError(400, "confirm", `Type “${node}” to confirm removing it from the cluster`);
        if (node === c.node) throw new HttpError(409, "local_node", `You are signed in to ${node}. Sign in to another node of the cluster to remove it.`);
        await c.asUser(async (pve) => {
          const status = await pve.call<Record<string, any>[]>("GET", "/cluster/status");
          const member = status.find((s) => s.type === "node" && s.name === node);
          if (!member) throw new HttpError(404, "unknown_node", `This cluster has no node called ${node}`);
          if (flag(member.online)) throw new HttpError(409, "node_online", `${node} is still online. Shut it down and keep it off before removing it.`);
          await pve.call("DELETE", `/cluster/config/nodes/${seg(node)}`);
        });
        c.json(200, { ok: true });
      },
    },

    // ---- Cluster log
    {
      method: "GET",
      re: /^\/api\/cluster\/log$/,
      run: async (c) => {
        const max = query(c, "max") ? intIn(query(c, "max"), 1, 500, "max") : 100;
        const list = await c.asUser((pve) => pve.call<Record<string, any>[]>("GET", "/cluster/log", { max }));
        c.json(200, { entries: list.map((e) => ({ time: e.time ?? null, node: e.node ?? null, user: e.user ?? null, tag: e.tag ?? null, pid: e.pid ?? null, priority: e.pri ?? null, message: String(e.msg ?? "") })) });
      },
    },
  ];
}
