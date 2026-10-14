import { randomBytes } from "node:crypto";
import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import { DEVICE_ROLES, ORG_POOL_ROLES, USERID, deviceRoleOf, validateSpec, type DeviceRole, type OrgRole, type UserRow } from "../iac.ts";
import { listIngress, setIngress } from "../routine-ingress.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * Access control, people tools: a preview of what a change will do in Proxmox before it is applied, organization-role
 * templates, CSV import (a preview, then Proxmox users and engine accounts made together), mapping Proxmox groups to
 * organization roles, and which organizations accept routine webhooks from outside. Changes go through the same Iac
 * methods as the Users tab, so the same permission checks apply.
 */

const bad = (m: string): never => {
  throw new HttpError(400, "bad_request", m);
};
const GROUPID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMPANY = /^[A-Za-z0-9_-]{1,64}$/;
export const ORG_RANK: Record<OrgRole, number> = { viewer: 1, operator: 2, admin: 3, owner: 4 };
const ORG_ROLE_NAMES = Object.keys(ORG_RANK) as OrgRole[];
const DEVICE_ROLE_NAMES: DeviceRole[] = ["admin", "operator", "viewer", "none"];

export interface Helpers {
  run: <T>(fn: (pve: ProxmoxClient) => Promise<T>) => Promise<T>;
  audit: (action: string, target?: string, detail?: string) => void;
  adminOnly: (what: string) => Promise<void>;
  ticketOnly: (what: string) => void;
}

interface Acl {
  path: string;
  ugid: string;
  type: string;
  roleid: string;
}
interface Overview {
  users: UserRow[];
  orgs: { companyId: string; name: string; pool: string | null }[];
  groups: { groupid: string; comment?: string }[];
  realms: { realm: string; type: string }[];
  canManageUsers: boolean;
}

const MANAGED_DEVICE = new Set(Object.values(DEVICE_ROLES).flat().map((a) => `${a.path} ${a.role}`));
const MANAGED_POOL = new Set(Object.values(ORG_POOL_ROLES).flat());

// ---------------------------------------------------------------- the plan of a change

export type Change =
  | { kind: "acl"; op: "add" | "remove"; path: string; role: string; privileges: string[]; reason: string }
  | { kind: "engine"; op: "add" | "change" | "remove"; companyId: string; org: string; from: string | null; to: string | null; text: string }
  | { kind: "effect"; text: string };

export interface UserWish {
  deviceRole?: DeviceRole;
  /** Organization roles. With mode "replace" the organizations not listed lose access (what the user dialog does). */
  orgs?: { companyId: string; role: OrgRole | null }[];
  orgsMode?: "replace" | "merge";
}

/** What setting someone's device role will do to their Proxmox permissions. */
export function planDevice(userid: string, role: DeviceRole, acls: Acl[]): { add: { path: string; role: string }[]; remove: { path: string; role: string }[] } {
  const mine = acls.filter((a) => a.type === "user" && a.ugid === userid && !a.path.startsWith("/pool/") && MANAGED_DEVICE.has(`${a.path} ${a.roleid}`));
  const want = new Set(DEVICE_ROLES[role].map((a) => `${a.path} ${a.role}`));
  const have = new Set(mine.map((a) => `${a.path} ${a.roleid}`));
  return {
    remove: mine.filter((a) => !want.has(`${a.path} ${a.roleid}`)).map((a) => ({ path: a.path, role: a.roleid })),
    add: DEVICE_ROLES[role].filter((a) => !have.has(`${a.path} ${a.role}`)).map((a) => ({ path: a.path, role: a.role })),
  };
}

/** What an organization role will do to someone's permissions on the organization's resource group. */
export function planPool(userid: string, pool: string, role: OrgRole | null, acls: Acl[]): { add: string[]; remove: string[] } {
  const path = `/pool/${pool}`;
  const have = acls.filter((a) => a.type === "user" && a.ugid === userid && a.path === path && MANAGED_POOL.has(a.roleid)).map((a) => a.roleid);
  const want = role ? ORG_POOL_ROLES[role] : [];
  return { remove: have.filter((r) => !want.includes(r)), add: want.filter((r) => !have.includes(r)) };
}

