import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { getProp, parseProps } from "../hardware.ts";
import { digest } from "./disksCheck.ts";
import type { FeatureCtx, FeatureHandler } from "./index.ts";
import {
  CheckError, NIC_KEY_RE, SERIAL_KEY_RE, aclParams, audioValue, biosValue, ctDns, ctFeatures, ctNic, ctNicString, description, display, efiValue, featuresString, grant, memoryOf, nextNetKey, readDisplay, readFeatures, readNic, readPassthrough, resources, serialValue, tags, tpmValue, vmNic, vmNicString,
} from "./guestCheck.ts";

/**
 * The machine page beyond what Hardware already covered: the machine's addresses and hostname, network devices (VM and
 * container), container DNS and features, resources, notes and tags, display / serial / audio / EFI / TPM / BIOS, the
 * host devices handed to it, and who may use it. Everything runs as the signed-in person; Proxmox decides who may do
 * what. Edits carry the configuration digest from the last read and are refused when the machine changed since.
 * See docs/MACHINE.md.
 */

type Cfg = Record<string, string | number>;
type Json = Record<string, unknown>;
const seg = encodeURIComponent;
const ROUTE = /^\/api\/guests\/(\d+)\/(devices|addresses|passthrough|permissions|network|network\/(net\d{1,2})\/delete|dns|features|resources|notes|items\/(display|bios|serial|audio|efi|tpm))$/;

interface Found {
  node: string;
  type: "qemu" | "lxc";
  status: string;
  name: string;
  pool: string | null;
}

export const handleGuest: FeatureHandler = async (ctx) => {
  const m = ctx.path.match(ROUTE);
  if (!m) return false;
  try {
    return await route(ctx, m);
  } catch (e) {
    if (e instanceof CheckError) throw new ctx.HttpError(400, "bad_request", e.message);
    throw e;
  }
};

const pveReason = (e: unknown): string | null => (e instanceof ProxmoxError ? e.detail : null);

