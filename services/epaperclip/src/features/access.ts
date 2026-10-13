import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import { DEVICE_ROLES, ORG_POOL_ROLES, USERID } from "../iac.ts";
import { PRIVILEGES, PRIVILEGE_NAMES, ROLE_ID } from "./access-privs.ts";
import { REALM_ID, REALM_TYPES, SECRET_FIELDS, canCreate, canSync, realmSchema, validateRealm, validateSync } from "./access-realms.ts";
import { appendAudit, handleEpcTokens, isManagedPveToken, listTokens, readAudit, removeToken } from "./access-tokens.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * Access control beyond users: groups, roles, permissions (ACLs), API tokens, two-factor, realms and resource pools.
 * Every change is made in Proxmox as the signed-in person, so Proxmox's own permission checks decide. Secrets (bind
 * passwords, client secrets, token values, TOTP seeds, recovery keys) pass through to Proxmox or back to the person
 * once, and are never stored or logged here.
 */

const enc = encodeURIComponent;
const GROUPID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const POOLID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const TOKENID = /^[A-Za-z][A-Za-z0-9._-]{1,63}$/;
const FULL_TOKENID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,31}![A-Za-z][A-Za-z0-9._-]{1,63}$/;
const ACL_PATH = /^\/([A-Za-z0-9._:-]+(\/[A-Za-z0-9._:-]+){0,5})?$/;
const TFA_ID = /^[A-Za-z0-9._-]{1,64}$/;
const bad = (m: string): never => {
  throw new HttpError(400, "bad_request", m);
};

type Params = Record<string, string | number | boolean | undefined>;

/** Runs a Proxmox call; a 403 says what Proxmox refused (it names the missing privilege). */
async function pveRun<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProxmoxError && e.status === 403) throw new HttpError(403, "forbidden", `Proxmox refused: ${(e.detail ?? "your account doesn't have permission for this").replace(/\s+/g, " ").trim().slice(0, 200)}`);
    throw e;
  }
}

async function can(pve: ProxmoxClient, path: string, priv: string): Promise<boolean> {
  try {
    const p = await pve.call<Record<string, Record<string, number>>>("GET", "/access/permissions", { path });
    return p?.[path]?.[priv] === 1;
  } catch {
    return false;
  }
}

const csv = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : []).map((x) => x.trim()).filter(Boolean);

function strArr(v: unknown, what: string, ok: (s: string) => boolean, max = 64): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === "string" && ok(x))) bad(`Invalid ${what}`);
  return v as string[];
}

function comment(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > 2048 || /[\r\n\0]/.test(v)) bad("Keep the comment to one line of up to 2048 characters");
  return (v as string).trim();
}

async function optionalJson(ctx: FeatureCtx): Promise<Record<string, unknown>> {
  const len = ctx.req.headers["content-length"];
  if ((len === undefined || len === "0") && ctx.req.headers["transfer-encoding"] === undefined) return {};
  return ctx.readJson();
}

interface RawAcl {
  path: string;
  ugid: string;
  type: string;
  roleid: string;
  propagate?: number;
}

const DEVICE_KEYS = new Map<string, string>();
for (const [role, list] of Object.entries(DEVICE_ROLES)) for (const a of list) DEVICE_KEYS.set(`${a.path} ${a.role}`, role);

