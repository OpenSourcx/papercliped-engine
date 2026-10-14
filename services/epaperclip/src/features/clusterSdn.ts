import { isIP } from "node:net";
import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import { asRecord, knownNodes, notImplemented, requireNode, seg } from "./clusterCommon.ts";
import { bad, confirmed, noExtra, soft, type Route } from "./nodeCommon.ts";

/**
 * Software-defined networking, the routed parts: BGP / EVPN / IS-IS controllers, EVPN zones, fabrics (OpenFabric,
 * OSPF, BGP), prefix lists and route maps. Each kind is a table of the fields Proxmox's API viewer lists for it; a
 * request is checked against the table before Proxmox sees it, edits carry the digest, and removing something that
 * another object points at is refused with the name of what points at it. Applying the pending changes is the same
 * call as for the simpler zones (`POST /api/sdn/apply`). On a Proxmox without fabrics, those answers say so calmly.
 */

type Json = Record<string, any>;
type T = "int" | "num" | "bool" | "str" | "enum" | "node" | "nodes" | "ips" | "cidr" | "mac" | "iface" | "ifaces" | "ref";
interface F {
  t: T;
  min?: number;
  max?: number;
  values?: readonly string[];
  /** The kind of object a "ref" points at, checked against what exists. */
  of?: "fabric" | "routemap" | "prefixlist" | "controller";
}

const ID = /^[A-Za-z][A-Za-z0-9_-]{1,19}$/;
const FABRIC_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,7}$/;
const MAP_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const ZONE_ID = /^[a-z][a-z0-9]{0,7}$/;
const IFACE = /^[A-Za-z][A-Za-z0-9_.:-]{0,14}$/;
const MAC = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;
const DIGEST = /^[0-9a-f]{40}$/;

const REF = (of: NonNullable<F["of"]>): F => ({ t: "ref", of });

const CONTROLLER_FIELDS: Record<string, Record<string, F>> = {
  evpn: { asn: { t: "int", min: 0, max: 4294967295 }, peers: { t: "ips" }, fabric: REF("fabric"), "peer-group-name": { t: "str" }, ebgp: { t: "bool" }, "ebgp-multihop": { t: "int", min: 1, max: 255 }, "bgp-multipath-as-path-relax": { t: "bool" }, "route-map-in": REF("routemap"), "route-map-out": REF("routemap"), "bgp-mode": { t: "enum", values: ["auto", "external", "internal"] } },
  bgp: { node: { t: "node" }, asn: { t: "int", min: 0, max: 4294967295 }, peers: { t: "ips" }, ebgp: { t: "bool" }, "ebgp-multihop": { t: "int", min: 1, max: 255 }, loopback: { t: "iface" }, "bgp-multipath-as-path-relax": { t: "bool" }, "route-map-in": REF("routemap"), "route-map-out": REF("routemap"), "bgp-mode": { t: "enum", values: ["auto", "external", "internal"] } },
  isis: { node: { t: "node" }, "isis-domain": { t: "str" }, "isis-ifaces": { t: "ifaces" }, "isis-net": { t: "str" }, loopback: { t: "iface" }, fabric: REF("fabric") },
};
const CONTROLLER_REQUIRED: Record<string, string[]> = { evpn: ["asn"], bgp: ["asn", "node"], isis: ["node", "isis-domain", "isis-ifaces", "isis-net"] };

const EVPN_ZONE_FIELDS: Record<string, F> = {
  controller: REF("controller"),
  "vrf-vxlan": { t: "int", min: 1, max: 16777215 },
  exitnodes: { t: "nodes" },
  "exitnodes-primary": { t: "node" },
  "exitnodes-local-routing": { t: "bool" },
  "advertise-subnets": { t: "bool" },
  "disable-arp-nd-suppression": { t: "bool" },
  mac: { t: "mac" },
  "rt-import": { t: "str" },
  nodes: { t: "nodes" },
  mtu: { t: "int", min: 100, max: 65535 },
  ipam: { t: "str" },
  dns: { t: "str" },
  dnszone: { t: "str" },
  reversedns: { t: "str" },
  dhcp: { t: "enum", values: ["dnsmasq"] },
};