export function planUser(o: Overview, acls: Acl[], privs: Map<string, string[]>, userid: string, wish: UserWish, creating = false): { changes: Change[]; warnings: string[] } {
  const changes: Change[] = [];
  const warnings: string[] = [];
  const row = o.users.find((u) => u.userid === userid);
  const privsOf = (r: string) => privs.get(r) ?? [];
  if (wish.deviceRole !== undefined) {
    const before = creating ? "none" : (row?.deviceRole ?? deviceRoleOf(userid, acls));
    const p = planDevice(userid, wish.deviceRole, creating ? [] : acls);
    for (const a of p.remove) changes.push({ kind: "acl", op: "remove", path: a.path, role: a.role, privileges: privsOf(a.role), reason: `Device role ${before === "custom" ? "changes" : `${before} → ${wish.deviceRole}`}` });
    for (const a of p.add) changes.push({ kind: "acl", op: "add", path: a.path, role: a.role, privileges: privsOf(a.role), reason: `Device role: ${wish.deviceRole}` });
    if (before === "custom" && !p.remove.length && !p.add.length && wish.deviceRole !== "none") warnings.push("Their permissions in Proxmox don't match a standard role; the ones set by hand stay as they are.");
    if (wish.deviceRole === "admin" && before !== "admin") changes.push({ kind: "effect", text: "Becomes an administrator of the engine too (can create organizations and manage people)." });
    if (before === "admin" && wish.deviceRole !== "admin") changes.push({ kind: "effect", text: "Stops being an administrator of the engine." });
    if (wish.deviceRole === "none" && !creating) changes.push({ kind: "effect", text: "Their open ePaperclip sessions end." });
  }
  if (wish.orgs !== undefined) {
    const current = new Map((row?.orgs ?? []).map((x) => [x.companyId, x.role]));
    const wanted = new Map(wish.orgs.map((x) => [x.companyId, x.role]));
    const targets = new Set<string>([...wanted.keys(), ...(wish.orgsMode === "merge" ? [] : current.keys())]);
    for (const companyId of targets) {
      const org = o.orgs.find((x) => x.companyId === companyId);
      const name = org?.name ?? companyId;
      const to = wanted.has(companyId) ? wanted.get(companyId)! : null;
      const from = (current.get(companyId) as OrgRole | undefined) ?? null;
      if (to === from) continue;
      changes.push({ kind: "engine", op: from === null ? "add" : to === null ? "remove" : "change", companyId, org: name, from, to, text: to === null ? `Removed from ${name}` : from === null ? `Joins ${name} as ${to}` : `${name}: ${from} → ${to}` });
      if (org?.pool) {
        const p = planPool(userid, org.pool, to, creating ? [] : acls);
        for (const r of p.remove) changes.push({ kind: "acl", op: "remove", path: `/pool/${org.pool}`, role: r, privileges: privsOf(r), reason: `${name}: resource group access` });
        for (const r of p.add) changes.push({ kind: "acl", op: "add", path: `/pool/${org.pool}`, role: r, privileges: privsOf(r), reason: `${name}: resource group access` });
      } else if (to !== null) warnings.push(`${name} has no resource group yet, so only the engine membership changes.`);
      if (to === null) changes.push({ kind: "effect", text: `Their open ePaperclip sessions end (removed from ${name}).` });
    }
  }
  return { changes, warnings };
}

// ---------------------------------------------------------------- templates

export interface Template {
  id: string;
  name: string;
  description?: string;
  deviceRole?: DeviceRole;
  groups: string[];
  /** companyId "*" stands for every organization. */
  orgs: { companyId: string; role: OrgRole }[];
}
const TEMPLATES = "orgRoleTemplates";
const templates = (ctx: FeatureCtx) => ctx.state.getSetting<Record<string, Template>>(TEMPLATES) ?? {};

export function validateTemplate(b: Record<string, unknown>, id: string): Template {
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f;]/.test(name)) bad("Give the template a name of up to 64 characters (no semicolons)");
  if (b.description !== undefined && (typeof b.description !== "string" || b.description.length > 256 || /[\r\n\0]/.test(b.description))) bad("Keep the description to one line");
  if (b.deviceRole !== undefined && b.deviceRole !== null && !DEVICE_ROLE_NAMES.includes(b.deviceRole as DeviceRole)) bad("deviceRole is admin, operator, viewer or none");
  if (b.groups !== undefined && (!Array.isArray(b.groups) || b.groups.length > 32 || !b.groups.every((g) => typeof g === "string" && GROUPID.test(g)))) bad("Invalid groups");
  if (b.orgs !== undefined && (!Array.isArray(b.orgs) || b.orgs.length > 100)) bad("Invalid organizations");
  const orgs = ((b.orgs as { companyId?: unknown; role?: unknown }[] | undefined) ?? []).map((o) => {
    if (typeof o.companyId !== "string" || !(o.companyId === "*" || COMPANY.test(o.companyId)) || !ORG_ROLE_NAMES.includes(o.role as OrgRole)) return bad("Each organization needs an id (or * for all) and a role: owner, admin, operator or viewer");
    return { companyId: o.companyId, role: o.role as OrgRole };
  });
  if (new Set(orgs.map((o) => o.companyId)).size !== orgs.length) bad("List each organization once");
  const groups = (b.groups as string[] | undefined) ?? [];
  const deviceRole = (b.deviceRole as DeviceRole | null | undefined) ?? undefined;
  if (!deviceRole && !groups.length && !orgs.length) bad("A template needs at least a device role, a group or an organization role");
  return { id, name, ...(typeof b.description === "string" && b.description.trim() ? { description: b.description.trim() } : {}), ...(deviceRole ? { deviceRole } : {}), groups, orgs };
}