export async function access(ctx: FeatureCtx): Promise<boolean> {
  const { method, path } = ctx;
  if (!path.startsWith("/api/access/")) return false;
  if (await handleEpcTokens(ctx)) return true;
  const read = method === "GET";
  if (!read) ctx.sameSite();
  const run = <T>(fn: (pve: ProxmoxClient) => Promise<T>) => ctx.asUser((pve) => pveRun(() => fn(pve)));
  const noTokenMinting = () => {
    if (ctx.session().apiToken) throw new HttpError(403, "ticket_only", "API tokens can't create or change Proxmox API tokens (that would outlive and escape this token's expiry and limits). Use a signed-in browser session.");
  };
  const ticketOnly = () => {
    if (ctx.session().apiToken) throw new HttpError(403, "ticket_only", "Proxmox doesn't let API tokens manage two-factor settings. Use a signed-in browser session.");
  };
  const audit = (action: string, target?: string, detail?: string) =>
    appendAudit(ctx.state, ctx.now, { actor: ctx.session().username, action, ip: ctx.req.socket.remoteAddress ?? "?", ...(target ? { target } : {}), ...(detail ? { detail } : {}) });

  // ---------------------------------------------------------------- audit trail
  if (path === "/api/access/audit" && read) {
    const entries = await ctx.asUser(async (pve) => {
      if (!(await ctx.isNodeAdmin(pve))) throw new HttpError(403, "forbidden", "Only Proxmox administrators can read the audit trail");
      return readAudit(ctx.state);
    });
    ctx.json(200, { entries: entries.slice().reverse() });
    return true;
  }

  // ---------------------------------------------------------------- groups
  if (path === "/api/access/groups" && read) {
    const out = await run(async (pve) => {
      const list = (await pve.call<{ groupid: string; comment?: string; users?: string }[]>("GET", "/access/groups")) ?? [];
      return { groups: list.map((g) => ({ groupid: g.groupid, comment: g.comment ?? null, members: csv(g.users) })), canManage: await can(pve, "/access/groups", "Group.Allocate") };
    });
    ctx.json(200, out);
    return true;
  }
  if (path === "/api/access/groups" && method === "POST") {
    const b = await ctx.readJson();
    const groupid = typeof b.groupid === "string" && GROUPID.test(b.groupid) ? b.groupid : bad("Group names use letters, digits, . _ and -");
    const members = strArr(b.members, "members", (s) => USERID.test(s));
    const c = comment(b.comment);
    const warnings = await run(async (pve) => {
      await pve.call("POST", "/access/groups", { groupid, comment: c || undefined });
      return setMembers(pve, groupid, members);
    });
    audit("group.create", groupid);
    ctx.json(200, { ok: true, warnings });
    return true;
  }
  const grp = path.match(/^\/api\/access\/groups\/([A-Za-z0-9._-]{1,64})(\/permissions)?$/);
  if (grp) {
    const gid = grp[1];
    if (!GROUPID.test(gid)) bad("Invalid group");
    if (grp[2] && read) {
      ctx.json(200, await run(async (pve) => ({ entries: await effective(pve, (a) => a.type === "group" && a.ugid === gid) })));
      return true;
    }
    if (!grp[2] && read) {
      ctx.json(200, await run(async (pve) => {
        const g = await pve.call<{ comment?: string; members?: string[] }>("GET", `/access/groups/${enc(gid)}`);
        return { groupid: gid, comment: g?.comment ?? null, members: g?.members ?? [] };
      }));
      return true;
    }
    if (!grp[2] && method === "PUT") {
      const b = await ctx.readJson();
      const c = comment(b.comment);
      const members = b.members === undefined ? undefined : strArr(b.members, "members", (s) => USERID.test(s));
      const warnings = await run(async (pve) => {
        if (c !== undefined) await pve.call("PUT", `/access/groups/${enc(gid)}`, { comment: c });
        return members ? setMembers(pve, gid, members) : [];
      });
      audit("group.update", gid);
      ctx.json(200, { ok: true, warnings });
      return true;
    }
    if (!grp[2] && method === "DELETE") {
      await run((pve) => pve.call("DELETE", `/access/groups/${enc(gid)}`));
      audit("group.delete", gid);
      ctx.json(200, { ok: true });
      return true;
    }
  }

  // ---------------------------------------------------------------- roles
  if (path === "/api/access/roles" && read) {
    const out = await run(async (pve) => {
      const list = (await pve.call<{ roleid: string; privs?: string; special?: number | boolean }[]>("GET", "/access/roles")) ?? [];
      return { roles: list.map((r) => ({ roleid: r.roleid, builtin: r.special === true || r.special === 1, privileges: csv(r.privs) })).sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.roleid.localeCompare(b.roleid)), privileges: PRIVILEGES, canManage: await can(pve, "/access", "Sys.Modify") };
    });
    ctx.json(200, out);
    return true;
  }
  if (path === "/api/access/roles" && method === "POST") {
    const b = await ctx.readJson();
    const roleid = typeof b.roleid === "string" && ROLE_ID.test(b.roleid) ? b.roleid : bad("Role names start with a letter and use letters, digits, . _ and -");
    const privs = privList(b.privileges);
    await run((pve) => pve.call("POST", "/access/roles", { roleid, privs: privs.join(",") }));
    audit("role.create", roleid);
    ctx.json(200, { ok: true });
    return true;
  }
  const role = path.match(/^\/api\/access\/roles\/([A-Za-z][A-Za-z0-9._-]{1,63})$/);
  if (role && (method === "PUT" || method === "DELETE")) {
    const roleid = role[1];
    const b = method === "PUT" ? await ctx.readJson() : await optionalJson(ctx);
    const privs = method === "PUT" ? privList(b.privileges) : [];
    const removeAcls = b.removeAcls === true;
    const out = await run(async (pve) => {
      const roles = (await pve.call<{ roleid: string; special?: number | boolean }[]>("GET", "/access/roles")) ?? [];
      const r = roles.find((x) => x.roleid === roleid);
      if (!r) throw new HttpError(404, "not_found", "No such role");
      if (r.special === true || r.special === 1) throw new HttpError(400, "builtin_role", "Built-in roles are read-only. Create a custom role instead.");
      if (method === "PUT") {
        await pve.call("PUT", `/access/roles/${enc(roleid)}`, { privs: privs.join(","), append: false });
        return { ok: true };
      }
      const used = ((await pve.call<RawAcl[]>("GET", "/access/acl")) ?? []).filter((a) => a.roleid === roleid);
      if (used.length && !removeAcls) throw new HttpError(409, "role_in_use", `${used.length} permission${used.length === 1 ? " uses" : "s use"} this role. Remove ${used.length === 1 ? "it" : "them"} first, or delete the role together with ${used.length === 1 ? "it" : "them"}.`);
      for (const a of used) await pve.call("PUT", "/access/acl", aclParams(a.path, [a.roleid], a.type, a.ugid, a.propagate !== 0, true));
      await pve.call("DELETE", `/access/roles/${enc(roleid)}`);
      return { ok: true, removedAcls: used.length };
    });
    audit(method === "PUT" ? "role.update" : "role.delete", roleid);
    ctx.json(200, out);
    return true;
  }

  // ---------------------------------------------------------------- ACLs and effective permissions
  if (path === "/api/access/acl" && read) {
    const out = await run(async (pve) => {
      const acls = (await pve.call<RawAcl[]>("GET", "/access/acl")) ?? [];
      const orgPools = new Map(Object.entries(ctx.state.getSetting<Record<string, { pool: string; name?: string }>>("resourceGroups") ?? {}).map(([id, g]) => [g.pool, g.name ?? id]));
      return {
        acls: acls.map((a) => ({ path: a.path, ugid: a.ugid, type: a.type, roleid: a.roleid, propagate: a.propagate !== 0, preset: presetOf(a, orgPools) })),
        canModify: await can(pve, "/", "Permissions.Modify"),
      };
    });
    ctx.json(200, out);
    return true;
  }
  if (path === "/api/access/acl" && method === "POST") {
    const b = await ctx.readJson();
    const p = aclPath(b.path);
    const roles = strArr(b.roles, "roles", (s) => ROLE_ID.test(s), 16);
    if (!roles.length) bad("Pick at least one role");
    const users = strArr(b.users, "users", (s) => USERID.test(s));
    const groups = strArr(b.groups, "groups", (s) => GROUPID.test(s));
    const tokens = strArr(b.tokens, "tokens", (s) => FULL_TOKENID.test(s));
    if (users.length + groups.length + tokens.length === 0) bad("Pick a user, group or API token");
    if (b.propagate !== undefined && typeof b.propagate !== "boolean") bad("propagate must be true or false");
    const remove = b.remove === true;
    await run((pve) => pve.call("PUT", "/access/acl", { path: p, roles: roles.join(","), users: users.join(",") || undefined, groups: groups.join(",") || undefined, tokens: tokens.join(",") || undefined, propagate: b.propagate !== false, ...(remove ? { delete: true } : {}) }));
    audit(remove ? "acl.remove" : "acl.add", p, `${roles.join(",")} for ${[...users, ...groups, ...tokens].join(",")}`);
    ctx.json(200, { ok: true });
    return true;
  }
  if (path === "/api/access/permissions" && read) {
    const userid = ctx.url.searchParams.get("userid");
    const p = ctx.url.searchParams.get("path");
    if (userid !== null && !USERID.test(userid) && !FULL_TOKENID.test(userid)) bad("Pick a user or an API token");
    if (p !== null) aclPath(p);
    const perms = await run((pve) => pve.call<Record<string, Record<string, number>>>("GET", "/access/permissions", { userid: userid ?? undefined, path: p ?? undefined }));
    ctx.json(200, { permissions: perms ?? {} });
    return true;
  }
  if (path === "/api/access/paths" && read) {
    ctx.json(200, { paths: await run(pathChoices) });
    return true;
  }

  // ---------------------------------------------------------------- users: detail and Proxmox API tokens
  const userRoute = path.match(/^\/api\/access\/users\/([^/]{3,100})(?:\/(tokens|tfa-unlock)(?:\/([A-Za-z][A-Za-z0-9._-]{1,63}))?)?$/);
  if (userRoute) {
    const userid = decodeURIComponent(userRoute[1]);
    if (!USERID.test(userid)) bad("Invalid user id");
    const [, , sub, tokenid] = userRoute;
    if (!sub && read) {
      ctx.json(200, await run((pve) => userDetail(pve, userid)));
      return true;
    }
    if (sub === "tfa-unlock" && method === "PUT") {
      await run((pve) => pve.call("PUT", `/access/users/${enc(userid)}/unlock-tfa`));
      audit("tfa.unlock", userid);
      ctx.json(200, { ok: true });
      return true;
    }
    if (sub === "tokens" && !tokenid && read) {
      ctx.json(200, await run(async (pve) => {
        const list = (await pve.call<{ tokenid: string; comment?: string; expire?: number; privsep?: number | boolean }[]>("GET", `/access/users/${enc(userid)}/token`)) ?? [];
        const mine = new Map(listTokens(ctx.state, userid).map((t) => [t.pveName, t]));
        return {
          tokens: list.map((t) => {
            const epc = mine.get(t.tokenid);
            return { tokenid: t.tokenid, fullTokenid: `${userid}!${t.tokenid}`, comment: t.comment ?? null, expire: t.expire ? t.expire : null, privsep: t.privsep !== 0 && t.privsep !== false, epaperclip: epc ? { id: epc.id, name: epc.name, readOnly: epc.readOnly, expiresAt: epc.expiresAt, lastUsedAt: epc.lastUsedAt } : null };
          }),
        };
      }));
      return true;
    }
    if (sub === "tokens" && !tokenid && method === "POST") {
      noTokenMinting();
      const b = await ctx.readJson();
      const id = typeof b.tokenid === "string" && TOKENID.test(b.tokenid) ? b.tokenid : bad("Token names start with a letter and use letters, digits, . _ and -");
      if (/^epc-/i.test(id)) bad("Names starting with epc- are reserved for ePaperclip API tokens");
      const c = comment(b.comment);
      const expire = expireOf(b.expire);
      if (b.privsep !== undefined && typeof b.privsep !== "boolean") bad("privsep must be true or false");
      const r = await run((pve) => pve.call<{ "full-tokenid": string; value: string; info?: unknown }>("POST", `/access/users/${enc(userid)}/token/${enc(id)}`, { comment: c || undefined, expire, privsep: b.privsep !== false }));
      audit("pve-token.create", `${userid}!${id}`);
      ctx.json(201, { fullTokenid: r?.["full-tokenid"] ?? `${userid}!${id}`, value: r?.value, privsep: b.privsep !== false });
      return true;
    }
    if (sub === "tokens" && tokenid && (method === "PUT" || method === "DELETE")) {
      if (isManagedPveToken(tokenid)) {
        const rec = Object.values(listTokens(ctx.state, userid)).find((t) => t.pveName === tokenid);
        if (method === "PUT") bad("This token belongs to an ePaperclip API token. Revoke it and create a new one to change it.");
        if (rec) removeToken(ctx.state, rec.id);
      }
      if (method === "DELETE") {
        await run((pve) => pve.call("DELETE", `/access/users/${enc(userid)}/token/${enc(tokenid)}`));
        audit("pve-token.delete", `${userid}!${tokenid}`);
        ctx.json(200, { ok: true });
        return true;
      }
      noTokenMinting();
      const b = await ctx.readJson();
      const c = comment(b.comment);
      const expire = expireOf(b.expire);
      if (b.privsep !== undefined && typeof b.privsep !== "boolean") bad("privsep must be true or false");
      if (b.regenerate !== undefined && typeof b.regenerate !== "boolean") bad("regenerate must be true or false");
      const r = await run((pve) => pve.call<{ value?: string }>("PUT", `/access/users/${enc(userid)}/token/${enc(tokenid)}`, { comment: c, expire, privsep: b.privsep as boolean | undefined, regenerate: b.regenerate as boolean | undefined }));
      audit(b.regenerate ? "pve-token.regenerate" : "pve-token.update", `${userid}!${tokenid}`);
      ctx.json(200, { ok: true, ...(r?.value ? { value: r.value } : {}) });
      return true;
    }
  }

  // ---------------------------------------------------------------- two-factor
  if (path === "/api/access/tfa" && read) {
    const out = await run(async (pve) => {
      const list = (await pve.call<{ userid: string; entries?: TfaEntry[]; "tfa-locked-until"?: number; "totp-locked"?: boolean }[]>("GET", "/access/tfa")) ?? [];
      return { users: list.map((u) => ({ userid: u.userid, entries: (u.entries ?? []).map(tfaEntry), lockedUntil: u["tfa-locked-until"] ?? null, totpLocked: u["totp-locked"] === true })) };
    });
    ctx.json(200, out);
    return true;
  }
  const tfa = path.match(/^\/api\/access\/tfa\/([^/]{3,100})(?:\/([A-Za-z0-9._-]{1,64}))?$/);
  if (tfa) {
    const userid = decodeURIComponent(tfa[1]);
    if (!USERID.test(userid)) bad("Invalid user id");
    const id = tfa[2];
    if (id !== undefined && !TFA_ID.test(id)) bad("Invalid entry");
    if (!id && read) {
      ctx.json(200, await run(async (pve) => ({ userid, entries: ((await pve.call<TfaEntry[]>("GET", `/access/tfa/${enc(userid)}`)) ?? []).map(tfaEntry) })));
      return true;
    }
    if (!id && method === "POST") {
      ticketOnly();
      const b = await ctx.readJson(16 * 1024);
      const description = typeof b.description === "string" && b.description.length <= 255 && !/[\r\n\0]/.test(b.description) ? b.description.trim() : b.description === undefined ? undefined : bad("Keep the description short");
      const password = pw(b.password);
      if (b.type === "totp") {
        const uri = typeof b.totp === "string" ? b.totp : "";
        if (!/^otpauth:\/\/totp\/[^?\s]{1,300}\?[^\s]{1,600}$/.test(uri) || !/[?&]secret=[A-Z2-7]{16,128}(&|$)/.test(uri)) bad("That isn't a valid authenticator link");
        const value = typeof b.value === "string" && /^\d{6,8}$/.test(b.value) ? b.value : bad("Enter the code your app shows now");
        const r = await run((pve) => pve.call<{ id: string }>("POST", `/access/tfa/${enc(userid)}`, { type: "totp", totp: uri, value, description: description || undefined, password }));
        audit("tfa.add", userid, "totp");
        ctx.json(200, { ok: true, id: r?.id });
        return true;
      }
      if (b.type === "recovery") {
        const r = await run((pve) => pve.call<{ id: string; recovery?: string[] }>("POST", `/access/tfa/${enc(userid)}`, { type: "recovery", description: description || undefined, password }));
        audit("tfa.add", userid, "recovery");
        ctx.json(200, { ok: true, id: r?.id, recovery: r?.recovery ?? [] });
        return true;
      }
      bad("Authenticator apps and recovery keys can be added here. Security keys (WebAuthn) are bound to Proxmox's own address; add them in Proxmox.");
    }
    if (id && method === "PUT") {
      ticketOnly();
      const b = await ctx.readJson();
      if (b.enable !== undefined && typeof b.enable !== "boolean") bad("enable must be true or false");
      const description = typeof b.description === "string" && b.description.length <= 255 && !/[\r\n\0]/.test(b.description) ? b.description : b.description === undefined ? undefined : bad("Keep the description short");
      await run((pve) => pve.call("PUT", `/access/tfa/${enc(userid)}/${enc(id)}`, { enable: b.enable as boolean | undefined, description, password: pw(b.password) }));
      audit("tfa.update", userid, id);
      ctx.json(200, { ok: true });
      return true;
    }
    if (id && method === "DELETE") {
      ticketOnly();
      const b = await optionalJson(ctx);
      await run((pve) => pve.call("DELETE", `/access/tfa/${enc(userid)}/${enc(id)}`, { password: pw(b.password) }));
      audit("tfa.delete", userid, id);
      ctx.json(200, { ok: true });
      return true;
    }
  }

  // ---------------------------------------------------------------- realms
  if (path === "/api/access/realms" && read) {
    const out = await run(async (pve) => {
      const list = (await pve.call<{ realm: string; type: string; comment?: string; default?: number | boolean; tfa?: string }[]>("GET", "/access/domains")) ?? [];
      const canManage = await can(pve, "/access/realm", "Realm.Allocate");
      const realms = await Promise.all(
        list.map(async (r) => {
          const cfg = await pve.call<Record<string, unknown>>("GET", `/access/domains/${enc(r.realm)}`).catch(() => null);
          return { realm: r.realm, type: r.type, comment: r.comment ?? null, default: r.default === true || r.default === 1, tfa: r.tfa ?? (typeof cfg?.tfa === "string" ? cfg.tfa : null), config: scrub(cfg), canSync: canSync(r.type) };
        }),
      );
      return { realms, canManage, schema: realmSchema(), types: REALM_TYPES, creatable: REALM_TYPES.filter(canCreate) };
    });
    ctx.json(200, out);
    return true;
  }
  if (path === "/api/access/realms" && method === "POST") {
    const b = await ctx.readJson(32 * 1024);
    const realm = typeof b.realm === "string" && REALM_ID.test(b.realm) ? b.realm : bad("Realm names start with a letter and use letters, digits, . _ and -");
    const type = typeof b.type === "string" && canCreate(b.type) ? b.type : bad("Add an LDAP, Active Directory or OpenID Connect realm");
    const { params } = validateRealm(type, b, true);
    await run((pve) => pve.call("POST", "/access/domains", { realm, type, ...params }));
    audit("realm.create", realm, type);
    ctx.json(200, { ok: true });
    return true;
  }
  const rl = path.match(/^\/api\/access\/realms\/([A-Za-z][A-Za-z0-9._-]{0,31})(\/sync)?$/);
  if (rl) {
    const realm = rl[1];
    if (rl[2] && method === "POST") {
      const b = await optionalJson(ctx);
      const o = validateSync(b);
      const upid = await run(async (pve) => {
        const t = (await pve.call<{ realm: string; type: string }[]>("GET", "/access/domains")).find((r) => r.realm === realm);
        if (!t) throw new HttpError(404, "not_found", "No such realm");
        if (!canSync(t.type)) throw new HttpError(400, "bad_request", "Only LDAP and Active Directory realms can be synced");
        return pve.call<string>("POST", `/access/domains/${enc(realm)}/sync`, { scope: o.scope, "dry-run": o["dry-run"], "enable-new": o["enable-new"], "remove-vanished": o["remove-vanished"] });
      });
      audit("realm.sync", realm, o["dry-run"] ? "dry run" : "applied");
      ctx.json(202, { task: upid, dryRun: o["dry-run"] });
      return true;
    }
    if (!rl[2] && method === "PUT") {
      const b = await ctx.readJson(32 * 1024);
      const type = await run(async (pve) => (await pve.call<{ realm: string; type: string }[]>("GET", "/access/domains")).find((r) => r.realm === realm)?.type);
      if (!type) throw new HttpError(404, "not_found", "No such realm");
      const { params, remove } = validateRealm(type, b, false);
      await run((pve) => pve.call("PUT", `/access/domains/${enc(realm)}`, { ...params, ...(remove.length ? { delete: remove.join(",") } : {}) }));
      audit("realm.update", realm);
      ctx.json(200, { ok: true });
      return true;
    }
    if (!rl[2] && method === "DELETE") {
      if (realm === "pam" || realm === "pve") bad("The built-in realms can't be deleted");
      await run((pve) => pve.call("DELETE", `/access/domains/${enc(realm)}`));
      audit("realm.delete", realm);
      ctx.json(200, { ok: true });
      return true;
    }
  }

  // ---------------------------------------------------------------- resource pools
  if (path === "/api/access/pools" && read) {
    ctx.json(200, await run(async (pve) => poolOverview(pve, ctx)));
    return true;
  }
  if (path === "/api/access/pools" && method === "POST") {
    const b = await ctx.readJson();
    const poolid = typeof b.poolid === "string" && POOLID.test(b.poolid) ? b.poolid : bad("Pool names start with a letter and use letters, digits, . _ and -");
    const c = comment(b.comment);
    await run((pve) => pve.call("POST", "/pools", { poolid, comment: c || undefined }));
    audit("pool.create", poolid);
    ctx.json(200, { ok: true });
    return true;
  }
  const pl = path.match(/^\/api\/access\/pools\/([A-Za-z][A-Za-z0-9._-]{0,63})$/);
  if (pl && (method === "PUT" || method === "DELETE")) {
    const poolid = pl[1];
    if (method === "DELETE") {
      const org = orgOf(ctx, poolid);
      if (org) throw new HttpError(409, "organization_pool", `${poolid} is the resource group of the organization ${org.name}. Delete the organization's resource group first.`);
      await run((pve) => pve.call("DELETE", "/pools", { poolid }));
      audit("pool.delete", poolid);
      ctx.json(200, { ok: true });
      return true;
    }
    const b = await ctx.readJson();
    const c = comment(b.comment);
    const vmid = (s: string) => /^\d{3,9}$/.test(s);
    const sid = (s: string) => /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(s);
    const addVms = strArr(b.addVms, "machines", vmid, 200);
    const removeVms = strArr(b.removeVms, "machines", vmid, 200);
    const addStorage = strArr(b.addStorage, "storage", sid, 100);
    const removeStorage = strArr(b.removeStorage, "storage", sid, 100);
    if (b.move !== undefined && typeof b.move !== "boolean") bad("move must be true or false");
    await run(async (pve) => {
      if (c !== undefined) await pve.call("PUT", "/pools", { poolid, comment: c });
      if (addVms.length || addStorage.length) await pve.call("PUT", "/pools", { poolid, vms: addVms.join(",") || undefined, storage: addStorage.join(",") || undefined, "allow-move": b.move === true ? true : undefined });
      if (removeVms.length || removeStorage.length) await pve.call("PUT", "/pools", { poolid, vms: removeVms.join(",") || undefined, storage: removeStorage.join(",") || undefined, delete: true });
    });
    audit("pool.update", poolid);
    ctx.json(200, { ok: true });
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ helpers

interface TfaEntry {
  id: string;
  type: string;
  description?: string;
  created?: number;
  enable?: boolean | number;
}
const tfaEntry = (e: TfaEntry) => ({ id: e.id, type: e.type, description: e.description ?? "", created: e.created ?? null, enabled: e.enable !== false && e.enable !== 0 });

const pw = (v: unknown): string | undefined => {
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string" || v.length > 64) bad("Enter your own password to confirm");
  return v as string;
};

function expireOf(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) bad("expire is a Unix time in seconds, or 0 for never");
  return v as number;
}

