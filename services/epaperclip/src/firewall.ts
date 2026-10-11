/**
 * Proxmox firewall: validation for rules, options, aliases and IP sets, and the lock-out check.
 *
 * Proxmox keeps its own management ports (8006, SSH, consoles) reachable from the local network when the firewall
 * drops everything else, but not ePaperclip's port. Turning the firewall on with a drop policy would cut people off
 * from this console, so enabling it checks for a rule that lets the console's port in first.
 */

export class FirewallInputError extends Error {}
const bad = (m: string): never => {
  throw new FirewallInputError(m);
};

export type Level = "cluster" | "node" | "guest";

export interface RuleSpec {
  type: "in" | "out" | "group";
  action: string; // ACCEPT | DROP | REJECT, or a security group name for type "group"
  enable: boolean;
  macro: string | null;
  proto: string | null;
  dport: string | null;
  sport: string | null;
  source: string | null;
  dest: string | null;
  iface: string | null;
  log: string | null;
  comment: string | null;
}

const ACTIONS = ["ACCEPT", "DROP", "REJECT"];
const LOG_LEVELS = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug", "nolog"];
const PROTOS = /^(tcp|udp|icmp|icmpv6|ipv6-icmp|sctp|esp|ah|gre|udplite|\d{1,3})$/;
const PORTS = /^[a-z0-9][a-z0-9:,.-]{0,127}$/i; // 22, 80,443, 8000:8100, or service names like ssh
const ADDRS = /^!?[\w.:/+-]{1,128}(,!?[\w.:/+-]{1,128}){0,31}$/; // addresses, CIDRs, ranges, alias names, +ipset
export const NAME = /^[A-Za-z][\w-]{1,63}$/;
export const GROUP = /^[A-Za-z][\w-]{1,17}$/;

const opt = (v: unknown, re: RegExp, msg: string) => (v === undefined || v === null || v === "" ? null : typeof v === "string" && re.test(v.trim()) ? v.trim() : bad(msg));

export function checkRule(b: Record<string, unknown>): RuleSpec {
  const type = b.type === "in" || b.type === "out" || b.type === "group" ? b.type : bad("Pick in, out or a security group");
  const action = type === "group" ? (typeof b.action === "string" && GROUP.test(b.action) ? b.action : bad("Pick a security group")) : ACTIONS.includes(String(b.action)) ? String(b.action) : bad("Pick accept, drop or reject");
  const macro = type === "group" ? null : opt(b.macro, /^[A-Za-z0-9]{1,30}$/, "Unknown service");
  const proto = type === "group" || macro ? null : opt(b.proto, PROTOS, "Unknown protocol");
  const dport = type === "group" || macro ? null : opt(b.dport, PORTS, "Ports look like 22, 80,443 or 8000:8100");
  const sport = type === "group" || macro ? null : opt(b.sport, PORTS, "Ports look like 22, 80,443 or 8000:8100");
  if ((dport || sport) && proto !== "tcp" && proto !== "udp" && proto !== "sctp" && proto !== "udplite") bad("Ports need TCP or UDP");
  const comment = b.comment === undefined || b.comment === null || b.comment === "" ? null : typeof b.comment === "string" && b.comment.length <= 200 && !/[\r\n]/.test(b.comment) ? b.comment : bad("Keep the comment to one line");
  return {
    type,
    action,
    enable: b.enable !== false,
    macro,
    proto,
    dport,
    sport,
    source: type === "group" ? null : opt(b.source, ADDRS, "Sources are addresses, networks, aliases or +ipsets"),
    dest: type === "group" ? null : opt(b.dest, ADDRS, "Destinations are addresses, networks, aliases or +ipsets"),
    iface: opt(b.iface, /^[\w.-]{1,15}$/, "Unknown interface"),
    log: type === "group" ? null : opt(b.log, new RegExp(`^(${LOG_LEVELS.join("|")})$`), "Unknown log level"),
    comment,
  };
}

/** Proxmox parameters for a rule; on an update, cleared fields go in `delete`. */
export function ruleParams(r: RuleSpec, updating: boolean): Record<string, string | number | boolean | undefined> {
  const p: Record<string, string | number | boolean | undefined> = { type: r.type, action: r.action, enable: r.enable ? 1 : 0 };
  const del: string[] = [];
  for (const k of ["macro", "proto", "dport", "sport", "source", "dest", "iface", "log", "comment"] as const) {
    if (r[k]) p[k] = r[k]!;
    else del.push(k);
  }
  if (updating && del.length) p.delete = del.join(",");
  return p;
}