const PROTOCOLS = ["openfabric", "ospf", "bgp"] as const;
const FABRIC_FIELDS: Record<string, Record<string, F>> = {
  openfabric: { ip_prefix: { t: "cidr" }, ip6_prefix: { t: "cidr" }, hello_interval: { t: "num", min: 1, max: 600 }, csnp_interval: { t: "num", min: 1, max: 600 } },
  ospf: { area: { t: "str" }, ip_prefix: { t: "cidr" }, route_filter: REF("prefixlist") },
  bgp: { ip_prefix: { t: "cidr" }, route_filter: REF("prefixlist") },
};
const REDISTRIBUTE: Record<string, readonly string[]> = { ospf: ["bgp", "connected", "kernel", "static"], bgp: ["connected", "kernel", "ospf", "static"], openfabric: [] };

const ROUTE_MATCH_KEYS = ["route-type", "vni", "ip-address-prefix-list", "ip6-address-prefix-list", "ip-next-hop-prefix-list", "ip6-next-hop-prefix-list", "ip-next-hop-address", "ip6-next-hop-address", "metric", "local-preference", "peer", "tag"] as const;
const ROUTE_SET_KEYS = ["ip-next-hop-peer-address", "ip-next-hop", "ip-next-hop-unchanged", "ip6-next-hop-peer-address", "ip6-next-hop-prefer-global", "ip6-next-hop", "local-preference", "tag", "weight", "metric", "src"] as const;

const isCidr = (v: string): boolean => {
  const [a, len, ...rest] = v.split("/");
  return rest.length === 0 && isIP(a) !== 0 && /^\d{1,3}$/.test(len ?? "") && Number(len) <= (isIP(a) === 6 ? 128 : 32);
};

interface Known {
  nodes: { node: string }[];
  fabrics: Set<string>;
  routeMaps: Set<string>;
  prefixLists: Set<string>;
  controllers: Set<string>;
}

function value(v: unknown, f: F, key: string, known: Known): string | number | boolean {
  switch (f.t) {
    case "int":
    case "num": {
      const n = typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n) || (f.t === "int" && !Number.isInteger(n)) || n < (f.min ?? -Infinity) || n > (f.max ?? Infinity)) return bad(`${key} must be a ${f.t === "int" ? "whole " : ""}number${f.min !== undefined ? ` from ${f.min} to ${f.max}` : ""}`);
      return n;
    }
    case "bool":
      return typeof v === "boolean" ? v : bad(`${key} is on or off`);
    case "enum":
      return typeof v === "string" && f.values!.includes(v) ? v : bad(`${key} is one of ${f.values!.join(", ")}`);
    case "node":
      return requireNode(v, known.nodes);
    case "nodes": {
      const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
      if (!list || !list.length || list.length > 64) return bad(`${key}: pick at least one node`);
      const out = list.map((x) => requireNode(typeof x === "string" ? x.trim() : x, known.nodes));
      return [...new Set(out)].join(",");
    }
    case "ips": {
      const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
      if (!list || !list.length || list.length > 64 || list.some((x) => typeof x !== "string" || isIP(x.trim()) === 0)) return bad(`${key}: enter IP addresses, separated by commas`);
      return list.map((x) => (x as string).trim()).join(",");
    }
    case "cidr":
      return typeof v === "string" && isCidr(v) ? v : bad(`${key}: enter an address and prefix, like 10.10.0.0/24`);
    case "mac":
      return typeof v === "string" && MAC.test(v) ? v : bad(`${key}: enter a MAC address like BC:24:11:00:00:01`);
    case "iface":
      return typeof v === "string" && IFACE.test(v) ? v : bad(`${key}: enter an interface name`);
    case "ifaces": {
      const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
      if (!list || !list.length || list.length > 32 || list.some((x) => typeof x !== "string" || !IFACE.test(x.trim()))) return bad(`${key}: enter interface names, separated by commas`);
      return list.map((x) => (x as string).trim()).join(",");
    }
    case "ref": {
      const set = { fabric: known.fabrics, routemap: known.routeMaps, prefixlist: known.prefixLists, controller: known.controllers }[f.of!];
      return typeof v === "string" && set.has(v) ? v : bad(`${key}: that ${f.of === "routemap" ? "route map" : f.of === "prefixlist" ? "prefix list" : f.of} doesn't exist`);
    }
    default:
      return typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v) ? v : bad(`${key} is a short piece of text`);
  }
}

/** Checks a body against a field table: unknown keys are refused, an emptied key becomes a `delete`. */
function check(body: Json, table: Record<string, F>, known: Known, extraAllowed: string[] = []): { set: Record<string, string | number | boolean>; unset: string[] } {
  const set: Record<string, string | number | boolean> = {};
  const unset: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (extraAllowed.includes(k)) continue;
    const f = table[k];
    if (!f) bad(`Unknown field “${k}”`);
    if (v === null || v === "") unset.push(k);
    else set[k] = value(v, f, k, known);
  }
  return { set, unset };
}