async function route(ctx: FeatureCtx, m: RegExpMatchArray): Promise<boolean> {
  const { HttpError } = ctx;
  const vmid = Number(m[1]);
  const what = m[2];

  const find = async (pve: ProxmoxClient): Promise<Found> => {
    const g = (await pve.clusterResources()).find((r) => r.vmid === vmid);
    if (!g || (g.type !== "lxc" && g.type !== "qemu")) throw new HttpError(404, "not_found", "Unknown machine");
    return { node: g.node ?? ctx.node, type: g.type as "lxc" | "qemu", status: g.status ?? "unknown", name: g.name ?? String(vmid), pool: g.pool ?? null };
  };
  const url = (g: Found, tail: string) => `/nodes/${seg(g.node)}/${g.type}/${vmid}/${tail}`;

  if (ctx.method === "GET") {
    const out = await ctx.asUser(async (pve): Promise<unknown> => {
      const g = await find(pve);
      if (what === "devices") return devices(ctx, pve, g, vmid);
      if (what === "addresses") return addresses(pve, g, vmid, url);
      if (what === "passthrough") return passthrough(pve, g);
      if (what === "permissions") return permissions(pve, g, vmid);
      throw new HttpError(405, "method", "Method not allowed");
    });
    return ctx.json(200, out), true;
  }
  if (ctx.method !== "POST") throw new HttpError(405, "method", "Method not allowed");
  ctx.sameSite();
  const b = await ctx.readJson();

  if (what === "permissions") {
    const out = await ctx.asUser(async (pve) => {
      const g = await find(pve);
      const spec = grant(b);
      const path = `/vms/${vmid}`;
      if (b.action === "revoke") {
        if (b.confirm !== spec.id) throw new HttpError(409, "confirm", `Type ${spec.id} to confirm.`);
        await pve.call("PUT", "/access/acl", aclParams(path, spec, true));
      } else if (b.action === "grant") {
        await verifyPrincipal(pve, spec);
        await pve.call("PUT", "/access/acl", aclParams(path, spec, false));
      } else throw new CheckError("Choose grant or revoke");
      return permissions(pve, g, vmid);
    });
    return ctx.json(200, out), true;
  }

  const dg = digest(b.digest);
  const result = await ctx.asUser(async (pve): Promise<unknown> => {
    const g = await find(pve);
    const cfg = await pve.call<Cfg>("GET", url(g, "config"));
    if (cfg.digest !== dg) throw new HttpError(409, "stale", "This machine changed since the page loaded. Reload and try again.");
    if (typeof cfg.lock === "string") throw new HttpError(409, "busy", `This machine is busy (${cfg.lock}). Try again when it's done.`);
    const put = async (params: Record<string, string | number | boolean | undefined>) => {
      await pve.call("PUT", url(g, "config"), { ...params, digest: dg });
      return { ok: true, pending: g.status === "running" };
    };
    const typeOnly = (t: "qemu" | "lxc", msg: string) => {
      if (g.type !== t) throw new CheckError(msg);
    };

    if (what === "network") {
      const key = b.key === undefined || b.key === null ? null : typeof b.key === "string" && NIC_KEY_RE.test(b.key) ? b.key : (() => { throw new CheckError("Unknown network device"); })();
      if (key && !(key in cfg)) throw new HttpError(404, "not_found", "That network device isn't on this machine");
      const k = key ?? nextNetKey(cfg);
      if (g.type === "qemu") return { key: k, ...(await put({ [k]: vmNicString(vmNic(b), key ? String(cfg[key]) : undefined) })) };
      const taken = Object.entries(cfg).filter(([x]) => /^net\d+$/.test(x) && x !== key).map(([, v]) => getProp(parseProps(String(v)), "name") ?? "");
      return { key: k, ...(await put({ [k]: ctNicString(ctNic(b, taken), key ? String(cfg[key]) : undefined) })) };
    }
    if (m[3]) {
      if (!(m[3] in cfg)) throw new HttpError(404, "not_found", "That network device isn't on this machine");
      if (b.confirm !== m[3]) throw new HttpError(409, "confirm", `Type ${m[3]} to confirm.`);
      return put({ delete: m[3] });
    }
    if (what === "dns") {
      typeOnly("lxc", "DNS settings are for containers. VMs get theirs from Cloud-Init or from inside.");
      const d = ctDns(b);
      const del = [!d.nameserver.length && "nameserver", !d.searchdomain.length && "searchdomain"].filter(Boolean).join(",");
      return put({ ...(d.nameserver.length ? { nameserver: d.nameserver.join(" ") } : {}), ...(d.searchdomain.length ? { searchdomain: d.searchdomain.join(" ") } : {}), ...(del ? { delete: del } : {}) });
    }
    if (what === "features") {
      typeOnly("lxc", "Features are for containers");
      const value = featuresString(ctFeatures(b), cfg.features === undefined ? undefined : String(cfg.features));
      return put(value === null ? { delete: "features" } : { features: value });
    }
    if (what === "resources") {
      const r = resources(g.type, memoryOf(cfg.memory), b);
      return put({ ...r.params, ...(r.delete.length ? { delete: r.delete.join(",") } : {}) });
    }
    if (what === "notes") {
      const params: Record<string, string> = {};
      const del: string[] = [];
      if (b.description !== undefined) {
        const text = description(b.description);
        if (text.trim()) params.description = text;
        else del.push("description");
      }
      if (b.tags !== undefined) {
        const list = tags(b.tags);
        if (list.length) params.tags = list.join(";");
        else del.push("tags");
      }
      if (!Object.keys(params).length && !del.length) throw new CheckError("Nothing to change");
      return put({ ...params, ...(del.length ? { delete: del.join(",") } : {}) });
    }

    // ---- Items only VMs have: display, BIOS, serial ports, audio, EFI disk, TPM
    const item = m[4];
    typeOnly("qemu", "These are for virtual machines");
    const remove = b.action === "remove";
    if (b.action !== "set" && b.action !== "add" && !remove) throw new CheckError("Choose what to do");
    if (item === "display") return remove ? put({ delete: "vga" }) : put({ vga: display(b) });
    if (item === "bios") {
      const bios = biosValue(b.bios);
      const res = await put({ bios });
      return { ...res, warning: bios === "ovmf" && !("efidisk0" in cfg) ? "UEFI needs an EFI disk to keep its settings. Add one under EFI disk." : null };
    }
    if (item === "serial") {
      if (remove) {
        const k = typeof b.key === "string" && SERIAL_KEY_RE.test(b.key) && b.key in cfg ? b.key : (() => { throw new CheckError("That serial port isn't on this machine"); })();
        return put({ delete: k });
      }
      const k = b.key === undefined ? [0, 1, 2, 3].map((i) => `serial${i}`).find((x) => !(x in cfg)) : typeof b.key === "string" && SERIAL_KEY_RE.test(b.key) ? b.key : undefined;
      if (!k) throw new CheckError("All four serial ports are taken");
      const admin = await ctx.isNodeAdmin(pve);
      return { key: k, ...(await put({ [k]: serialValue(b, admin) })) };
    }
    if (item === "audio") return remove ? put({ delete: "audio0" }) : put({ audio0: audioValue(b) });
    if (item === "efi") {
      if (remove) {
        if (!("efidisk0" in cfg)) throw new CheckError("This machine has no EFI disk");
        if (b.confirm !== "efidisk0") throw new HttpError(409, "confirm", "Type efidisk0 to confirm.");
        return put({ delete: "efidisk0" });
      }
      if ("efidisk0" in cfg) throw new CheckError("This machine already has an EFI disk");
      const e = efiValue(b);
      return put({ efidisk0: e.value, ...(e.ovmf && cfg.bios !== "ovmf" ? { bios: "ovmf" } : {}) });
    }
    if (item === "tpm") {
      if (remove) {
        if (!("tpmstate0" in cfg)) throw new CheckError("This machine has no TPM");
        if (b.confirm !== "tpmstate0") throw new HttpError(409, "confirm", "Type tpmstate0 to confirm.");
        return put({ delete: "tpmstate0" });
      }
      if ("tpmstate0" in cfg) throw new CheckError("This machine already has a TPM");
      return put({ tpmstate0: tpmValue(b) });
    }
    throw new HttpError(404, "not_found", "Not found");
  });
  return ctx.json(200, result), true;
}

