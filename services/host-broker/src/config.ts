import { readFileSync } from "node:fs";

/**
 * Host broker configuration. The file holds no secrets: the Proxmox token secret comes from PROXMOX_TOKEN_SECRET, and
 * callers are listed by the SHA-256 of their token, so a leaked config file grants nothing.
 *
 * Two kinds of caller:
 *  - system: Pin. Reads the whole host and power-manages guests, except protected ones.
 *  - group: one company's agents. Manage containers only inside their resource group.
 */

export interface OstemplateProfile {
  kind: "ostemplate";
  ostemplate: string;
  storage: string;
  bridge: string;
  cores: number;
  memoryMb: number;
  diskGb: number;
}

export interface TemplateProfile {
  kind: "template";
  template: number; // an LXC template whose root authorized_keys already holds the session key
  fullClone: boolean; // directory storage cannot make linked clones; ZFS and LVM-thin can
  storage?: string;
  cores: number;
  memoryMb: number;
}

export type Profile = OstemplateProfile | TemplateProfile;

export interface ResourceGroup {
  name: string;
  pool: string;
  tag: string;
  vmidRange: [number, number];
  profiles: string[];
  limits: { maxLeases: number; maxCores: number; maxMemoryMb: number; maxTtlMinutes: number; defaultTtlMinutes: number };
}

export type Principal = { name: string; tokenSha256: string } & ({ scope: "system" } | { scope: "group"; group: string });

export interface BrokerConfig {
  listen: { host: string; port: number };
  proxmox: { url: string; node: string; tokenId: string; tokenSecret: string; caPem?: string };
  protectedVmids: number[];
  profiles: Record<string, Profile>;
  groups: Record<string, ResourceGroup>;
  principals: Principal[];
  auditLog: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const TAG = /^[a-z0-9][a-z0-9_+.-]{0,62}$/;

function int(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`${what} must be an integer between ${min} and ${max}`);
  return v;
}

function str(v: unknown, what: string, re: RegExp = /^\S.{0,254}$/): string {
  if (typeof v !== "string" || !re.test(v)) throw new Error(`${what} is missing or invalid`);
  return v;
}

function parseProfile(name: string, p: any): Profile {
  if (!NAME.test(name)) throw new Error(`profile name "${name}" is invalid`);
  const cores = int(p?.cores, `profiles.${name}.cores`, 1, 64);
  const memoryMb = int(p?.memoryMb, `profiles.${name}.memoryMb`, 128, 262_144);
  if (typeof p?.ostemplate === "string") {
    return {
      kind: "ostemplate",
      ostemplate: str(p.ostemplate, `profiles.${name}.ostemplate`, /^[A-Za-z0-9_.-]+:vztmpl\/[A-Za-z0-9_.+-]+$/),
      storage: str(p.storage, `profiles.${name}.storage`, NAME),
      bridge: str(p.bridge, `profiles.${name}.bridge`, /^[A-Za-z0-9_.-]{1,15}$/),
      cores,
      memoryMb,
      diskGb: int(p.diskGb, `profiles.${name}.diskGb`, 1, 4096),
    };
  }
  if (p?.template !== undefined) {
    return {
      kind: "template",
      template: int(p.template, `profiles.${name}.template`, 100, 999_999_999),
      fullClone: p.fullClone !== false,
      storage: p.storage === undefined ? undefined : str(p.storage, `profiles.${name}.storage`, NAME),
      cores,
      memoryMb,
    };
  }
  throw new Error(`profiles.${name} needs either "ostemplate" or "template"`);
}