/** A template as a wish for one person: organization roles merged in, `*` expanded to every organization. */
export function templateWish(t: Template, o: Overview, current: UserRow | undefined): { wish: UserWish; groups: string[] } {
  const roles = new Map<string, OrgRole>();
  for (const x of t.orgs) if (x.companyId === "*") for (const org of o.orgs) roles.set(org.companyId, x.role);
  for (const x of t.orgs) if (x.companyId !== "*" && o.orgs.some((org) => org.companyId === x.companyId)) roles.set(x.companyId, x.role);
  return {
    wish: { ...(t.deviceRole ? { deviceRole: t.deviceRole } : {}), ...(roles.size ? { orgs: [...roles].map(([companyId, role]) => ({ companyId, role })), orgsMode: "merge" as const } : {}) },
    groups: [...new Set([...(current?.groups ?? []), ...t.groups])],
  };
}

// ---------------------------------------------------------------- CSV import

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"') (t[i + 1] === '"' ? ((cur += '"'), i++) : (quoted = false));
      else cur += c;
    } else if (c === '"' && cur === "") quoted = true;
    else if (c === ",") (row.push(cur), (cur = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cur += c;
  }
  if (quoted) bad("The CSV has an opening quote that never closes");
  row.push(cur);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

const COLUMN: Record<string, string> = {
  userid: "userid", user: "userid", username: "userid", "user id": "userid", name: "userid",
  realm: "realm", password: "password",
  firstname: "firstname", first: "firstname", "first name": "firstname",
  lastname: "lastname", last: "lastname", "last name": "lastname",
  email: "email", comment: "comment", groups: "groups", group: "groups",
  enable: "enable", enabled: "enable", expire: "expire", expires: "expire", expiry: "expire",
  devicerole: "deviceRole", "device role": "deviceRole", device_role: "deviceRole", role: "deviceRole",
  orgs: "orgs", organizations: "orgs", organisation: "orgs", organization: "orgs", template: "template",
};

export interface ImportRow {
  line: number;
  userid: string;
  action: "create" | "update" | "skip" | "error";
  errors: string[];
  warnings: string[];
  summary: { name: string; email: string | null; groups: string[]; deviceRole: DeviceRole | null; orgs: { companyId: string; org: string; role: OrgRole }[]; template: string | null; realmType: string | null; passwordKept: boolean };
  /** Not sent to the browser. */
  spec?: Record<string, unknown>;
  changes?: Change[];
}

export interface ImportOptions {
  existing: "skip" | "update";
  createGroups: boolean;
  defaultRealm: string;
  template: string | null;
  generatePasswords: boolean;
}

export function importOptions(b: Record<string, unknown>): ImportOptions {
  if (b.existing !== undefined && b.existing !== "skip" && b.existing !== "update") bad("existing is skip or update");
  for (const k of ["createGroups", "generatePasswords"]) if (b[k] !== undefined && typeof b[k] !== "boolean") bad(`${k} must be true or false`);
  const realm = b.defaultRealm === undefined ? "pve" : b.defaultRealm;
  if (typeof realm !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(realm)) bad("The default realm isn't valid");
  if (b.template !== undefined && b.template !== null && (typeof b.template !== "string" || b.template.length > 64)) bad("Pick a template by name");
  return { existing: (b.existing as "skip" | "update" | undefined) ?? "skip", createGroups: b.createGroups === true, defaultRealm: realm as string, template: (b.template as string | null | undefined) || null, generatePasswords: b.generatePasswords === true };
}

const truthy = (v: string) => /^(1|true|yes|y|on|enabled?)$/i.test(v.trim());
const falsy = (v: string) => /^(0|false|no|n|off|disabled?)$/i.test(v.trim());

export function planImport(csv: string, o: Overview, acls: Acl[], privs: Map<string, string[]>, tpls: Template[], opt: ImportOptions): { rows: ImportRow[]; problems: string[]; newGroups: string[] } {
  if (csv.length > 256 * 1024) bad("That file is too large; import up to 500 people at a time");
  const grid = parseCsv(csv);
  if (grid.length < 2) bad("The file needs a header row and at least one person");
  const header = grid[0].map((h) => COLUMN[h.trim().toLowerCase()] ?? null);
  const problems: string[] = [];
  grid[0].forEach((h, i) => {
    if (!header[i]) problems.push(`Column "${h.trim()}" isn't recognised and is ignored`);
  });
  if (!header.includes("userid")) bad("The file needs a column named userid (or username)");
  if (grid.length - 1 > 500) bad("Import up to 500 people at a time");
  const known = new Set(o.users.map((u) => u.userid));
  const groupSet = new Set(o.groups.map((g) => g.groupid));
  const newGroups = new Set<string>();
  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells: Record<string, string> = {};
    header.forEach((h, i) => {
      if (h) cells[h] = (grid[r][i] ?? "").trim();
    });
    const errors: string[] = [];
    const warnings: string[] = [];
    let userid = (cells.userid ?? "").toLowerCase();
    if (userid && !userid.includes("@")) userid = `${userid}@${(cells.realm || opt.defaultRealm).toLowerCase()}`;
    const raw: Record<string, unknown> = {};
    if (cells.password) raw.password = cells.password;
    for (const k of ["firstname", "lastname", "email", "comment"]) if (cells[k]) raw[k] = cells[k];
    const tpl = cells.template || opt.template ? tpls.find((t) => t.name.toLowerCase() === (cells.template || opt.template)!.toLowerCase()) : undefined;
    if ((cells.template || opt.template) && !tpl) errors.push(`There's no template named "${cells.template || opt.template}"`);
    let groups = cells.groups ? cells.groups.split(/[;|]/).map((g) => g.trim()).filter(Boolean) : [];
    if (tpl) groups = [...new Set([...groups, ...tpl.groups])];
    for (const g of groups) if (!groupSet.has(g)) (opt.createGroups && GROUPID.test(g) ? newGroups.add(g) : errors.push(`The group ${g} doesn't exist`));
    if (groups.length) raw.groups = groups;
    if (cells.enable) truthy(cells.enable) ? (raw.enable = true) : falsy(cells.enable) ? (raw.enable = false) : errors.push("enable is yes or no");
    if (cells.expire) {
      const t = /^\d{4}-\d{2}-\d{2}$/.test(cells.expire) ? Date.parse(`${cells.expire}T23:59:59Z`) : NaN;
      Number.isNaN(t) ? errors.push("expire is a date like 2027-06-30") : (raw.expire = Math.floor(t / 1000));
    }
    let deviceRole: DeviceRole | null = null;
    const dr = (cells.deviceRole ?? "").toLowerCase();
    if (dr) DEVICE_ROLE_NAMES.includes(dr as DeviceRole) ? (deviceRole = dr as DeviceRole) : errors.push("Device role is admin, operator, viewer or none");
    else if (tpl?.deviceRole) deviceRole = tpl.deviceRole;
    if (deviceRole) raw.deviceRole = deviceRole;
    const orgRoles = new Map<string, OrgRole>();
    if (tpl) for (const x of templateWish(tpl, o, undefined).wish.orgs ?? []) if (x.role) orgRoles.set(x.companyId, x.role);
    for (const part of (cells.orgs ?? "").split(";").map((x) => x.trim()).filter(Boolean)) {
      const at = part.lastIndexOf(":");
      const label = (at > 0 ? part.slice(0, at) : part).trim();
      const role = (at > 0 ? part.slice(at + 1) : "viewer").trim().toLowerCase();
      const org = o.orgs.find((x) => x.companyId === label || x.name.toLowerCase() === label.toLowerCase());
      if (!org) errors.push(`There's no organization named "${label}"`);
      else if (!ORG_ROLE_NAMES.includes(role as OrgRole)) errors.push(`${org.name}: the role is owner, admin, operator or viewer`);
      else orgRoles.set(org.companyId, role as OrgRole);
    }
    if (orgRoles.size) raw.orgs = [...orgRoles].map(([companyId, role]) => ({ companyId, role }));

    let spec: Record<string, unknown> | undefined;
    if (!userid) errors.push("The user name is missing");
    else if (!USERID.test(userid)) errors.push("A user name looks like name@realm");
    else {
      if (seen.has(userid)) errors.push("This person appears twice in the file");
      seen.add(userid);
      try {
        spec = { ...validateSpec({ ...raw, userid }, true) } as Record<string, unknown>;
      } catch (e) {
        errors.push(e instanceof HttpError ? e.message : "Invalid row");
      }
    }
    const realm = userid.slice(userid.lastIndexOf("@") + 1);
    const realmType = o.realms.find((x) => x.realm === realm)?.type ?? null;
    if (userid && !realmType) errors.push(`There's no realm named ${realm}`);
    if (cells.password && realmType && realmType !== "pve") warnings.push(`The ${realmType} realm manages passwords itself, so the password is not sent.`);
    if (realmType === "pam") warnings.push("A PAM user: the operating system account must exist on the host.");
    if (!cells.password && realmType === "pve" && !opt.generatePasswords) warnings.push("No password: they can't sign in until you set one.");
    const exists = known.has(userid);
    let action: ImportRow["action"] = errors.length ? "error" : exists ? (opt.existing === "update" ? "update" : "skip") : "create";
    if (exists && opt.existing === "skip" && !errors.length) warnings.push("Already exists; left unchanged.");
    let changes: Change[] | undefined;
    if (action === "create" || action === "update") {
      changes = planUser(o, acls, privs, userid, { ...(deviceRole ? { deviceRole } : {}), ...(orgRoles.size ? { orgs: [...orgRoles].map(([companyId, role]) => ({ companyId, role })), orgsMode: "merge" as const } : {}) }, action === "create").changes;
    }
    if (action === "error" && !errors.length) action = "skip";
    rows.push({
      line: r + 1,
      userid,
      action,
      errors,
      warnings,
      summary: {
        name: [cells.firstname, cells.lastname].filter(Boolean).join(" "),
        email: cells.email || null,
        groups,
        deviceRole,
        orgs: [...orgRoles].map(([companyId, role]) => ({ companyId, org: o.orgs.find((x) => x.companyId === companyId)?.name ?? companyId, role })),
        template: tpl?.name ?? null,
        realmType,
        passwordKept: Boolean(cells.password) && (realmType === "pve" || realmType === null),
      },
      spec,
      changes,
    });
  }
  return { rows, problems, newGroups: [...newGroups] };
}