async function devices(ctx: FeatureCtx, pve: ProxmoxClient, g: Found, vmid: number) {
  const cfg = await pve.call<Cfg>("GET", `/nodes/${seg(g.node)}/${g.type}/${vmid}/config`);
  const pendingList = g.status === "running" ? await pve.call<{ key: string; pending?: unknown; delete?: number }[]>("GET", `/nodes/${seg(g.node)}/${g.type}/${vmid}/pending`).catch(() => []) : [];
  const pendingKeys = pendingList.filter((p) => p.pending !== undefined || p.delete).map((p) => p.key);
  const vm = g.type === "qemu";
  const nics = Object.entries(cfg).filter(([k]) => /^net\d+$/.test(k)).sort(([a], [b]) => Number(a.slice(3)) - Number(b.slice(3))).map(([k, v]) => ({ ...readNic(g.type, k, String(v)), pending: pendingKeys.includes(k) }));
  const [bridges, isAdmin] = await Promise.all([bridgeNames(pve, g.node), ctx.isNodeAdmin(pve)]);
  const ns = String(cfg.nameserver ?? "").split(/\s+/).filter(Boolean);
  const sd = String(cfg.searchdomain ?? "").split(/\s+/).filter(Boolean);
  const serial = [0, 1, 2, 3].filter((i) => `serial${i}` in cfg).map((i) => ({ key: `serial${i}`, value: String(cfg[`serial${i}`]) }));
  const efi = typeof cfg.efidisk0 === "string" ? parseProps(cfg.efidisk0) : null;
  const tpm = typeof cfg.tpmstate0 === "string" ? parseProps(cfg.tpmstate0) : null;
  const audio = typeof cfg.audio0 === "string" ? parseProps(cfg.audio0) : null;
  return {
    type: g.type,
    status: g.status,
    name: g.name,
    digest: typeof cfg.digest === "string" ? cfg.digest : null,
    locked: typeof cfg.lock === "string" ? cfg.lock : null,
    isAdmin,
    pendingKeys,
    bridges,
    nics,
    dns: vm ? null : { nameserver: ns, searchdomain: sd, fromHost: ns.length === 0 && sd.length === 0 },
    features: vm ? null : readFeatures(cfg.features),
    unprivileged: vm ? null : String(cfg.unprivileged ?? "0") === "1",
    resources: {
      cores: Number(cfg.cores ?? 1),
      sockets: vm ? Number(cfg.sockets ?? 1) : null,
      memory: memoryOf(cfg.memory),
      balloon: vm && cfg.balloon !== undefined ? Number(cfg.balloon) : null,
      swap: vm ? null : Number(cfg.swap ?? 512),
      cpulimit: cfg.cpulimit !== undefined ? Number(cfg.cpulimit) : null,
      cpuunits: cfg.cpuunits !== undefined ? Number(cfg.cpuunits) : null,
      arch: vm ? null : String(cfg.arch ?? "amd64"),
    },
    notes: String(cfg.description ?? ""),
    tags: String(cfg.tags ?? "").split(/[;,\s]+/).filter(Boolean),
    vm: vm
      ? {
          bios: String(cfg.bios ?? "seabios"),
          display: readDisplay(cfg.vga),
          serial,
          audio: audio ? { device: getProp(audio, "device") ?? "", driver: getProp(audio, "driver") ?? "spice" } : null,
          efi: efi ? { volume: efi[0]?.[0] ?? "", efitype: getProp(efi, "efitype") ?? "2m", preEnrolledKeys: getProp(efi, "pre-enrolled-keys") === "1" } : null,
          tpm: tpm ? { volume: tpm[0]?.[0] ?? "", version: getProp(tpm, "version") ?? "v1.2" } : null,
          machine: typeof cfg.machine === "string" ? cfg.machine : null,
        }
      : null,
    passthrough: readPassthrough(g.type, cfg),
  };
}