function privList(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 100) return bad("Pick the privileges this role grants");
  const list = [...new Set(v.map(String))];
  const unknown = list.filter((p) => !PRIVILEGE_NAMES.has(p));
  if (unknown.length) bad(`Unknown privilege: ${unknown[0]}`);
  return list;
}

function aclPath(v: unknown): string {
  if (typeof v !== "string" || v.length > 200 || !ACL_PATH.test(v) || v.includes("..")) return bad("Use a path like /, /vms/100, /storage/local or /pool/team");
  return v;
}

function aclParams(path: string, roles: string[], type: string, ugid: string, propagate: boolean, remove: boolean): Params {
  return { path, roles: roles.join(","), [type === "group" ? "groups" : type === "token" ? "tokens" : "users"]: ugid, propagate, ...(remove ? { delete: true } : {}) };
}

function presetOf(a: RawAcl, orgPools: Map<string, string>): string | null {
  if (a.type === "user") {
    const d = DEVICE_KEYS.get(`${a.path} ${a.roleid}`);
    if (d) return `Device role: ${d}`;
  }
  const m = a.path.match(/^\/pool\/(.+)$/);
  if (a.type === "user" && m && orgPools.has(m[1]) && Object.values(ORG_POOL_ROLES).some((l) => l.includes(a.roleid))) return `Organization role in ${orgPools.get(m[1])}`;
  return null;
}