async function loadKnown(pve: ProxmoxClient): Promise<Known> {
  const [nodes, fabrics, maps, lists, ctrls] = await Promise.all([
    knownNodes(pve),
    soft(pve.call<Json[]>("GET", "/cluster/sdn/fabrics/fabric")),
    soft(pve.call<Json[]>("GET", "/cluster/sdn/route-maps")),
    soft(pve.call<Json[]>("GET", "/cluster/sdn/prefix-lists", { verbose: 1 })),
    soft(pve.call<Json[]>("GET", "/cluster/sdn/controllers")),
  ]);
  const ids = (l: { data: Json[] | null }, ...keys: string[]) => new Set((l.data ?? []).map((x) => String(keys.map((k) => x[k]).find((v) => v !== undefined) ?? "")).filter(Boolean));
  return { nodes, fabrics: ids(fabrics, "id", "fabric"), routeMaps: ids(maps, "route-map-id", "id"), prefixLists: ids(lists, "id"), controllers: ids(ctrls, "controller") };
}

const pub = (r: Json): Json => ({ ...r });

const digestOf = (body: Json): string => (typeof body.digest === "string" && DIGEST.test(body.digest) ? body.digest : bad("Reload the page: this change needs the version you last saw (digest)"));

/** What points at an object, in words. */
async function usedBy(pve: ProxmoxClient, kind: "controller" | "fabric" | "routemap" | "prefixlist", id: string): Promise<string[]> {
  const [zones, ctrls, fabrics] = await Promise.all([
    soft(pve.call<Json[]>("GET", "/cluster/sdn/zones")),
    soft(pve.call<Json[]>("GET", "/cluster/sdn/controllers")),
    soft(pve.call<Json[]>("GET", "/cluster/sdn/fabrics/all")),
  ]);
  const out: string[] = [];
  const fabricRows = (asRecord(fabrics.data).fabrics as Json[] | undefined) ?? (Array.isArray(fabrics.data) ? (fabrics.data as Json[]).filter((x) => x.protocol !== undefined && x.node_id === undefined) : []);
  if (kind === "controller") for (const z of zones.data ?? []) if (z.controller === id) out.push(`zone ${z.zone}`);
  if (kind === "fabric") {
    for (const c of ctrls.data ?? []) if (c.fabric === id) out.push(`controller ${c.controller}`);
    for (const z of zones.data ?? []) if (z.fabric === id) out.push(`zone ${z.zone}`);
  }
  if (kind === "routemap") {
    for (const c of ctrls.data ?? []) if (c["route-map-in"] === id || c["route-map-out"] === id) out.push(`controller ${c.controller}`);
    for (const f of fabricRows) if ((Array.isArray(f.redistribute) ? f.redistribute : []).some((r: unknown) => String(r).includes(`route-map=${id}`) || asRecord(r)["route-map"] === id)) out.push(`fabric ${f.id}`);
  }
  if (kind === "prefixlist") for (const f of fabricRows) if (f.route_filter === id) out.push(`fabric ${f.id}`);
  return out;
}

const redistributeList = (v: unknown, protocol: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 8) return bad("Redistribute is a list of sources");
  const allowed = REDISTRIBUTE[protocol] ?? [];
  const seen = new Set<string>();
  return v.map((raw) => {
    const r = asRecord(raw);
    for (const k of Object.keys(r)) if (k !== "source" && k !== "route-map") bad(`Unknown field “${k}” in a redistribute entry`);
    if (typeof r.source !== "string" || !allowed.includes(r.source)) return bad(`A ${protocol} fabric can take routes from ${allowed.join(", ") || "nothing"}`);
    if (seen.has(r.source)) bad("Each source can be listed once");
    seen.add(r.source);
    if (r["route-map"] !== undefined && (typeof r["route-map"] !== "string" || !MAP_ID.test(r["route-map"]))) bad("That isn't a route map name");
    return `source=${r.source}${r["route-map"] ? `,route-map=${r["route-map"]}` : ""}`;
  });
};