/** Bridges and SDN networks a network device may join. Best effort: people without Sys.Audit see an empty list. */
async function bridgeNames(pve: ProxmoxClient, node: string): Promise<string[]> {
  const names = new Set<string>();
  const nets = await pve.call<{ iface: string; type?: string }[]>("GET", `/nodes/${seg(node)}/network`, { type: "any_bridge" }).catch(() => []);
  for (const n of Array.isArray(nets) ? nets : []) if (typeof n.iface === "string") names.add(n.iface);
  const vnets = await pve.call<{ vnet: string }[]>("GET", "/cluster/sdn/vnets").catch(() => []);
  for (const v of Array.isArray(vnets) ? vnets : []) if (typeof v.vnet === "string") names.add(v.vnet);
  return [...names].sort();
}

interface Iface {
  name: string;
  mac: string | null;
  addresses: { ip: string; prefix: number | null; family: "ipv4" | "ipv6" }[];
}

async function addresses(pve: ProxmoxClient, g: Found, vmid: number, url: (g: Found, tail: string) => string) {
  const cfg = await pve.call<Cfg>("GET", url(g, "config"));
  const configured = (): Iface[] => {
    const out: Iface[] = [];
    for (const [k, v] of Object.entries(cfg)) {
      const p = parseProps(String(v));
      if (g.type === "lxc" && /^net\d+$/.test(k)) {
        const addrs: Iface["addresses"] = [];
        for (const [fam, key] of [["ipv4", "ip"], ["ipv6", "ip6"]] as const) {
          const ip = getProp(p, key);
          if (ip?.includes("/")) addrs.push({ ip: ip.split("/")[0], prefix: Number(ip.split("/")[1]), family: fam });
        }
        if (addrs.length) out.push({ name: getProp(p, "name") ?? k, mac: getProp(p, "hwaddr") ?? null, addresses: addrs });
      }
      if (g.type === "qemu" && /^ipconfig\d+$/.test(k)) {
        const addrs: Iface["addresses"] = [];
        for (const [fam, key] of [["ipv4", "ip"], ["ipv6", "ip6"]] as const) {
          const ip = getProp(p, key);
          if (ip?.includes("/")) addrs.push({ ip: ip.split("/")[0], prefix: Number(ip.split("/")[1]), family: fam });
        }
        if (addrs.length) out.push({ name: k.replace("ipconfig", "net"), mac: null, addresses: addrs });
      }
    }
    return out;
  };
  const hostnameCfg = g.type === "lxc" ? String(cfg.hostname ?? "") || null : null;
  const reply = (source: "running" | "config" | "none", interfaces: Iface[], hostname: string | null, note: string | null) => ({ type: g.type, source, hostname, note, interfaces });
  const family = (ip: string): "ipv4" | "ipv6" => (ip.includes(":") ? "ipv6" : "ipv4");

  if (g.status !== "running") {
    const c = configured();
    return reply(c.length ? "config" : "none", c, hostnameCfg, c.length ? "Stopped. These are the addresses set in the configuration." : "Start the machine to see its addresses.");
  }
  try {
    if (g.type === "lxc") {
      const list = await pve.call<{ name: string; hwaddr?: string; "hardware-address"?: string; inet?: string; inet6?: string; "ip-addresses"?: { "ip-address"?: string; prefix?: number; "ip-address-type"?: string }[] }[]>("GET", url(g, "interfaces"));
      const interfaces = (Array.isArray(list) ? list : []).map((i): Iface => {
        const addrs = Array.isArray(i["ip-addresses"]) && i["ip-addresses"].length
          ? i["ip-addresses"].filter((a) => a["ip-address"]).map((a) => ({ ip: a["ip-address"]!, prefix: typeof a.prefix === "number" ? a.prefix : null, family: (a["ip-address-type"] === "ipv6" ? "ipv6" : a["ip-address-type"] === "ipv4" ? "ipv4" : family(a["ip-address"]!)) as "ipv4" | "ipv6" }))
          : [i.inet, i.inet6].filter((x): x is string => typeof x === "string" && x.length > 0).map((x) => ({ ip: x.split("/")[0], prefix: x.includes("/") ? Number(x.split("/")[1]) : null, family: family(x) }));
        return { name: i.name, mac: i.hwaddr ?? i["hardware-address"] ?? null, addresses: addrs };
      });
      return reply("running", interfaces, hostnameCfg, null);
    }
    const agentOn = getProp(parseProps(String(cfg.agent ?? "0")), "enabled") === "1" || String(cfg.agent ?? "") === "1" || parseProps(String(cfg.agent ?? ""))[0]?.[0] === "1";
    if (!agentOn) {
      const c = configured();
      return reply(c.length ? "config" : "none", c, null, "Turn on the QEMU guest agent (Hardware, Options) and install it inside the machine to see its addresses here.");
    }
    const res = await pve.call<{ result?: { name: string; "hardware-address"?: string; "ip-addresses"?: { "ip-address": string; "ip-address-type": string; prefix?: number }[] }[] }>("GET", url(g, "agent/network-get-interfaces"));
    const interfaces = (res?.result ?? []).map((i): Iface => ({
      name: i.name,
      mac: i["hardware-address"] ?? null,
      addresses: (i["ip-addresses"] ?? []).filter((a) => a["ip-address"]).map((a) => ({ ip: a["ip-address"], prefix: typeof a.prefix === "number" ? a.prefix : null, family: a["ip-address-type"] === "ipv6" ? "ipv6" : "ipv4" })),
    }));
    const host = await pve.call<{ result?: { "host-name"?: string } }>("GET", url(g, "agent/get-host-name")).then((r) => r?.result?.["host-name"] ?? null, () => null);
    return reply("running", interfaces, host, null);
  } catch (e) {
    if (e instanceof ProxmoxError && e.status === 403) return reply("none", [], hostnameCfg, "Your Proxmox account can't read this machine's addresses.");
    const reason = pveReason(e) ?? "";
    const c = configured();
    return reply(c.length ? "config" : "none", c, hostnameCfg, /agent/i.test(reason) ? "The guest agent isn't answering. Install and start qemu-guest-agent inside the machine." : "Proxmox couldn't read the addresses right now.");
  }
}