const orgOf = (ctx: FeatureCtx, poolid: string) => {
  const all = ctx.state.getSetting<Record<string, { pool: string; name?: string }>>("resourceGroups") ?? {};
  const hit = Object.entries(all).find(([, g]) => g.pool === poolid);
  return hit ? { companyId: hit[0], name: hit[1].name ?? hit[0] } : null;
};

/** Privileges a set of ACL entries add up to, per entry. */
async function effective(pve: ProxmoxClient, pick: (a: RawAcl) => boolean) {
  const [acls, roles] = await Promise.all([pve.call<RawAcl[]>("GET", "/access/acl"), pve.call<{ roleid: string; privs?: string }[]>("GET", "/access/roles")]);
  const privs = new Map((roles ?? []).map((r) => [r.roleid, csv(r.privs)]));
  return (acls ?? []).filter(pick).map((a) => ({ path: a.path, roleid: a.roleid, propagate: a.propagate !== 0, privileges: privs.get(a.roleid) ?? [] }));
}

async function setMembers(pve: ProxmoxClient, gid: string, wanted: string[]): Promise<string[]> {
  const warnings: string[] = [];
  const g = await pve.call<{ members?: string[] }>("GET", `/access/groups/${enc(gid)}`);
  const cur = new Set(g?.members ?? []);
  const want = new Set(wanted);
  for (const u of want) if (!cur.has(u)) await pve.call("PUT", `/access/users/${enc(u)}`, { groups: gid, append: true }).catch((e: Error) => warnings.push(`${u}: ${e.message}`));
  for (const u of cur) {
    if (want.has(u)) continue;
    try {
      const d = await pve.call<{ groups?: string | string[] }>("GET", `/access/users/${enc(u)}`);
      const rest = csv(d?.groups).filter((x) => x !== gid);
      await pve.call("PUT", `/access/users/${enc(u)}`, { groups: rest.join(",") });
    } catch (e) {
      warnings.push(`${u}: ${(e as Error).message}`);
    }
  }
  return warnings;
}