function interfaceList(v: unknown, protocol: string): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 32) return bad("Pick at least one interface for the node");
  return v.map((raw) => {
    const i = asRecord(raw);
    const allowed = protocol === "openfabric" ? ["name", "ip", "ip6", "hello_multiplier"] : protocol === "ospf" ? ["name", "ip", "network_type"] : ["name"];
    for (const k of Object.keys(i)) if (!allowed.includes(k)) bad(`Unknown field “${k}” in an interface`);
    if (typeof i.name !== "string" || !IFACE.test(i.name)) return bad("An interface needs a name");
    const parts = [`name=${i.name}`];
    if (i.ip !== undefined && i.ip !== "") parts.push(`ip=${typeof i.ip === "string" && isCidr(i.ip) && isIP(i.ip.split("/")[0]) === 4 ? i.ip : bad("The interface address is an IPv4 address and prefix, like 10.10.0.1/32")}`);
    if (i.ip6 !== undefined && i.ip6 !== "") parts.push(`ip6=${typeof i.ip6 === "string" && isCidr(i.ip6) && isIP(i.ip6.split("/")[0]) === 6 ? i.ip6 : bad("The interface address is an IPv6 address and prefix")}`);
    if (i.hello_multiplier !== undefined && i.hello_multiplier !== "") parts.push(`hello_multiplier=${Number.isInteger(i.hello_multiplier) && (i.hello_multiplier as number) >= 2 && (i.hello_multiplier as number) <= 100 ? i.hello_multiplier : bad("Hello multiplier goes from 2 to 100")}`);
    if (i.network_type !== undefined && i.network_type !== "") parts.push(`network_type=${["broadcast", "non-broadcast", "point-to-multipoint", "point-to-point"].includes(String(i.network_type)) ? i.network_type : bad("Unknown network type")}`);
    return parts.join(",");
  });
}

