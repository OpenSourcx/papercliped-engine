import { ApiError, type FwRule, type SdnState } from "./api.ts";

/**
 * In-browser stand-ins for Proxmox's firewall, DNS, hosts file and SDN, for the demo. They follow the host service's
 * rules closely enough that the screens behave the same, including the console lock-out guard.
 */

type Start = (type: string, id: string | null, seconds: number, log: string[], done?: () => void) => string;

const CONSOLE_PORT = 443;

export function demoNetworkConfig(startTask: Start) {
  const rule = (r: Partial<FwRule>): FwRule => ({ pos: 0, type: "in", action: "ACCEPT", enable: true, macro: null, proto: null, dport: null, sport: null, source: null, dest: null, iface: null, log: null, comment: null, ...r });
  const rules: Record<string, FwRule[]> = {
    datacenter: [rule({ macro: "SSH", source: "+management", comment: "Admins over SSH" }), rule({ macro: "Ping", comment: "Allow ping" })],
    host: [],
    "group-webservers": [rule({ macro: "HTTP" }), rule({ macro: "HTTPS" })],
  };
  const options: Record<string, Record<string, string | number>> = {
    datacenter: { enable: 0, policy_in: "DROP", policy_out: "ACCEPT", ebtables: 1 },
    host: { enable: 1, log_level_in: "nolog", log_level_out: "nolog", nosmurfs: 1, tcpflags: 0 },
  };
  const groups: { group: string; comment: string | null }[] = [{ group: "webservers", comment: "HTTP and HTTPS" }];
  const aliases: Record<string, { name: string; cidr: string; comment: string | null }[]> = { datacenter: [{ name: "lan", cidr: "192.168.1.0/24", comment: "Home network" }] };
  const ipsets: Record<string, Record<string, { cidr: string; nomatch: boolean; comment: string | null }[]>> = { datacenter: { management: [{ cidr: "192.168.1.0/24", nomatch: false, comment: "Admins" }] } };
  const macros = ["SSH", "HTTP", "HTTPS", "Ping", "DNS", "NTP", "SMB", "NFS", "MySQL", "PostgreSQL", "RDP", "VNC", "SMTP", "IMAPS", "Ceph"].map((m) => ({ macro: m, descr: `${m} traffic` }));
  const log = ["0 6 - 11/Oct/2026:09:58:12 +0000 policy DROP: IN=vmbr0 SRC=203.0.113.7 DST=192.168.1.10 PROTO=TCP DPT=23", "0 6 - 11/Oct/2026:10:01:44 +0000 policy DROP: IN=vmbr0 SRC=198.51.100.20 DST=192.168.1.10 PROTO=TCP DPT=3389"];
  const renumber = (scope: string) => rules[scope].forEach((r, i) => (r.pos = i));
  const allowsConsole = (list: FwRule[]) => list.some((r) => r.enable && r.type === "in" && r.action === "ACCEPT" && (r.macro === "HTTPS" || (r.proto === "tcp" && !!r.dport && r.dport.split(",").some((p) => p === String(CONSOLE_PORT) || (p.includes(":") && Number(p.split(":")[0]) <= CONSOLE_PORT && CONSOLE_PORT <= Number(p.split(":")[1]))))));
  const locksOut = (cluster: Record<string, string | number>, host: Record<string, string | number>, list: FwRule[]) => Number(cluster.enable) === 1 && Number(host.enable ?? 1) === 1 && String(cluster.policy_in ?? "DROP") !== "ACCEPT" && !allowsConsole(list);
  const guard = (body: Record<string, unknown>, cluster: Record<string, string | number>, host: Record<string, string | number>, list: FwRule[]) => {
    if (body.ignoreLockout === true || !locksOut(cluster, host, list)) return;
    if (body.keepConsole === true) {
      rules.host.unshift(rule({ proto: "tcp", dport: String(CONSOLE_PORT), comment: "ePaperclip console (keeps this page reachable)" }));
      renumber("host");
      return;
    }
    throw new ApiError(409, "lockout", `This would block port ${CONSOLE_PORT}, which this console runs on. Let ePaperclip add a rule that keeps it reachable, or continue anyway.`);
  };
  const guestKey = (scope: string) => {
    if (scope.startsWith("guest-") && !rules[scope]) {
      rules[scope] = [rule({ macro: "SSH", comment: "SSH from anywhere" })];
      options[scope] = { enable: 0, policy_in: "DROP", policy_out: "ACCEPT", dhcp: 1, macfilter: 1, ipfilter: 0, log_level_in: "nolog", log_level_out: "nolog" };
      aliases[scope] = [];
      ipsets[scope] = {};
    }
    return scope;
  };

  let dns = { search: "lan", servers: ["192.168.1.1", "1.1.1.1"] };
  let hosts = "127.0.0.1 localhost.localdomain localhost\n192.168.1.10 pve.lan pve\n\n# The following lines are desirable for IPv6 capable hosts\n::1     ip6-localhost ip6-loopback\n";
  let hostsVersion = 1;
  const digest = () => hostsVersion.toString(16).padStart(40, "0");

  let sdn: SdnState = { zones: [], vnets: [], pending: 0 };
  let staged: SdnState | null = null;
  const sdnView = (): SdnState => {
    const cur = staged ?? sdn;
    const state = (kind: "zone" | "vnet", id: string) => (sdn[kind === "zone" ? "zones" : "vnets"].some((x) => (kind === "zone" ? (x as { zone: string }).zone : (x as { vnet: string }).vnet) === id) ? null : "new");
    const view: SdnState = {
      zones: cur.zones.map((z) => ({ ...z, state: staged ? state("zone", z.zone) : null })),
      vnets: cur.vnets.map((v) => ({ ...v, state: staged ? state("vnet", v.vnet) : null, subnets: v.subnets.map((s) => ({ ...s, state: staged && !sdn.vnets.find((x) => x.vnet === v.vnet)?.subnets.some((y) => y.id === s.id) ? "new" : null })) })),
      pending: 0,
    };
    view.pending = [...view.zones, ...view.vnets, ...view.vnets.flatMap((v) => v.subnets)].filter((x) => x.state).length + (staged ? sdn.zones.filter((z) => !cur.zones.some((x) => x.zone === z.zone)).length + sdn.vnets.filter((v) => !cur.vnets.some((x) => x.vnet === v.vnet)).length : 0);
    return structuredClone(view);
  };
  const stage = () => (staged ??= structuredClone(sdn));

  return {
    firewallGet: async <T,>(scope: string, res: string, sub?: string): Promise<T> => {
      const sc = guestKey(scope);
      if (res === "options") return { options: { ...(options[sc] ?? {}) } } as T;
      if (res === "rules") {
        if (!rules[sc]) throw new ApiError(404, "not_found", "Unknown firewall");
        return { rules: structuredClone(rules[sc]), consolePort: CONSOLE_PORT } as T;
      }
      if (res === "groups") return { groups: structuredClone(groups) } as T;
      if (res === "macros") return { macros } as T;
      if (res === "aliases") return { aliases: structuredClone(aliases[sc] ?? []) } as T;
      if (res === "ipsets" && sub) return { entries: structuredClone(ipsets[sc]?.[sub] ?? []) } as T;
      if (res === "ipsets") return { ipsets: Object.keys(ipsets[sc] ?? {}).map((name) => ({ name, comment: null })) } as T;
      if (res === "log") return { lines: [...log] } as T;
      if (res === "refs") return { refs: [...(aliases[sc] ?? []).map((a) => ({ type: "alias", name: a.name, ref: a.name, comment: a.comment })), ...Object.keys(ipsets[sc] ?? {}).map((n) => ({ type: "ipset", name: n, ref: `+${n}`, comment: null }))] } as T;
      throw new ApiError(404, "not_found", "Not found");
    },
    firewallPost: async (scope: string, path: string, body: unknown = {}) => {
      const sc = guestKey(scope);
      const b = (body ?? {}) as Record<string, unknown>;
      const [res, a, b2, c, d] = path.split("/").map(decodeURIComponent);
      if (res === "options") {
        const next: Record<string, string | number> = {};
        for (const [k, v] of Object.entries(b)) if (k !== "keepConsole" && k !== "ignoreLockout") next[k] = typeof v === "boolean" ? (v ? 1 : 0) : (v as string);
        if (sc === "datacenter" || sc === "host") guard(b, { ...options.datacenter, ...(sc === "datacenter" ? next : {}) }, { ...options.host, ...(sc === "host" ? next : {}) }, [...rules.datacenter, ...rules.host]);
        options[sc] = { ...options[sc], ...next };
        return { ok: true as const };
      }
      if (res === "rules") {
        const list = rules[sc] ?? (rules[sc] = []);
        if (!a) {
          const r = rule(b as Partial<FwRule>);
          if ((r.dport || r.sport) && r.proto !== "tcp" && r.proto !== "udp") throw new ApiError(400, "bad_request", "Ports need TCP or UDP");
          list.splice(Number.isInteger(b.pos) ? (b.pos as number) : 0, 0, r);
          renumber(sc);
          return { ok: true as const };
        }
        const pos = Number(a);
        const without = list.filter((r) => r.pos !== pos);
        if (b2 === "delete") {
          if (sc === "datacenter" || sc === "host") guard(b, options.datacenter, options.host, sc === "datacenter" ? [...without, ...rules.host] : [...rules.datacenter, ...without]);
          rules[sc] = without;
          renumber(sc);
          return { ok: true as const };
        }
        if (typeof b.enable === "boolean" && Object.keys(b).every((k) => ["enable", "ignoreLockout", "keepConsole"].includes(k))) {
          if (!b.enable && (sc === "datacenter" || sc === "host")) guard(b, options.datacenter, options.host, sc === "datacenter" ? [...without, ...rules.host] : [...rules.datacenter, ...without]);
          const r = list.find((x) => x.pos === pos);
          if (r) r.enable = b.enable;
          return { ok: true as const };
        }
        if (Number.isInteger(b.moveto)) {
          const [r] = list.splice(pos, 1);
          list.splice(Math.min(b.moveto as number, list.length), 0, r);
          renumber(sc);
          return { ok: true as const };
        }
        rules[sc] = list.map((x) => (x.pos === pos ? rule({ ...(b as Partial<FwRule>), pos }) : x));
        return { ok: true as const };
      }
      if (res === "groups") {
        if (!a) {
          if (groups.some((g) => g.group === b.group)) throw new ApiError(400, "proxmox_rejected", "group already exists");
          groups.push({ group: String(b.group), comment: (b.comment as string) || null });
          rules[`group-${b.group}`] = [];
        } else {
          groups.splice(groups.findIndex((g) => g.group === a), 1);
          delete rules[`group-${a}`];
        }
        return { ok: true as const };
      }
      if (res === "aliases") {
        const list = aliases[sc] ?? (aliases[sc] = []);
        if (!a) {
          if (list.some((x) => x.name === b.name)) throw new ApiError(400, "proxmox_rejected", `alias '${b.name}' already exists`);
          list.push({ name: String(b.name), cidr: String(b.cidr), comment: (b.comment as string) || null });
        } else if (b2 === "delete") aliases[sc] = list.filter((x) => x.name !== a);
        else aliases[sc] = list.map((x) => (x.name === a ? { name: String(b.name ?? a), cidr: String(b.cidr), comment: (b.comment as string) || null } : x));
        return { ok: true as const };
      }
      if (res === "ipsets") {
        const sets = ipsets[sc] ?? (ipsets[sc] = {});
        if (!a) sets[String(b.name)] = [];
        else if (b2 === "delete") delete sets[a];
        else if (b2 === "entries" && !c) (sets[a] ??= []).push({ cidr: String(b.cidr), nomatch: b.nomatch === true, comment: (b.comment as string) || null });
        else if (b2 === "entries" && c && d === "delete") sets[a] = (sets[a] ?? []).filter((x) => x.cidr !== c);
        return { ok: true as const };
      }
      throw new ApiError(404, "not_found", "Not found");
    },
    dns: async () => ({ ...dns, servers: [...dns.servers] }),
    setDns: async (search: string, servers: string[]) => {
      dns = { search, servers };
      return { ok: true as const };
    },
    hosts: async () => ({ data: hosts, digest: digest() }),
    setHosts: async (data: string, d: string | null) => {
      if (d && d !== digest()) throw new ApiError(400, "proxmox_rejected", "detected modified configuration - file changed by other user? Try again.");
      hosts = data;
      hostsVersion++;
      return { ok: true as const };
    },
    sdn: async () => sdnView(),
    sdnPost: async (path: string, body: unknown = {}) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const [kind, id, action, subId] = path.split("/").map(decodeURIComponent);
      if (kind === "apply") {
        const next = staged;
        return { task: startTask("reloadnetworkall", null, 1.5, ["reloading SDN configuration", "ifreload -a"], () => {
          if (next) sdn = next;
          staged = null;
        }) };
      }
      const s = stage();
      if (kind === "zones" && !id) {
        if (s.zones.some((z) => z.zone === b.zone)) throw new ApiError(400, "proxmox_rejected", `zone '${b.zone}' already exists`);
        s.zones.push({ zone: String(b.zone), type: String(b.type), bridge: (b.bridge as string) ?? null, dhcp: b.dhcp ? "dnsmasq" : null, state: null });
      } else if (kind === "vnets" && !id) {
        if (s.vnets.some((v) => v.vnet === b.vnet)) throw new ApiError(400, "proxmox_rejected", `vnet '${b.vnet}' already exists`);
        if (!s.zones.some((z) => z.zone === b.zone)) throw new ApiError(400, "proxmox_rejected", `zone '${b.zone}' does not exist`);
        s.vnets.push({ vnet: String(b.vnet), zone: String(b.zone), tag: (b.tag as number) ?? null, alias: (b.alias as string) ?? null, state: null, subnets: [] });
      } else if (id && action === "delete") {
        if (kind === "zones") {
          if (s.vnets.some((v) => v.zone === id)) throw new ApiError(400, "proxmox_rejected", `zone '${id}' is used by a vnet`);
          s.zones = s.zones.filter((z) => z.zone !== id);
        } else s.vnets = s.vnets.filter((v) => v.vnet !== id);
      } else if (kind === "vnets" && id && action === "subnets" && !subId) {
        const v = s.vnets.find((x) => x.vnet === id);
        if (!v) throw new ApiError(404, "not_found", "Unknown VNet");
        v.subnets.push({ id: `${v.zone}-${String(b.cidr).replace("/", "-")}`, cidr: String(b.cidr), gateway: (b.gateway as string) || null, snat: b.snat === true, dhcpRange: b.dhcpStart ? [`start-address=${b.dhcpStart},end-address=${b.dhcpEnd}`] : [], state: null });
      } else if (kind === "vnets" && id && subId) {
        const v = s.vnets.find((x) => x.vnet === id);
        if (v) v.subnets = v.subnets.filter((x) => x.id !== subId);
      }
      return { ok: true as const };
    },
  };
}