async function userDetail(pve: ProxmoxClient, userid: string) {
  const [u, tfa, realms, tokens] = await Promise.all([
    pve.call<Record<string, unknown>>("GET", `/access/users/${enc(userid)}`),
    pve.call<TfaEntry[]>("GET", `/access/tfa/${enc(userid)}`).catch(() => null),
    pve.call<{ realm: string; type: string; tfa?: string }[]>("GET", "/access/domains").catch(() => []),
    pve.call<unknown[]>("GET", `/access/users/${enc(userid)}/token`).catch(() => null),
  ]);
  const realm = realms.find((r) => r.realm === userid.slice(userid.lastIndexOf("@") + 1));
  const tokenCount = Array.isArray(tokens) ? tokens.length : u?.tokens && typeof u.tokens === "object" ? Object.keys(u.tokens).length : 0;
  return {
    userid,
    realmType: realm?.type ?? null,
    realmTfa: realm?.tfa ?? null,
    firstname: u?.firstname ?? "",
    lastname: u?.lastname ?? "",
    email: u?.email ?? "",
    comment: u?.comment ?? "",
    enabled: u?.enable !== 0 && u?.enable !== false,
    expire: typeof u?.expire === "number" && u.expire > 0 ? u.expire : null,
    groups: csv(u?.groups),
    keys: typeof u?.keys === "string" ? u.keys : "",
    tokens: tokenCount,
    tfa: tfa === null ? null : tfa.map(tfaEntry),
  };
}