export function clusterSdnRoutes(): Route[] {
  return [
    {
      method: "GET",
      re: /^\/api\/cluster\/sdn$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const probeList = async (path: string, params?: Record<string, string | number | boolean>) => {
            try {
              return { data: await pve.call<any>("GET", path, params), supported: true, denied: false };
            } catch (e) {
              if (e instanceof ProxmoxError && e.status === 403) return { data: null, supported: true, denied: true };
              if (notImplemented(e)) return { data: null, supported: false, denied: false };
              throw e;
            }
          };
          const [controllers, zones, fabrics, lists, maps] = await Promise.all([
            probeList("/cluster/sdn/controllers", { pending: 1 }),
            probeList("/cluster/sdn/zones", { pending: 1, type: "evpn" }),
            probeList("/cluster/sdn/fabrics/all", { pending: 1 }),
            probeList("/cluster/sdn/prefix-lists", { verbose: 1, pending: 1 }),
            probeList("/cluster/sdn/route-maps/entries", { pending: 1 }),
          ]);
          const f = fabrics.data;
          const fabricRows: Json[] = Array.isArray(f) ? f : (asRecord(f).fabrics as Json[]) ?? [];
          const fabricNodes: Json[] = Array.isArray(f) ? [] : (asRecord(f).nodes as Json[]) ?? [];
          const rowsOf = (x: Json[] | null) => (x ?? []).map(pub);
          return {
            controllers: rowsOf(controllers.data),
            evpnZones: rowsOf(zones.data),
            fabrics: fabricRows.filter((x) => x.node_id === undefined).map(pub),
            fabricNodes: [...fabricNodes, ...fabricRows.filter((x) => x.node_id !== undefined)].map(pub),
            prefixLists: rowsOf(lists.data),
            routeMaps: rowsOf(maps.data),
            supported: { controllers: controllers.supported, fabrics: fabrics.supported, prefixLists: lists.supported, routeMaps: maps.supported },
            denied: controllers.denied && zones.denied,
            controllerTypes: Object.keys(CONTROLLER_FIELDS),
            protocols: PROTOCOLS,
            matchKeys: ROUTE_MATCH_KEYS,
            setKeys: ROUTE_SET_KEYS,
            redistributeSources: REDISTRIBUTE,
          };
        });
        c.json(200, out);
      },
    },

    // ---- Controllers
    {
      method: "POST",
      re: /^\/api\/cluster\/sdn\/controllers$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        const type = typeof body.type === "string" && body.type in CONTROLLER_FIELDS ? body.type : bad("A controller is bgp, evpn or isis");
        const id = typeof body.controller === "string" && ID.test(body.controller) ? body.controller : bad("A controller name starts with a letter and uses letters, numbers, - and _ (2 to 20 characters)");
        const rest = { ...body };
        delete rest.type;
        delete rest.controller;
        await c.asUser(async (pve) => {
          const known = await loadKnown(pve);
          const { set, unset } = check(rest, CONTROLLER_FIELDS[type], known);
          void unset;
          for (const r of CONTROLLER_REQUIRED[type]) if (set[r] === undefined) bad(`A ${type} controller needs ${r}`);
          if (type === "evpn" && set.peers === undefined && set.fabric === undefined) bad("An EVPN controller needs the addresses of its peers (the nodes) or a fabric to use");
          await pve.call("POST", "/cluster/sdn/controllers", { controller: id, type, ...set });
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/cluster\/sdn\/controllers\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const id = typeof m[1] === "string" && ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a controller name");
        const body = await c.readJson();
        const digest = digestOf(body);
        const rest = { ...body };
        delete rest.digest;
        await c.asUser(async (pve) => {
          const known = await loadKnown(pve);
          const cur = asRecord(await pve.call<unknown>("GET", `/cluster/sdn/controllers/${seg(id)}`, { pending: 1 }));
          const type = String(cur.type ?? "");
          if (!CONTROLLER_FIELDS[type]) throw new HttpError(409, "unsupported", `Controllers of type ${type} can't be edited here`);
          const { set, unset } = check(rest, CONTROLLER_FIELDS[type], known);
          if (!Object.keys(set).length && !unset.length) bad("Nothing to change");
          for (const r of CONTROLLER_REQUIRED[type]) if (unset.includes(r)) bad(`A ${type} controller needs ${r}`);
          await pve.call("PUT", `/cluster/sdn/controllers/${seg(id)}`, { ...set, delete: unset.length ? unset.join(",") : undefined, digest });
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/cluster\/sdn\/controllers\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const id = typeof m[1] === "string" && ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a controller name");
        const body = await c.readJson();
        noExtra(body, ["confirm"]);
        confirmed(body, id, `removing the controller ${id}`);
        await c.asUser(async (pve) => {
          const by = await usedBy(pve, "controller", id);
          if (by.length) throw new HttpError(409, "in_use", `${id} is still used by ${by.join(", ")}. Change those first.`);
          await pve.call("DELETE", `/cluster/sdn/controllers/${seg(id)}`);
        });
        c.json(200, { ok: true });
      },
    },

    // ---- EVPN zones
    {
      method: "POST",
      re: /^\/api\/cluster\/sdn\/evpn-zones$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        const id = typeof body.zone === "string" && ZONE_ID.test(body.zone) ? body.zone : bad("A zone name is up to 8 lowercase letters and numbers, starting with a letter");
        const rest = { ...body };
        delete rest.zone;
        await c.asUser(async (pve) => {
          const known = await loadKnown(pve);
          const { set } = check(rest, EVPN_ZONE_FIELDS, known);
          if (set.controller === undefined) bad("An EVPN zone needs a controller");
          if (set["vrf-vxlan"] === undefined) bad("An EVPN zone needs a VRF VXLAN number (VNI)");
          if (set["exitnodes-primary"] !== undefined && !String(set.exitnodes ?? "").split(",").includes(String(set["exitnodes-primary"]))) bad("The primary exit node has to be one of the exit nodes");
          await pve.call("POST", "/cluster/sdn/zones", { zone: id, type: "evpn", ...set });
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/cluster\/sdn\/evpn-zones\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const id = ZONE_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a zone name");
        const body = await c.readJson();
        const digest = digestOf(body);
        const rest = { ...body };
        delete rest.digest;
        await c.asUser(async (pve) => {
          const known = await loadKnown(pve);
          const cur = asRecord(await pve.call<unknown>("GET", `/cluster/sdn/zones/${seg(id)}`, { pending: 1 }));
          if (cur.type !== "evpn") throw new HttpError(409, "not_evpn", `${id} isn't an EVPN zone`);
          const { set, unset } = check(rest, EVPN_ZONE_FIELDS, known);
          if (!Object.keys(set).length && !unset.length) bad("Nothing to change");
          if (unset.includes("controller") || unset.includes("vrf-vxlan")) bad("An EVPN zone keeps its controller and VRF number");
          await pve.call("PUT", `/cluster/sdn/zones/${seg(id)}`, { ...set, delete: unset.length ? unset.join(",") : undefined, digest });
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/cluster\/sdn\/evpn-zones\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const id = ZONE_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a zone name");
        const body = await c.readJson();
        noExtra(body, ["confirm"]);
        confirmed(body, id, `removing the zone ${id}`);
        await c.asUser(async (pve) => {
          const vnets = (await soft(pve.call<Json[]>("GET", "/cluster/sdn/vnets"))).data ?? [];
          const using = vnets.filter((v) => v.zone === id).map((v) => String(v.vnet));
          if (using.length) throw new HttpError(409, "in_use", `${id} still has VNets: ${using.join(", ")}. Remove them first.`);
          await pve.call("DELETE", `/cluster/sdn/zones/${seg(id)}`);
        });
        c.json(200, { ok: true });
      },
    },

    // ---- Fabrics
    {
      method: "POST",
      re: /^\/api\/cluster\/sdn\/fabrics$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        const protocol = typeof body.protocol === "string" && (PROTOCOLS as readonly string[]).includes(body.protocol) ? body.protocol : bad("A fabric is openfabric, ospf or bgp");
        const id = typeof body.id === "string" && FABRIC_ID.test(body.id) ? body.id : bad("A fabric name is up to 8 letters, numbers, - and _");
        const rest = { ...body };
        for (const k of ["protocol", "id", "redistribute"]) delete rest[k];
        await c.asUser(async (pve) => {
          const known = await loadKnown(pve);
          const { set } = check(rest, FABRIC_FIELDS[protocol], known);
          if (protocol === "ospf" && set.area === undefined) bad("An OSPF fabric needs an area, like 0");
          if (protocol === "ospf" && !/^(\d{1,10}|(\d{1,3}\.){3}\d{1,3})$/.test(String(set.area))) bad("The OSPF area is a number or an IPv4 address");
          if (set.ip_prefix === undefined && set.ip6_prefix === undefined) bad("A fabric needs an address range for its nodes (IPv4 or IPv6 prefix)");
          const redistribute = redistributeList(body.redistribute, protocol);
          await pve.call("POST", "/cluster/sdn/fabrics/fabric", { id, protocol, ...set, redistribute: redistribute.length ? redistribute : undefined });
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/cluster\/sdn\/fabrics\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const id = FABRIC_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a fabric name");
        const body = await c.readJson();
        const digest = digestOf(body);
        const rest = { ...body };
        for (const k of ["digest", "redistribute"]) delete rest[k];
        await c.asUser(async (pve) => {
          const known = await loadKnown(pve);
          const cur = asRecord(await pve.call<unknown>("GET", `/cluster/sdn/fabrics/fabric/${seg(id)}`, { pending: 1 }));
          const protocol = String(cur.protocol ?? "");
          if (!FABRIC_FIELDS[protocol]) throw new HttpError(409, "unsupported", `Fabrics of type ${protocol} can't be edited here`);
          const { set, unset } = check(rest, FABRIC_FIELDS[protocol], known);
          const redistribute = body.redistribute === undefined ? undefined : redistributeList(body.redistribute, protocol);
          if (!Object.keys(set).length && !unset.length && redistribute === undefined) bad("Nothing to change");
          const del = [...unset, ...(redistribute && !redistribute.length ? ["redistribute"] : [])];
          await pve.call("PUT", `/cluster/sdn/fabrics/fabric/${seg(id)}`, { protocol, ...set, redistribute: redistribute?.length ? redistribute : undefined, delete: del.length ? del : undefined, digest });
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/cluster\/sdn\/fabrics\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const id = FABRIC_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a fabric name");
        const body = await c.readJson();
        noExtra(body, ["confirm"]);
        confirmed(body, id, `removing the fabric ${id} and all its nodes`);
        await c.asUser(async (pve) => {
          const by = await usedBy(pve, "fabric", id);
          if (by.length) throw new HttpError(409, "in_use", `${id} is still used by ${by.join(", ")}. Change those first.`);
          await pve.call("DELETE", `/cluster/sdn/fabrics/fabric/${seg(id)}`);
        });
        c.json(200, { ok: true });
      },
    },
    {
      // Adds a node to a fabric, or changes its address and interfaces.
      method: "POST",
      re: /^\/api\/cluster\/sdn\/fabrics\/([^/]+)\/nodes\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const fabric = FABRIC_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a fabric name");
        const body = await c.readJson();
        noExtra(body, ["ip", "ip6", "interfaces", "digest", "replace"]);
        await c.asUser(async (pve) => {
          const nodes = await knownNodes(pve);
          const node = requireNode(decodeURIComponent(m[2]), nodes);
          const cur = asRecord(await pve.call<unknown>("GET", `/cluster/sdn/fabrics/fabric/${seg(fabric)}`, { pending: 1 }));
          const protocol = String(cur.protocol ?? "");
          if (!FABRIC_FIELDS[protocol]) throw new HttpError(409, "unsupported", `Fabrics of type ${protocol} can't be edited here`);
          if (body.ip !== undefined && body.ip !== "" && (typeof body.ip !== "string" || isIP(body.ip) !== 4)) bad("The node address is an IPv4 address, like 10.10.0.1");
          if (body.ip6 !== undefined && body.ip6 !== "" && (typeof body.ip6 !== "string" || isIP(body.ip6) !== 6)) bad("The node address is an IPv6 address");
          if (!body.ip && !body.ip6) bad("A node needs its address in the fabric");
          const interfaces = interfaceList(body.interfaces, protocol);
          const params = { protocol, ip: body.ip || undefined, ip6: body.ip6 || undefined, interfaces, digest: typeof body.digest === "string" && DIGEST.test(body.digest) ? body.digest : undefined };
          if (body.replace === true) await pve.call("PUT", `/cluster/sdn/fabrics/node/${seg(fabric)}/${seg(node)}`, params);
          else await pve.call("POST", `/cluster/sdn/fabrics/node/${seg(fabric)}`, { ...params, node_id: node });
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/cluster\/sdn\/fabrics\/([^/]+)\/nodes\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const fabric = FABRIC_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a fabric name");
        const body = await c.readJson();
        noExtra(body, ["confirm"]);
        await c.asUser(async (pve) => {
          const node = requireNode(decodeURIComponent(m[2]), await knownNodes(pve));
          confirmed(body, node, `taking ${node} out of the fabric ${fabric}`);
          await pve.call("DELETE", `/cluster/sdn/fabrics/node/${seg(fabric)}/${seg(node)}`);
        });
        c.json(200, { ok: true });
      },
    },

    // ---- Prefix lists
    {
      method: "POST",
      re: /^\/api\/cluster\/sdn\/prefix-lists$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["id", "entries"]);
        const id = typeof body.id === "string" && MAP_ID.test(body.id) ? body.id : bad("A prefix list name starts with a letter and uses letters, numbers, - and _");
        const entries = Array.isArray(body.entries) ? body.entries.map((x: unknown) => Object.entries(prefixEntry(x)).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(",")) : [];
        if (entries.length > 256) bad("That is too many entries");
        await c.asUser((pve) => pve.call("POST", "/cluster/sdn/prefix-lists", { id, entries: entries.length ? entries : undefined }));
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/cluster\/sdn\/prefix-lists\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const id = MAP_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a prefix list name");
        const body = await c.readJson();
        noExtra(body, ["confirm"]);
        confirmed(body, id, `removing the prefix list ${id}`);
        await c.asUser(async (pve) => {
          const by = await usedBy(pve, "prefixlist", id);
          if (by.length) throw new HttpError(409, "in_use", `${id} is still used by ${by.join(", ")}. Change those first.`);
          await pve.call("DELETE", `/cluster/sdn/prefix-lists/${seg(id)}`);
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "POST",
      re: /^\/api\/cluster\/sdn\/prefix-lists\/([^/]+)\/entries$/,
      run: async (c, m) => {
        c.sameSite();
        const id = MAP_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a prefix list name");
        const e = prefixEntry(await c.readJson(), true);
        await c.asUser((pve) => pve.call("POST", `/cluster/sdn/prefix-lists/${seg(id)}/entries`, e));
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/cluster\/sdn\/prefix-lists\/([^/]+)\/entries\/(\d+)$/,
      run: async (c, m) => {
        c.sameSite();
        const id = MAP_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a prefix list name");
        await c.readJson();
        await c.asUser((pve) => pve.call("DELETE", `/cluster/sdn/prefix-lists/${seg(id)}/entries/${Number(m[2])}`));
        c.json(200, { ok: true });
      },
    },

    // ---- Route maps (one entry at a time)
    {
      method: "POST",
      re: /^\/api\/cluster\/sdn\/route-maps\/([^/]+)\/entries$/,
      run: async (c, m) => {
        c.sameSite();
        const id = MAP_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a route map name");
        const e = routeEntry(await c.readJson());
        await c.asUser((pve) => pve.call("POST", "/cluster/sdn/route-maps/entries", { "route-map-id": id, ...e }));
        c.json(200, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/cluster\/sdn\/route-maps\/([^/]+)\/entries\/(\d+)$/,
      run: async (c, m) => {
        c.sameSite();
        const id = MAP_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a route map name");
        const body = await c.readJson();
        const e = routeEntry({ ...body, order: Number(m[2]) });
        await c.asUser((pve) => pve.call("PUT", `/cluster/sdn/route-maps/entries/${seg(id)}/entry/${Number(m[2])}`, { ...e, digest: typeof body.digest === "string" && DIGEST.test(body.digest) ? body.digest : undefined }));
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/cluster\/sdn\/route-maps\/([^/]+)\/entries\/(\d+)$/,
      run: async (c, m) => {
        c.sameSite();
        const id = MAP_ID.test(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : bad("That isn't a route map name");
        const body = await c.readJson();
        noExtra(body, ["confirm"]);
        confirmed(body, `${id}:${Number(m[2])}`, `removing entry ${Number(m[2])} of the route map ${id}`);
        await c.asUser(async (pve) => {
          // The last entry going takes the route map with it; anything that still points at it would break.
          const entries = (await soft(pve.call<Json[]>("GET", `/cluster/sdn/route-maps/entries/${seg(id)}`))).data ?? [];
          if (entries.length <= 1) {
            const by = await usedBy(pve, "routemap", id);
            if (by.length) throw new HttpError(409, "in_use", `${id} is still used by ${by.join(", ")}. Change those first.`);
          }
          await pve.call("DELETE", `/cluster/sdn/route-maps/entries/${seg(id)}/entry/${Number(m[2])}`);
        });
        c.json(200, { ok: true });
      },
    },
  ];
}

function prefixEntry(raw: unknown, withSeq = false): Json {
  const e = asRecord(raw);
  for (const k of Object.keys(e)) if (!["action", "prefix", "ge", "le", "seq"].includes(k)) bad(`Unknown field “${k}” in a prefix entry`);
  if (e.action !== "permit" && e.action !== "deny") bad("An entry permits or denies");
  if (typeof e.prefix !== "string" || !isCidr(e.prefix)) bad("An entry needs a prefix like 10.0.0.0/8");
  const int = (v: unknown, lo: number, hi: number, what: string) => (v === undefined || v === "" ? undefined : Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : bad(`${what} goes from ${lo} to ${hi}`));
  const ge = int(e.ge, 0, 128, "The shortest prefix length");
  const le = int(e.le, 0, 128, "The longest prefix length");
  if (ge !== undefined && le !== undefined && ge > le) bad("The shortest prefix length can't be more than the longest");
  const seq = int(e.seq, 1, 4294967295, "The sequence number");
  if (withSeq && seq === undefined) bad("An entry needs a sequence number");
  return { action: e.action, prefix: e.prefix, ge, le, seq };
}

function routeEntry(raw: Json): Json {
  const allowed = ["order", "action", "match", "set", "call", "exit-action", "digest"];
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) bad(`Unknown field “${k}”`);
  const order = typeof raw.order === "number" && Number.isInteger(raw.order) && raw.order >= 0 && raw.order <= 65535 ? raw.order : bad("The order is a whole number from 0 to 65535");
  if (raw.action !== "permit" && raw.action !== "deny") bad("An entry permits or denies");
  const kv = (list: unknown, keys: readonly string[], what: string): string[] | undefined => {
    if (list === undefined || list === null) return undefined;
    if (!Array.isArray(list) || list.length > 32) return bad(`${what} is a list of conditions`);
    return list.map((x) => {
      const r = asRecord(x);
      if (typeof r.key !== "string" || !keys.includes(r.key)) return bad(`${what}: ${String(r.key)} isn't a known key`);
      if (r.value !== undefined && (typeof r.value !== "string" || r.value.length > 128 || /[,\s]/.test(r.value))) return bad(`${what}: the value of ${r.key} is a single word`);
      return r.value === undefined || r.value === "" ? `key=${r.key}` : `key=${r.key},value=${r.value}`;
    });
  };
  if (raw.call !== undefined && raw.call !== "" && (typeof raw.call !== "string" || !MAP_ID.test(raw.call))) bad("The route map to call is a route map name");
  if (raw["exit-action"] !== undefined && raw["exit-action"] !== "" && !["next", "goto"].includes(String(raw["exit-action"]).split(" ")[0])) bad("The exit action is next or goto <number>");
  return { order, action: raw.action, match: kv(raw.match, ROUTE_MATCH_KEYS, "Match"), set: kv(raw.set, ROUTE_SET_KEYS, "Set"), call: raw.call || undefined, "exit-action": raw["exit-action"] || undefined };
}

