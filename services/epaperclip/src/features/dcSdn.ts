import { asNumber, checkDc, isCidr, isIp, objectId, withDelete } from "./dcCommon.ts";
import { DC_SCHEMAS } from "./dcSchema.ts";
import { bad, confirmed, noExtra, resolveNode, seg, soft, str, type Deps, type Route } from "./nodeCommon.ts";
import type { Schema } from "./nodeSchema.ts";
import { readGroup } from "./nodeValidate.ts";

/**
 * Software-defined networking, complete: zones (simple, VLAN, QinQ, VXLAN, EVPN), VNets, subnets with DHCP ranges,
 * IPAM and DNS plugins, EVPN/BGP/IS-IS controllers, VNet firewall options and rules, what each node has running,
 * and the staged-changes workflow (preview, apply, roll back). Changes are staged by Proxmox until applied.
 */

type Raw = Record<string, any>;
const SDN_ID = /^[a-z][a-z0-9]{0,7}$/;
const OBJ_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const subset = (schema: Schema, keys: string[], required: string[] = []): Schema => Object.fromEntries(keys.filter((k) => schema[k]).map((k) => [k, { ...schema[k], required: required.includes(k) || undefined }]));

const COMMON_ZONE = ["nodes", "ipam", "dhcp", "dns", "reversedns", "dnszone", "mtu"];
const ZONE_TYPES = {
  simple: { label: "Simple", keys: COMMON_ZONE, required: [] as string[] },
  vlan: { label: "VLAN", keys: [...COMMON_ZONE, "bridge"], required: ["bridge"] },
  qinq: { label: "QinQ", keys: [...COMMON_ZONE, "bridge", "tag", "vlan-protocol"], required: ["bridge", "tag"] },
  vxlan: { label: "VXLAN", keys: [...COMMON_ZONE, "peers", "fabric", "vxlan-port"], required: [] as string[] },
  evpn: { label: "EVPN", keys: [...COMMON_ZONE, "controller", "vrf-vxlan", "mac", "exitnodes", "exitnodes-primary", "exitnodes-local-routing", "advertise-subnets", "disable-arp-nd-suppression", "rt-import"], required: ["controller", "vrf-vxlan"] },
} as const;
const IPAM_TYPES = { pve: { label: "Proxmox", keys: [], required: [] as string[] }, netbox: { label: "NetBox", keys: ["url", "token", "fingerprint"], required: ["url", "token"] }, phpipam: { label: "phpIPAM", keys: ["url", "token", "section", "fingerprint"], required: ["url", "token", "section"] } } as const;
const DNS_TYPES = { powerdns: { label: "PowerDNS", keys: ["url", "key", "ttl", "reversemaskv6", "reversev6mask", "fingerprint"], required: ["url", "key"] } } as const;
const CONTROLLER_TYPES = {
  evpn: { label: "EVPN", keys: ["asn", "peers", "fabric"], required: ["asn"] },
  bgp: { label: "BGP", keys: ["asn", "peers", "nodes", "ebgp", "ebgp-multihop", "loopback", "bgp-multipath-as-path-relax", "peer-group-name", "route-map-in", "route-map-out", "bgp-mode"], required: ["asn"] },
  isis: { label: "IS-IS", keys: ["isis-domain", "isis-ifaces", "isis-net", "nodes", "loopback"], required: [] as string[] },
} as const;

type KindDef = { path: string; idKey: string; types: Record<string, { label: string; keys: readonly string[]; required: readonly string[] }>; schema: Schema; idRe: RegExp; what: string };
const KINDS: Record<string, KindDef> = {
  zones: { path: "/cluster/sdn/zones", idKey: "zone", types: ZONE_TYPES, schema: DC_SCHEMAS.sdnZone, idRe: SDN_ID, what: "zone" },
  ipams: { path: "/cluster/sdn/ipams", idKey: "ipam", types: IPAM_TYPES, schema: DC_SCHEMAS.sdnIpam, idRe: OBJ_ID, what: "IPAM" },
  dns: { path: "/cluster/sdn/dns", idKey: "dns", types: DNS_TYPES, schema: DC_SCHEMAS.sdnDns, idRe: OBJ_ID, what: "DNS plugin" },
  controllers: { path: "/cluster/sdn/controllers", idKey: "controller", types: CONTROLLER_TYPES, schema: DC_SCHEMAS.sdnController, idRe: OBJ_ID, what: "controller" },
};