function scrub(cfg: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg ?? {})) if (!SECRET_FIELDS.has(k) && !/secret|passw|key$/i.test(k) && k !== "digest") out[k] = v;
  return out;
}

async function pathChoices(pve: ProxmoxClient) {
  const fixed = ["/", "/vms", "/storage", "/nodes", "/pool", "/sdn", "/access", "/access/groups", "/access/realm", "/mapping"].map((path) => ({ path, label: path === "/" ? "Everything" : path.slice(1), kind: "root" }));
  const out = new Map(fixed.map((x) => [x.path, x as { path: string; label: string; kind: string }]));
  const add = (path: string, label: string, kind: string) => out.has(path) || out.set(path, { path, label, kind });
  const res = await pve.call<{ type: string; vmid?: number; name?: string; storage?: string; node?: string; sdn?: string; pool?: string }[]>("GET", "/cluster/resources").catch(() => []);
  for (const r of res ?? []) {
    if ((r.type === "qemu" || r.type === "lxc") && r.vmid) add(`/vms/${r.vmid}`, `${r.name ?? "machine"} (${r.vmid})`, "machine");
    else if (r.type === "storage" && r.storage) add(`/storage/${r.storage}`, r.storage, "storage");
    else if (r.type === "node" && r.node) add(`/nodes/${r.node}`, r.node, "device");
    else if (r.type === "sdn" && r.sdn) add(`/sdn/zones/${r.sdn}`, r.sdn, "network");
    else if (r.type === "pool" && r.pool) add(`/pool/${r.pool}`, r.pool, "pool");
  }
  for (const p of (await pve.call<{ poolid: string }[]>("GET", "/pools").catch(() => [])) ?? []) add(`/pool/${p.poolid}`, p.poolid, "pool");
  return [...out.values()];
}