async function passthrough(pve: ProxmoxClient, g: Found) {
  const node = seg(g.node);
  const reason = (e: unknown) => (e instanceof ProxmoxError && e.status === 403 ? "Your Proxmox account can't list host devices (it needs Sys.Audit)." : "Proxmox couldn't list host devices.");
  let pciNote: string | null = null;
  let usbNote: string | null = null;
  const pci = await pve.call<Json[]>("GET", `/nodes/${node}/hardware/pci`).catch((e) => ((pciNote = reason(e)), []));
  const usb = await pve.call<Json[]>("GET", `/nodes/${node}/hardware/usb`).catch((e) => ((usbNote = reason(e)), []));
  const maps = async (kind: "pci" | "usb") => {
    const list = await pve.call<{ id: string; description?: string; map?: unknown[] }[]>("GET", `/cluster/mapping/${kind}`).catch(() => []);
    return (Array.isArray(list) ? list : []).filter((x) => typeof x.id === "string").map((x) => ({ id: x.id, description: typeof x.description === "string" ? x.description : "", entries: Array.isArray(x.map) ? x.map.length : 0 }));
  };
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    pci: (Array.isArray(pci) ? pci : []).slice(0, 500).map((d) => ({ id: str(d.id) ?? "", vendor: str(d.vendor_name) ?? str(d.vendor), device: str(d.device_name) ?? str(d.device), class: str(d.class), iommuGroup: typeof d.iommugroup === "number" ? d.iommugroup : -1, mdev: d.mdev === true || d.mdev === 1 })),
    usb: (Array.isArray(usb) ? usb : []).filter((d) => d.class !== 9).slice(0, 500).map((d) => ({ id: `${str(d.vendid) ?? ""}:${str(d.prodid) ?? ""}`, port: `${d.busnum}-${d.port}`, name: str(d.product) ?? str(d.manufacturer) ?? "USB device", speed: str(d.speed) })),
    mappings: { pci: await maps("pci"), usb: await maps("usb") },
    notes: { pci: pciNote, usb: usbNote },
  };
}