const publicRow = ({ spec: _s, ...rest }: ImportRow) => rest;
const generated = () => randomBytes(12).toString("base64url");

// ---------------------------------------------------------------- group to organization mapping

export interface GroupMapping {
  id: string;
  group: string;
  companyId: string;
  role: OrgRole;
}
interface MapState {
  mappings: GroupMapping[];
  /** What mapping granted, by "userid|companyId": revoked again when the group no longer gives it. */
  granted: Record<string, OrgRole>;
}
const GROUP_MAP = "groupOrgMap";
const mapState = (ctx: FeatureCtx): MapState => ctx.state.getSetting<MapState>(GROUP_MAP) ?? { mappings: [], granted: {} };

export interface MapOp {
  op: "grant" | "raise" | "revoke";
  userid: string;
  companyId: string;
  org: string;
  from: string | null;
  to: OrgRole | null;
  because: string;
}

/** What syncing the mappings would do: grant or raise a role for members of a mapped group, and take back what mapping gave once the group no longer does. */
export function planGroupMap(st: MapState, users: UserRow[], orgs: { companyId: string; name: string }[]): MapOp[] {
  const ops: MapOp[] = [];
  const orgName = (id: string) => orgs.find((o) => o.companyId === id)?.name ?? id;
  const keys = new Set<string>(Object.keys(st.granted));
  for (const u of users) for (const m of st.mappings) if (u.groups.includes(m.group)) keys.add(`${u.userid}|${m.companyId}`);
  for (const key of keys) {
    const [userid, companyId] = [key.slice(0, key.lastIndexOf("|")), key.slice(key.lastIndexOf("|") + 1)];
    const u = users.find((x) => x.userid === userid);
    if (!u || !orgs.some((o) => o.companyId === companyId)) continue;
    const via = st.mappings.filter((m) => m.companyId === companyId && u.groups.includes(m.group));
    const wanted = via.reduce<OrgRole | null>((best, m) => (best === null || ORG_RANK[m.role] > ORG_RANK[best] ? m.role : best), null);
    const current = (u.orgs.find((x) => x.companyId === companyId)?.role as OrgRole | undefined) ?? null;
    if (wanted) {
      const because = `member of ${via.map((m) => m.group).join(", ")}`;
      if (!current) ops.push({ op: "grant", userid, companyId, org: orgName(companyId), from: null, to: wanted, because });
      else if (ORG_RANK[current] < ORG_RANK[wanted]) ops.push({ op: "raise", userid, companyId, org: orgName(companyId), from: current, to: wanted, because });
    } else if (st.granted[key] && current === st.granted[key]) {
      ops.push({ op: "revoke", userid, companyId, org: orgName(companyId), from: current, to: null, because: "no longer in a mapped group" });
    }
  }
  return ops.sort((a, b) => a.userid.localeCompare(b.userid) || a.org.localeCompare(b.org));
}