async function poolOverview(pve: ProxmoxClient, ctx: FeatureCtx) {
  const [list, vms, stores] = await Promise.all([
    pve.call<{ poolid: string; comment?: string }[]>("GET", "/pools"),
    pve.clusterResources().catch(() => []),
    pve.clusterStorage().catch(() => []),
  ]);
  const names = new Map(vms.map((v) => [v.vmid, v.name]));
  const pools = await Promise.all(
    (list ?? []).slice(0, 200).map(async (p) => {
      const r = await pve.call<unknown>("GET", "/pools", { poolid: p.poolid }).catch(() => null);
      const item = (Array.isArray(r) ? (r.find((x: { poolid?: string }) => x.poolid === p.poolid) ?? r[0]) : r) as { comment?: string; members?: { type: string; id: string; vmid?: number; storage?: string }[] } | null;
      const org = orgOf(ctx, p.poolid);
      return {
        poolid: p.poolid,
        comment: p.comment ?? item?.comment ?? null,
        members: (item?.members ?? []).map((m) => (m.type === "storage" ? { kind: "storage" as const, id: m.storage ?? m.id, name: m.storage ?? m.id } : { kind: "machine" as const, id: String(m.vmid ?? m.id), name: names.get(m.vmid) ?? null, type: m.type })),
        organization: org,
        orgPool: p.poolid.startsWith("epc-"),
      };
    }),
  );
  return {
    pools,
    candidates: { machines: vms.filter((v) => v.vmid).map((v) => ({ vmid: v.vmid!, name: v.name ?? null, type: v.type })), storage: [...new Set(stores.map((s) => s.storage).filter(Boolean) as string[])] },
    canManage: await can(pve, "/pool", "Pool.Allocate"),
  };
}