const BOOL_OPTS: Record<Level, string[]> = {
  cluster: ["enable", "ebtables"],
  node: ["enable", "nosmurfs", "tcpflags", "ndp"],
  guest: ["enable", "dhcp", "ndp", "radv", "macfilter", "ipfilter"],
};

/** Firewall options for a level, each checked. Unknown keys are refused rather than passed through. */
export function checkOptions(level: Level, b: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === "keepConsole" || k === "ignoreLockout") continue;
    if (BOOL_OPTS[level].includes(k)) {
      if (typeof v !== "boolean") bad(`${k} must be on or off`);
      out[k] = v ? 1 : 0;
    } else if ((k === "policy_in" || k === "policy_out") && level !== "node") {
      out[k] = ACTIONS.includes(String(v)) ? String(v) : bad("Policies are accept, drop or reject");
    } else if ((k === "log_level_in" || k === "log_level_out") && level !== "cluster") {
      out[k] = LOG_LEVELS.includes(String(v)) ? String(v) : bad("Unknown log level");
    } else bad(`Unknown option ${k}`);
  }
  if (!Object.keys(out).length) bad("Nothing to change");
  return out;
}

export function checkAlias(b: Record<string, unknown>, renaming = false) {
  const name = typeof b.name === "string" && NAME.test(b.name) ? b.name : bad("Names start with a letter: letters, digits, - and _");
  const cidr = typeof b.cidr === "string" && /^[\d.:a-f/]{2,49}$/i.test(b.cidr) ? b.cidr : bad("Use an address or network, like 192.168.1.0/24");
  const comment = b.comment === undefined || b.comment === "" ? undefined : typeof b.comment === "string" && b.comment.length <= 200 && !/[\r\n]/.test(b.comment) ? b.comment : bad("Keep the comment to one line");
  void renaming;
  return { name, cidr, comment };
}

export function checkIpsetEntry(b: Record<string, unknown>) {
  const cidr = typeof b.cidr === "string" && /^[\w.:/-]{2,64}$/.test(b.cidr) ? b.cidr : bad("Use an address, network or alias");
  const comment = b.comment === undefined || b.comment === "" ? undefined : typeof b.comment === "string" && b.comment.length <= 200 && !/[\r\n]/.test(b.comment) ? b.comment : bad("Keep the comment to one line");
  return { cidr, nomatch: b.nomatch === true ? true : undefined, comment };
}

interface ProxmoxRule {
  type?: string;
  action?: string;
  enable?: number;
  proto?: string;
  dport?: string;
  macro?: string;
  source?: string;
}

/** Whether a TCP port number falls inside a Proxmox port spec ("443", "80,443", "400:500"). Service names count for 443 only as "https". */
export function portMatches(spec: string, port: number): boolean {
  return spec.split(",").some((part) => {
    const p = part.trim().toLowerCase();
    if (p === "https" && port === 443) return true;
    const [a, b] = p.split(":").map(Number);
    if (!Number.isInteger(a)) return false;
    return b === undefined || Number.isNaN(b) ? a === port : port >= a && port <= b;
  });
}

/** True when an enabled inbound rule lets TCP traffic reach the console's port, from anywhere or from a named source. */
export function consoleAllowed(rules: ProxmoxRule[], port: number): boolean {
  return rules.some((r) => {
    if (r.enable === 0 || r.type !== "in" || r.action !== "ACCEPT") return false;
    if (r.macro) return port === 443 && r.macro.toUpperCase() === "HTTPS";
    if (r.proto && r.proto !== "tcp") return false;
    return r.dport ? portMatches(r.dport, port) : !r.proto; // no proto and no port: everything
  });
}

/** The rule ePaperclip adds on the host so its console stays reachable. */
export function consoleRule(port: number): Record<string, string | number> {
  return { type: "in", action: "ACCEPT", proto: "tcp", dport: String(port), enable: 1, comment: "ePaperclip console (keeps this page reachable)" };
}