const typeSchema = (k: KindDef, type: string): Schema => {
  const t = k.types[type] ?? bad(`Pick one of ${Object.keys(k.types).join(", ")}`);
  return subset(k.schema, [...t.keys], [...t.required]);
};

/** With pending=1 Proxmox puts staged values under `pending`; what will be after apply is shown, and the state kept. */
const merged = (x: Raw): Raw => ({ ...x, ...(x.pending && typeof x.pending === "object" ? x.pending : {}), state: x.state ?? null });
const noPending = (x: Raw) => {
  const { pending: _p, ...rest } = x;
  return rest;
};

function describe(k: KindDef, raw: Raw) {
  const x = merged(raw);
  const type = String(x.type ?? "");
  return { id: String(x[k.idKey] ?? ""), type, state: typeof x.state === "string" ? x.state : null, digest: typeof x.digest === "string" ? x.digest : null, values: readGroup(typeSchema(k, type in k.types ? type : Object.keys(k.types)[0]), noPending(x)), secretsSet: Object.entries(k.schema).filter(([key, f]) => f.secret && x[key] !== undefined).map(([key]) => key) };
}

const SUBNET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,100}$/;

export function sdnRoutes(_d: Deps): Route[] {
  const kindOf = (name: string): KindDef => KINDS[name] ?? bad("Unknown SDN object");
  return [
    // ---- Everything in one read
    {
      method: "GET",
      re: /^\/api\/node\/sdn$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const pend = { pending: 1 } as const;
          const [zones, vnets, ipams, dns, controllers] = await Promise.all([
            soft(pve.call<Raw[]>("GET", KINDS.zones.path, pend)),
            soft(pve.call<Raw[]>("GET", "/cluster/sdn/vnets", pend)),
            soft(pve.call<Raw[]>("GET", KINDS.ipams.path)),
            soft(pve.call<Raw[]>("GET", KINDS.dns.path)),
            soft(pve.call<Raw[]>("GET", KINDS.controllers.path, pend)),
          ]);
          const subnets = await Promise.all((vnets.data ?? []).map((v) => soft(pve.call<Raw[]>("GET", `/cluster/sdn/vnets/${seg(String(v.vnet))}/subnets`, pend))));
          const vs = (vnets.data ?? []).map((v, i) => {
            const x = merged(v);
            return {
              vnet: String(x.vnet),
              zone: typeof x.zone === "string" ? x.zone : null,
              tag: typeof x.tag === "number" ? x.tag : null,
              alias: typeof x.alias === "string" ? x.alias : null,
              vlanaware: x.vlanaware === 1 || x.vlanaware === true,
              isolatePorts: x["isolate-ports"] === 1 || x["isolate-ports"] === true,
              state: typeof x.state === "string" ? x.state : null,
              digest: typeof x.digest === "string" ? x.digest : null,
              subnets: (subnets[i].data ?? []).map((s) => {
                const y = merged(s);
                const id = String(y.subnet ?? y.id ?? "");
                return { id, cidr: typeof y.cidr === "string" ? y.cidr : id.replace(/^[^-]+-/, "").replace(/-(\d+)$/, "/$1"), gateway: typeof y.gateway === "string" ? y.gateway : null, snat: y.snat === 1 || y.snat === true, dhcpRange: (Array.isArray(y["dhcp-range"]) ? y["dhcp-range"] : y["dhcp-range"] ? [y["dhcp-range"]] : []).map(String), dhcpDns: typeof y["dhcp-dns-server"] === "string" ? y["dhcp-dns-server"] : null, dnszoneprefix: typeof y.dnszoneprefix === "string" ? y.dnszoneprefix : null, state: typeof y.state === "string" ? y.state : null, digest: typeof y.digest === "string" ? y.digest : null };
              }),
            };
          });
          const zs = (zones.data ?? []).map((z) => describe(KINDS.zones, z));
          const pending = [...zs, ...vs, ...vs.flatMap((v) => v.subnets), ...(controllers.data ?? []).map((x) => describe(KINDS.controllers, x))].filter((x) => x.state).length;
          return {
            zones: zs,
            vnets: vs,
            ipams: (ipams.data ?? []).map((x) => describe(KINDS.ipams, x)),
            dns: (dns.data ?? []).map((x) => describe(KINDS.dns, x)),
            controllers: (controllers.data ?? []).map((x) => describe(KINDS.controllers, x)),
            pending,
            denied: zones.denied || vnets.denied,
            error: zones.error ?? vnets.error,
            types: Object.fromEntries(Object.entries(KINDS).map(([name, k]) => [name, Object.fromEntries(Object.entries(k.types).map(([t, d]) => [t, { label: d.label, schema: typeSchema(k, t), required: d.required }]))])),
            vnetSchema: DC_SCHEMAS.sdnVnet,
            subnetSchema: DC_SCHEMAS.sdnSubnet,
            firewallSchema: DC_SCHEMAS.sdnVnetFirewall,
          };
        });
        c.json(200, out);
      },
    },

    // ---- Zones, IPAM, DNS plugins and controllers share one shape
    {
      method: "POST",
      re: /^\/api\/node\/sdn\/(zones|ipams|dns|controllers)$/,
      run: async (c, m) => {
        c.sameSite();
        const k = kindOf(m[1]);
        const body = await c.readJson(100_000);
        noExtra(body, ["id", "type", "values"]);
        const id = typeof body.id === "string" && k.idRe.test(body.id) ? body.id : bad(k.idKey === "zone" ? "Zone names are up to 8 lowercase letters and digits, starting with a letter" : `The ${k.what} name must start with a letter and use letters, numbers, - and _`);
        const type = typeof body.type === "string" && body.type in k.types ? body.type : bad(`Pick one of ${Object.keys(k.types).join(", ")}`);
        const checked = checkDc(typeSchema(k, type), (body.values ?? {}) as Record<string, unknown>, { creating: true });
        if (m[1] === "zones" && type === "vxlan" && !checked.params.peers && !checked.params.fabric) bad("A VXLAN zone needs the addresses of its peers or a fabric");
        await c.asUser((pve) => pve.call("POST", k.path, { [k.idKey]: id, type, ...checked.params } as Record<string, string | number | string[]>));
        c.json(201, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/sdn\/(zones|ipams|dns|controllers)\/([A-Za-z][A-Za-z0-9_-]{0,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const k = kindOf(m[1]);
        const id = objectId(m[2], k.what);
        const body = await c.readJson(100_000);
        noExtra(body, ["values", "digest"]);
        const digest = typeof body.digest === "string" && /^[0-9a-f]{20,64}$/i.test(body.digest) ? body.digest : undefined;
        await c.asUser(async (pve) => {
          const cur = await pve.call<Raw>("GET", `${k.path}/${seg(id)}`, { pending: m[1] === "zones" || m[1] === "controllers" ? 1 : undefined });
          const type = String(cur.type ?? "");
          const checked = checkDc(typeSchema(k, type), (body.values ?? {}) as Record<string, unknown>);
          if (!Object.keys(checked.params).length && !checked.remove.length) bad("Nothing to change");
          await pve.call("PUT", `${k.path}/${seg(id)}`, withDelete(checked, { digest }));
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/node\/sdn\/(zones|ipams|dns|controllers)\/([A-Za-z][A-Za-z0-9_-]{0,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const k = kindOf(m[1]);
        confirmed(await c.readJson(), m[2], `deleting the ${k.what} ${m[2]}`);
        await c.asUser((pve) => pve.call("DELETE", `${k.path}/${seg(m[2])}`));
        c.json(200, { ok: true });
      },
    },

    // ---- VNets
    {
      method: "POST",
      re: /^\/api\/node\/sdn\/vnets$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(50_000);
        noExtra(body, ["id", "values"]);
        const id = typeof body.id === "string" && SDN_ID.test(body.id) ? body.id : bad("VNet names are up to 8 lowercase letters and digits, starting with a letter");
        const checked = checkDc(DC_SCHEMAS.sdnVnet, (body.values ?? {}) as Record<string, unknown>, { creating: true });
        if (typeof checked.params.zone === "string" && !SDN_ID.test(checked.params.zone)) bad("Pick a zone");
        await c.asUser((pve) => pve.call("POST", "/cluster/sdn/vnets", { vnet: id, ...checked.params } as Record<string, string | number | string[]>));
        c.json(201, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/sdn\/vnets\/([a-z][a-z0-9]{0,7})$/,
      run: async (c, m) => {
        c.sameSite();
        const body = await c.readJson(50_000);
        noExtra(body, ["values", "digest"]);
        const checked = checkDc(DC_SCHEMAS.sdnVnet, (body.values ?? {}) as Record<string, unknown>);
        if (!Object.keys(checked.params).length && !checked.remove.length) bad("Nothing to change");
        const digest = typeof body.digest === "string" && /^[0-9a-f]{20,64}$/i.test(body.digest) ? body.digest : undefined;
        await c.asUser((pve) => pve.call("PUT", `/cluster/sdn/vnets/${seg(m[1])}`, withDelete({ ...checked, remove: checked.remove.filter((r) => r !== "zone") }, { digest })));
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/node\/sdn\/vnets\/([a-z][a-z0-9]{0,7})$/,
      run: async (c, m) => {
        c.sameSite();
        confirmed(await c.readJson(), m[1], `deleting the VNet ${m[1]}`);
        await c.asUser((pve) => pve.call("DELETE", `/cluster/sdn/vnets/${seg(m[1])}`));
        c.json(200, { ok: true });
      },
    },

    // ---- Subnets
    {
      method: "POST",
      re: /^\/api\/node\/sdn\/vnets\/([a-z][a-z0-9]{0,7})\/subnets$/,
      run: async (c, m) => {
        c.sameSite();
        const body = await c.readJson(50_000);
        noExtra(body, ["cidr", "values"]);
        const cidr = typeof body.cidr === "string" && isCidr(body.cidr) ? body.cidr : bad("Use a network like 10.20.0.0/24");
        const checked = checkDc(DC_SCHEMAS.sdnSubnet, (body.values ?? {}) as Record<string, unknown>);
        await c.asUser((pve) => pve.call("POST", `/cluster/sdn/vnets/${seg(m[1])}/subnets`, { subnet: cidr, type: "subnet", ...checked.params } as Record<string, string | number | string[]>));
        c.json(201, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/sdn\/vnets\/([a-z][a-z0-9]{0,7})\/subnets\/([A-Za-z0-9][A-Za-z0-9._:-]{2,100})$/,
      run: async (c, m) => {
        c.sameSite();
        const body = await c.readJson(50_000);
        noExtra(body, ["values", "digest"]);
        const checked = checkDc(DC_SCHEMAS.sdnSubnet, (body.values ?? {}) as Record<string, unknown>);
        if (!Object.keys(checked.params).length && !checked.remove.length) bad("Nothing to change");
        const digest = typeof body.digest === "string" && /^[0-9a-f]{20,64}$/i.test(body.digest) ? body.digest : undefined;
        await c.asUser((pve) => pve.call("PUT", `/cluster/sdn/vnets/${seg(m[1])}/subnets/${seg(m[2])}`, withDelete(checked, { digest })));
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/node\/sdn\/vnets\/([a-z][a-z0-9]{0,7})\/subnets\/([A-Za-z0-9][A-Za-z0-9._:-]{2,100})$/,
      run: async (c, m) => {
        c.sameSite();
        if (!SUBNET_ID.test(m[2])) bad("That isn't a subnet");
        confirmed(await c.readJson(), m[2], `deleting the subnet ${m[2]}`);
        await c.asUser((pve) => pve.call("DELETE", `/cluster/sdn/vnets/${seg(m[1])}/subnets/${seg(m[2])}`));
        c.json(200, { ok: true });
      },
    },

    // ---- Staged changes: preview, apply, roll back
    {
      method: "GET",
      re: /^\/api\/node\/sdn\/preview$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const r = await soft(pve.call<unknown>("GET", "/cluster/sdn/dry-run", { node }));
          return { node, denied: r.denied, error: r.error, preview: typeof r.data === "string" ? r.data.slice(0, 200_000) : r.data ? JSON.stringify(r.data, null, 1).slice(0, 200_000) : null };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/sdn\/apply$/,
      run: async (c) => {
        c.sameSite();
        await c.readJson();
        const task = await c.asUser((pve) => pve.call<string>("PUT", "/cluster/sdn"));
        c.json(202, { task });
      },
    },
    {
      // Discards every staged SDN change. Typed confirmation because the staged work is lost.
      method: "POST",
      re: /^\/api\/node\/sdn\/rollback$/,
      run: async (c) => {
        c.sameSite();
        confirmed(await c.readJson(), "rollback", "discarding every staged SDN change");
        await c.asUser((pve) => pve.call("POST", "/cluster/sdn/rollback"));
        c.json(200, { ok: true });
      },
    },

    // ---- IPAM: status and the addresses VNets hold
    {
      method: "GET",
      re: /^\/api\/node\/sdn\/ipams\/([A-Za-z][A-Za-z0-9_-]{0,63})\/status$/,
      run: async (c, m) => {
        const list = await c.asUser((pve) => pve.call<Raw[]>("GET", `/cluster/sdn/ipams/${seg(m[1])}/status`));
        c.json(200, { entries: list.slice(0, 5000).map((e) => ({ ip: String(e.ip ?? ""), vnet: typeof e.vnet === "string" ? e.vnet : null, zone: typeof e.zone === "string" ? e.zone : null, subnet: typeof e.subnet === "string" ? e.subnet : null, mac: typeof e.mac === "string" ? e.mac : null, hostname: typeof e.hostname === "string" ? e.hostname : null, vmid: typeof e.vmid === "number" ? e.vmid : null, gateway: e.gateway === 1 || e.gateway === true })).filter((e) => e.ip) });
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/sdn\/vnets\/([a-z][a-z0-9]{0,7})\/ips$/,
      run: async (c, m) => {
        c.sameSite();
        const body = await c.readJson(10_000);
        noExtra(body, ["zone", "ip", "mac", "vmid", "action"]);
        const zone = typeof body.zone === "string" && SDN_ID.test(body.zone) ? body.zone : bad("Pick the zone");
        const ip = typeof body.ip === "string" && isIp(body.ip) ? body.ip : bad("Enter an IP address");
        const mac = body.mac === undefined || body.mac === "" || body.mac === null ? undefined : typeof body.mac === "string" && /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$/.test(body.mac) ? body.mac : bad("A MAC address looks like BC:24:11:AA:BB:CC");
        const vmid = body.vmid === undefined || body.vmid === null || body.vmid === "" ? undefined : asNumber(body.vmid, "Machine", 100, 999999999);
        const action = body.action === "update" ? "PUT" : body.action === "delete" ? "DELETE" : "POST";
        if (action !== "DELETE" && !mac) bad("Enter the MAC address that holds this IP");
        await c.asUser((pve) => pve.call(action, `/cluster/sdn/vnets/${seg(m[1])}/ips`, { zone, ip, mac, vmid: action === "DELETE" ? undefined : vmid }));
        c.json(200, { ok: true });
      },
    },

    // ---- VNet firewall
    {
      method: "GET",
      re: /^\/api\/node\/sdn\/vnets\/([a-z][a-z0-9]{0,7})\/firewall$/,
      run: async (c, m) => {
        const out = await c.asUser(async (pve) => {
          const [opts, rules] = await Promise.all([soft(pve.call<Raw>("GET", `/cluster/sdn/vnets/${seg(m[1])}/firewall/options`)), soft(pve.call<Raw[]>("GET", `/cluster/sdn/vnets/${seg(m[1])}/firewall/rules`))]);
          return {
            values: readGroup(DC_SCHEMAS.sdnVnetFirewall, opts.data ?? {}),
            digest: typeof opts.data?.digest === "string" ? opts.data.digest : null,
            denied: opts.denied,
            rules: (rules.data ?? []).map((r) => ({ pos: typeof r.pos === "number" ? r.pos : null, type: String(r.type ?? ""), action: String(r.action ?? ""), enable: r.enable === 1, source: str(r.source) ?? null, dest: str(r.dest) ?? null, proto: str(r.proto) ?? null, dport: str(r.dport) ?? null, sport: str(r.sport) ?? null, macro: str(r.macro) ?? null, comment: str(r.comment, 500) ?? null })),
            schema: DC_SCHEMAS.sdnVnetFirewall,
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/sdn\/vnets\/([a-z][a-z0-9]{0,7})\/firewall$/,
      run: async (c, m) => {
        c.sameSite();
        const body = await c.readJson(10_000);
        noExtra(body, ["values", "digest"]);
        const checked = checkDc(DC_SCHEMAS.sdnVnetFirewall, (body.values ?? {}) as Record<string, unknown>);
        if (!Object.keys(checked.params).length && !checked.remove.length) bad("Nothing to change");
        const digest = typeof body.digest === "string" && /^[0-9a-f]{20,64}$/i.test(body.digest) ? body.digest : undefined;
        await c.asUser((pve) => pve.call("PUT", `/cluster/sdn/vnets/${seg(m[1])}/firewall/options`, withDelete(checked, { digest })));
        c.json(200, { ok: true });
      },
    },

    // ---- What a node is running right now
    {
      method: "GET",
      re: /^\/api\/node\/sdn\/status$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const zones = await soft(pve.call<Raw[]>("GET", `/nodes/${seg(node)}/sdn/zones`));
          const withBridges = await Promise.all(
            (zones.data ?? []).slice(0, 100).map(async (z) => {
              const zone = String(z.zone ?? "");
              const content = SDN_ID.test(zone) ? await soft(pve.call<Raw[]>("GET", `/nodes/${seg(node)}/sdn/zones/${seg(zone)}/content`)) : null;
              return { zone, status: typeof z.status === "string" ? z.status : null, vnets: (content?.data ?? []).map((v) => ({ vnet: String(v.vnet ?? ""), status: typeof v.status === "string" ? v.status : null, statusmsg: typeof v.statusmsg === "string" ? v.statusmsg.slice(0, 300) : null })) };
            }),
          );
          return { node, denied: zones.denied, error: zones.error, zones: withBridges };
        });
        c.json(200, out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/node\/sdn\/vnets\/([a-z][a-z0-9]{0,7})\/mac-vrf$/,
      run: async (c, m) => {
        const list = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          return pve.call<Raw[]>("GET", `/nodes/${seg(node)}/sdn/vnets/${seg(m[1])}/mac-vrf`);
        });
        c.json(200, { entries: list.slice(0, 5000).map((e) => ({ ip: str(e.ip) ?? null, mac: str(e.mac) ?? null, nexthop: str(e.nexthop) ?? null })) });
      },
    },
  ];
}