async function permissions(pve: ProxmoxClient, g: Found, vmid: number) {
  const path = `/vms/${vmid}`;
  type Entry = { path: string; type: string; ugid: string; roleid: string; propagate?: number };
  const [acl, mine, roles, users, groups] = await Promise.all([
    pve.call<Entry[]>("GET", "/access/acl").catch((e) => (e instanceof ProxmoxError && e.status === 403 ? null : Promise.reject(e))),
    pve.call<Record<string, Record<string, number>>>("GET", "/access/permissions", { path }).catch(() => ({})),
    pve.call<{ roleid: string; privs?: string }[]>("GET", "/access/roles").catch(() => []),
    pve.call<{ userid: string }[]>("GET", "/access/users").catch(() => []),
    pve.call<{ groupid: string }[]>("GET", "/access/groups").catch(() => []),
  ]);
  const list = Array.isArray(acl) ? acl : [];
  const here = (e: Entry) => e.path === path;
  // What reaches this machine from above: the root, all machines, and its resource pool.
  const above = (e: Entry) => !here(e) && e.propagate === 1 && (e.path === "/" || e.path === "/vms" || (g.pool !== null && e.path === `/pool/${g.pool}`));
  const shape = (e: Entry) => ({ path: e.path, type: e.type === "group" ? "group" : e.type === "token" ? "token" : "user", id: e.ugid, role: e.roleid, propagate: e.propagate !== 0 });
  const canModify = (mine as Record<string, Record<string, number>>)?.[path]?.["Permissions.Modify"] === 1;
  return {
    path,
    canModify,
    visible: acl !== null,
    entries: list.filter(here).map(shape),
    inherited: list.filter(above).map(shape),
    roles: (Array.isArray(roles) ? roles : []).map((r) => r.roleid).filter((r) => typeof r === "string").sort(),
    users: (Array.isArray(users) ? users : []).map((u) => u.userid).filter((u) => typeof u === "string").sort(),
    groups: (Array.isArray(groups) ? groups : []).map((x) => x.groupid).filter((x) => typeof x === "string").sort(),
  };
}

/** The role and the person or group must exist, when Proxmox lets this account list them. */
async function verifyPrincipal(pve: ProxmoxClient, spec: { type: string; id: string; role: string }) {
  const roles = await pve.call<{ roleid: string }[]>("GET", "/access/roles").catch(() => null);
  if (Array.isArray(roles) && roles.length && !roles.some((r) => r.roleid === spec.role)) throw new CheckError(`There is no role called ${spec.role}`);
  if (spec.type === "group") {
    const groups = await pve.call<{ groupid: string }[]>("GET", "/access/groups").catch(() => null);
    if (Array.isArray(groups) && groups.length && !groups.some((x) => x.groupid === spec.id)) throw new CheckError(`There is no group called ${spec.id}`);
  }
  if (spec.type === "user") {
    const users = await pve.call<{ userid: string }[]>("GET", "/access/users").catch(() => null);
    if (Array.isArray(users) && users.length && !users.some((u) => u.userid === spec.id)) throw new CheckError(`There is no user called ${spec.id}`);
  }
}