export function parseBrokerConfig(raw: unknown, env: Record<string, string | undefined>, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): BrokerConfig {
  if (!raw || typeof raw !== "object") throw new Error("config must be a JSON object");
  const c = raw as Record<string, any>;

  const tokenSecret = env.PROXMOX_TOKEN_SECRET?.trim();
  if (!tokenSecret) throw new Error("PROXMOX_TOKEN_SECRET is not set");

  const pm = c.proxmox ?? {};
  const url = str(pm.url, "proxmox.url");
  if (new URL(url).protocol !== "https:") throw new Error("proxmox.url must use https");

  const profiles: Record<string, Profile> = {};
  for (const [name, p] of Object.entries(c.profiles ?? {})) profiles[name] = parseProfile(name, p);
  if (Object.keys(profiles).length === 0) throw new Error("define at least one profile");

  const groups: Record<string, ResourceGroup> = {};
  for (const [name, g] of Object.entries((c.groups ?? {}) as Record<string, any>)) {
    if (!NAME.test(name)) throw new Error(`group name "${name}" is invalid`);
    const [lo, hi] = Array.isArray(g?.vmidRange) ? g.vmidRange : [];
    int(lo, `groups.${name}.vmidRange[0]`, 100, 999_999_999);
    int(hi, `groups.${name}.vmidRange[1]`, lo, 999_999_999);
    if (hi - lo > 10_000) throw new Error(`groups.${name}.vmidRange is wider than 10000 IDs`);
    const allowed = Array.isArray(g?.profiles) ? g.profiles : [];
    for (const p of allowed) if (!Object.hasOwn(profiles, p)) throw new Error(`groups.${name} uses unknown profile "${p}"`);
    if (allowed.length === 0) throw new Error(`groups.${name} must allow at least one profile`);
    const l = g?.limits ?? {};
    const limits = {
      maxLeases: int(l.maxLeases ?? 5, `groups.${name}.limits.maxLeases`, 1, 500),
      maxCores: int(l.maxCores ?? 8, `groups.${name}.limits.maxCores`, 1, 1024),
      maxMemoryMb: int(l.maxMemoryMb ?? 8192, `groups.${name}.limits.maxMemoryMb`, 128, 4_194_304),
      maxTtlMinutes: int(l.maxTtlMinutes ?? 240, `groups.${name}.limits.maxTtlMinutes`, 5, 7 * 24 * 60),
      defaultTtlMinutes: int(l.defaultTtlMinutes ?? 120, `groups.${name}.limits.defaultTtlMinutes`, 5, 7 * 24 * 60),
    };
    if (limits.defaultTtlMinutes > limits.maxTtlMinutes) throw new Error(`groups.${name}: defaultTtlMinutes cannot exceed maxTtlMinutes`);
    groups[name] = { name, pool: str(g.pool, `groups.${name}.pool`, NAME), tag: str(g.tag ?? `lh-${name.toLowerCase()}`, `groups.${name}.tag`, TAG), vmidRange: [lo, hi], profiles: [...allowed], limits };
  }

  // Ranges, pools and tags must not overlap, or one company could reach another's guests.
  const list = Object.values(groups);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.vmidRange[0] <= b.vmidRange[1] && b.vmidRange[0] <= a.vmidRange[1]) throw new Error(`groups ${a.name} and ${b.name} have overlapping vmid ranges`);
      if (a.pool === b.pool) throw new Error(`groups ${a.name} and ${b.name} share pool ${a.pool}`);
      if (a.tag === b.tag) throw new Error(`groups ${a.name} and ${b.name} share tag ${a.tag}`);
    }
  }

  const protectedVmids: number[] = (Array.isArray(c.protectedVmids) ? c.protectedVmids : []).map((v: unknown, i: number) => int(v, `protectedVmids[${i}]`, 100, 999_999_999));
  const inAnyRange = (v: number) => list.some((g) => v >= g.vmidRange[0] && v <= g.vmidRange[1]);
  for (const v of protectedVmids) if (inAnyRange(v)) throw new Error(`protected guest ${v} lies inside a group's vmid range`);
  for (const [name, p] of Object.entries(profiles)) if (p.kind === "template" && inAnyRange(p.template)) throw new Error(`profiles.${name}.template lies inside a group's vmid range, so it could be destroyed`);

  const principals: Principal[] = (Array.isArray(c.principals) ? c.principals : []).map((p: any, i: number) => {
    const name = str(p?.name, `principals[${i}].name`, NAME);
    const tokenSha256 = str(p?.tokenSha256, `principals[${i}].tokenSha256`, /^[0-9a-f]{64}$/);
    if (p?.scope === "system") return { name, tokenSha256, scope: "system" as const };
    if (p?.scope === "group") {
      if (!Object.hasOwn(groups, p.group)) throw new Error(`principals[${i}] names unknown group "${p.group}"`);
      return { name, tokenSha256, scope: "group" as const, group: p.group as string };
    }
    throw new Error(`principals[${i}].scope must be system or group`);
  });
  if (principals.length === 0) throw new Error("define at least one principal");
  if (new Set(principals.map((p) => p.tokenSha256)).size !== principals.length) throw new Error("two principals share a token");

  return {
    listen: { host: typeof c.listen?.host === "string" ? c.listen.host : "127.0.0.1", port: int(c.listen?.port ?? 8787, "listen.port", 1, 65_535) },
    proxmox: {
      url,
      node: str(pm.node, "proxmox.node", NAME),
      tokenId: str(pm.tokenId, "proxmox.tokenId", /^[^@\s]+@[^!\s]+![A-Za-z0-9_.-]+$/),
      tokenSecret,
      caPem: typeof pm.caFile === "string" ? readFile(pm.caFile) : undefined,
    },
    protectedVmids,
    profiles,
    groups,
    principals,
    auditLog: typeof c.auditLog === "string" ? c.auditLog : "audit.jsonl",
  };
}