// ---------------------------------------------------------------- handler

export async function handlePeople(ctx: FeatureCtx, h: Helpers): Promise<boolean> {
  const { method, path } = ctx;
  const read = method === "GET";
  const needAdmin = async (what: string) => {
    await h.adminOnly(what);
  };
  const aclsAndRoles = async (pve: ProxmoxClient) => {
    const [acls, roles] = await Promise.all([pve.call<Acl[]>("GET", "/access/acl").then((x) => x ?? []), pve.call<{ roleid: string; privs?: string }[]>("GET", "/access/roles").then((x) => x ?? [])]);
    return { acls, privs: new Map(roles.map((r) => [r.roleid, (r.privs ?? "").split(",").map((p) => p.trim()).filter(Boolean)])) };
  };
  const overview = async (pve: ProxmoxClient): Promise<Overview & { raw: Awaited<ReturnType<typeof ctx.iac.overview>> }> => {
    const s = ctx.session();
    const raw = await ctx.iac.overview(pve, s, await ctx.isNodeAdmin(pve));
    return { users: raw.users, orgs: raw.orgs, groups: raw.groups, realms: raw.realms, canManageUsers: raw.canManageUsers, raw };
  };

  // ---------------------------------------------------------------- change preview
  if (path === "/api/access/preview" && method === "POST") {
    const b = await ctx.readJson(32 * 1024);
    const userid = typeof b.userid === "string" && USERID.test(b.userid) ? b.userid : bad("Pick a user");
    const spec = validateSpec({ deviceRole: b.deviceRole, orgs: undefined }, false);
    let orgs: UserWish["orgs"];
    if (b.orgs !== undefined) {
      if (!Array.isArray(b.orgs) || b.orgs.length > 100) bad("Invalid organizations");
      orgs = (b.orgs as { companyId?: unknown; role?: unknown }[]).map((x) => {
        if (typeof x.companyId !== "string" || !COMPANY.test(x.companyId) || (x.role !== null && x.role !== "" && !ORG_ROLE_NAMES.includes(x.role as OrgRole))) return bad("Each organization needs a companyId and a role");
        return { companyId: x.companyId, role: (x.role || null) as OrgRole | null };
      });
    }
    const out = await h.run(async (pve) => {
      const [o, { acls, privs }] = await Promise.all([overview(pve), aclsAndRoles(pve)]);
      const creating = !o.users.some((u) => u.userid === userid);
      const wish: UserWish = { ...(spec.deviceRole ? { deviceRole: spec.deviceRole } : {}), ...(orgs ? { orgs, orgsMode: b.orgsMode === "merge" ? ("merge" as const) : ("replace" as const) } : {}) };
      const plan = planUser(o, acls, privs, userid, wish, creating);
      if (userid === ctx.session().username && wish.deviceRole && wish.deviceRole !== "admin" && o.users.find((u) => u.userid === userid)?.deviceRole === "admin") plan.warnings.push("You can't take your own administrator role away; ask another administrator.");
      return plan;
    });
    ctx.json(200, out);
    return true;
  }

  // ---------------------------------------------------------------- templates
  if (path === "/api/access/templates" && read) {
    const list = Object.values(templates(ctx)).sort((a, b) => a.name.localeCompare(b.name));
    ctx.json(200, { templates: list });
    return true;
  }
  if (path === "/api/access/templates" && method === "POST") {
    await needAdmin("create templates");
    const all = templates(ctx);
    if (Object.keys(all).length >= 50) bad("That's enough templates; remove one first");
    const t = validateTemplate(await ctx.readJson(16 * 1024), `t${randomBytes(5).toString("hex")}`);
    if (Object.values(all).some((x) => x.name.toLowerCase() === t.name.toLowerCase())) bad("A template with that name exists");
    ctx.state.setSetting(TEMPLATES, { ...all, [t.id]: t });
    h.audit("template.create", t.name);
    ctx.json(201, { template: t });
    return true;
  }
  const tp = path.match(/^\/api\/access\/templates\/(t[0-9a-f]{10})(\/apply)?$/);
  if (tp) {
    const all = templates(ctx);
    const t = all[tp[1]];
    if (!t) throw new HttpError(404, "not_found", "No such template");
    if (!tp[2] && method === "PUT") {
      await needAdmin("change templates");
      const next = validateTemplate(await ctx.readJson(16 * 1024), t.id);
      if (Object.values(all).some((x) => x.id !== t.id && x.name.toLowerCase() === next.name.toLowerCase())) bad("A template with that name exists");
      ctx.state.setSetting(TEMPLATES, { ...all, [t.id]: next });
      h.audit("template.update", next.name);
      ctx.json(200, { template: next });
      return true;
    }
    if (!tp[2] && method === "DELETE") {
      await needAdmin("delete templates");
      const { [t.id]: _gone, ...rest } = all;
      ctx.state.setSetting(TEMPLATES, rest);
      h.audit("template.delete", t.name);
      ctx.json(200, { ok: true });
      return true;
    }
    if (tp[2] && method === "POST") {
      await needAdmin("apply templates");
      const b = await ctx.readJson(16 * 1024);
      if (!Array.isArray(b.userids) || b.userids.length < 1 || b.userids.length > 200 || !b.userids.every((u) => typeof u === "string" && USERID.test(u))) bad("Pick up to 200 users");
      if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") bad("dryRun must be true or false");
      const userids = [...new Set(b.userids as string[])];
      const s = ctx.session();
      const results = await h.run(async (pve) => {
        const [o, { acls, privs }] = await Promise.all([overview(pve), aclsAndRoles(pve)]);
        const admin = await ctx.isNodeAdmin(pve);
        const out: { userid: string; changes: Change[]; warnings: string[]; error?: string; applied?: boolean }[] = [];
        for (const userid of userids) {
          const row = o.users.find((u) => u.userid === userid);
          if (!row) {
            out.push({ userid, changes: [], warnings: [], error: "No such user" });
            continue;
          }
          const { wish, groups } = templateWish(t, o, row);
          const plan = planUser(o, acls, privs, userid, wish);
          if (groups.length !== row.groups.length) plan.changes.push({ kind: "effect", text: `Joins group${groups.length - row.groups.length === 1 ? "" : "s"} ${groups.filter((g) => !row.groups.includes(g)).join(", ")}` });
          const entry: (typeof out)[number] = { userid, changes: plan.changes, warnings: plan.warnings };
          if (b.dryRun !== true) {
            try {
              const warn: string[] = [];
              if (wish.deviceRole !== undefined || groups.length !== row.groups.length) warn.push(...(await ctx.iac.updateUser(pve, s, admin, userid, { ...(wish.deviceRole !== undefined ? { deviceRole: wish.deviceRole } : {}), ...(groups.length !== row.groups.length ? { groups } : {}) })).warnings);
              for (const x of wish.orgs ?? []) if (x.role) await ctx.iac.setOrgRole(pve, s, admin, x.companyId, userid, x.role).catch((e: Error) => warn.push(`${o.orgs.find((g) => g.companyId === x.companyId)?.name ?? x.companyId}: ${e.message}`));
              entry.warnings.push(...warn);
              entry.applied = true;
            } catch (e) {
              entry.error = e instanceof HttpError ? e.message : (e as Error).message;
            }
          }
          out.push(entry);
        }
        return out;
      });
      if (b.dryRun !== true) h.audit("template.apply", t.name, `${results.filter((r) => r.applied).length} of ${results.length} people`);
      ctx.json(200, { results, dryRun: b.dryRun === true });
      return true;
    }
  }

  // ---------------------------------------------------------------- CSV import
  if ((path === "/api/access/import/preview" || path === "/api/access/import/apply") && method === "POST") {
    h.ticketOnly("Importing people");
    const apply = path.endsWith("/apply");
    const b = await ctx.readJson(300 * 1024);
    if (typeof b.csv !== "string") bad("Send the file's text as csv");
    const opt = importOptions(b);
    const s = ctx.session();
    const result = await h.run(async (pve) => {
      const [o, { acls, privs }] = await Promise.all([overview(pve), aclsAndRoles(pve)]);
      if (!o.canManageUsers) throw new HttpError(403, "forbidden", "Your Proxmox account can't create users, so it can't import them");
      const plan = planImport(b.csv as string, o, acls, privs, Object.values(templates(ctx)), opt);
      if (!apply) return { rows: plan.rows.map(publicRow), problems: plan.problems, newGroups: plan.newGroups, counts: count(plan.rows) };
      if (plan.rows.some((r) => r.action === "error")) throw new HttpError(400, "bad_request", "Fix the rows with errors (or remove them) before importing");
      const admin = await ctx.isNodeAdmin(pve);
      const done: { line: number; userid: string; status: "created" | "updated" | "skipped" | "failed"; warnings: string[]; error?: string; password?: string }[] = [];
      for (const g of plan.newGroups) await ctx.iac.createGroup(pve, g).catch(() => {});
      for (const row of plan.rows) {
        if (row.action === "skip" || !row.spec) {
          done.push({ line: row.line, userid: row.userid, status: "skipped", warnings: row.warnings });
          continue;
        }
        try {
          const spec = { ...row.spec } as Parameters<typeof ctx.iac.createUser>[3];
          let password: string | undefined;
          if (row.action === "create") {
            if (!spec.password && opt.generatePasswords && (row.summary.realmType === "pve" || row.summary.realmType === null)) spec.password = password = generated();
            const r = await ctx.iac.createUser(pve, s, admin, spec);
            done.push({ line: row.line, userid: row.userid, status: "created", warnings: [...row.warnings, ...r.warnings], ...(password ? { password } : {}) });
          } else {
            const { userid: _u, password: _p, ...rest } = spec;
            const r = await ctx.iac.updateUser(pve, s, admin, row.userid, { ...rest, ...(rest.orgs ? { orgs: undefined } : {}) });
            const warn = [...r.warnings];
            for (const x of rest.orgs ?? []) await ctx.iac.setOrgRole(pve, s, admin, x.companyId, row.userid, x.role).catch((e: Error) => warn.push(`${x.companyId}: ${e.message}`));
            done.push({ line: row.line, userid: row.userid, status: "updated", warnings: [...row.warnings, ...warn] });
          }
        } catch (e) {
          done.push({ line: row.line, userid: row.userid, status: "failed", warnings: row.warnings, error: e instanceof HttpError ? e.message : e instanceof Error ? e.message.replace(/\s+/g, " ").slice(0, 300) : "Failed" });
        }
      }
      return { results: done, counts: { created: done.filter((d) => d.status === "created").length, updated: done.filter((d) => d.status === "updated").length, skipped: done.filter((d) => d.status === "skipped").length, failed: done.filter((d) => d.status === "failed").length } };
    });
    if (apply) h.audit("import.apply", undefined, JSON.stringify((result as { counts: unknown }).counts));
    ctx.json(200, result);
    return true;
  }

  // ---------------------------------------------------------------- group to organization mapping
  if (path === "/api/access/group-map" && read) {
    const st = mapState(ctx);
    const { groups, orgs } = await h.run(async (pve) => {
      const o = await overview(pve);
      return { groups: o.groups.map((g) => g.groupid), orgs: o.orgs.map((x) => ({ companyId: x.companyId, name: x.name })) };
    });
    ctx.json(200, { mappings: st.mappings, groups, orgs, roles: ORG_ROLE_NAMES });
    return true;
  }
  if (path === "/api/access/group-map" && method === "PUT") {
    await needAdmin("change group mappings");
    const b = await ctx.readJson(16 * 1024);
    if (!Array.isArray(b.mappings) || b.mappings.length > 100) bad("Send the list of mappings");
    const { groups, orgs } = await h.run(async (pve) => {
      const o = await overview(pve);
      return { groups: new Set(o.groups.map((g) => g.groupid)), orgs: new Set(o.orgs.map((x) => x.companyId)) };
    });
    const seen = new Set<string>();
    const mappings = (b.mappings as { group?: unknown; companyId?: unknown; role?: unknown }[]).map((m) => {
      if (typeof m.group !== "string" || !groups.has(m.group)) return bad("Pick a group that exists");
      if (typeof m.companyId !== "string" || !orgs.has(m.companyId)) return bad("Pick an organization that exists");
      if (!ORG_ROLE_NAMES.includes(m.role as OrgRole)) return bad("The role is owner, admin, operator or viewer");
      const key = `${m.group}|${m.companyId}`;
      if (seen.has(key)) bad("Each group can be mapped once per organization");
      seen.add(key);
      return { id: `m${randomBytes(4).toString("hex")}`, group: m.group, companyId: m.companyId, role: m.role as OrgRole };
    });
    const prev = mapState(ctx);
    ctx.state.setSetting(GROUP_MAP, { mappings, granted: prev.granted });
    h.audit("group-map.update", undefined, `${mappings.length} mapping${mappings.length === 1 ? "" : "s"}`);
    ctx.json(200, { mappings });
    return true;
  }
  if (path === "/api/access/group-map/sync" && method === "POST") {
    await needAdmin("sync group mappings");
    const b = await ctx.readJson(1024);
    if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") bad("dryRun must be true or false");
    const dry = b.dryRun !== false;
    const st = mapState(ctx);
    const s = ctx.session();
    const out = await h.run(async (pve) => {
      const o = await overview(pve);
      const ops = planGroupMap(st, o.users, o.orgs);
      const done: (MapOp & { applied?: boolean; error?: string })[] = ops.map((x) => ({ ...x }));
      if (!dry) {
        const admin = await ctx.isNodeAdmin(pve);
        const granted = { ...st.granted };
        for (const x of done) {
          try {
            await ctx.iac.setOrgRole(pve, s, admin, x.companyId, x.userid, x.to);
            x.applied = true;
            if (x.to) granted[`${x.userid}|${x.companyId}`] = x.to;
            else delete granted[`${x.userid}|${x.companyId}`];
          } catch (e) {
            x.error = e instanceof HttpError ? e.message : e instanceof Error ? e.message.replace(/\s+/g, " ").slice(0, 300) : "Failed";
          }
        }
        ctx.state.setSetting(GROUP_MAP, { mappings: st.mappings, granted });
      }
      return done;
    });
    if (!dry) h.audit("group-map.sync", undefined, `${out.filter((x) => x.applied).length} of ${out.length} changes`);
    ctx.json(200, { operations: out, dryRun: dry });
    return true;
  }

  // ---------------------------------------------------------------- routine webhooks from outside
  if (path === "/api/access/routine-ingress" && read) {
    await needAdmin("manage routine webhooks");
    const orgs = await h.run(async (pve) => (await overview(pve)).orgs);
    ctx.json(200, await listIngress(ctx.state, ctx.gateway, orgs));
    return true;
  }
  const ing = path.match(/^\/api\/access\/routine-ingress\/([A-Za-z0-9_-]{1,64})$/);
  if (ing && method === "PUT") {
    h.ticketOnly("Opening routine webhooks");
    await needAdmin("manage routine webhooks");
    const b = await ctx.readJson(1024);
    if (typeof b.enabled !== "boolean") bad("enabled must be true or false");
    const org = await h.run(async (pve) => (await overview(pve)).orgs.find((x) => x.companyId === ing[1]));
    if (!org) throw new HttpError(404, "not_found", "No such organization");
    setIngress(ctx.state, ctx.now, ing[1], b.enabled as boolean, ctx.session().username);
    h.audit(b.enabled === true ? "ingress.enable" : "ingress.disable", org.name);
    ctx.json(200, { ok: true });
    return true;
  }
  return false;
}

const count = (rows: ImportRow[]) => ({ create: rows.filter((r) => r.action === "create").length, update: rows.filter((r) => r.action === "update").length, skip: rows.filter((r) => r.action === "skip").length, error: rows.filter((r) => r.action === "error").length });
