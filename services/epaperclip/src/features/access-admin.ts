import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import { IDLE_MS, MAX_MS, sessionHandle } from "../sessions.ts";
import { USERID } from "../iac.ts";
import { appendAudit, readAudit, type AuditEntry } from "./access-tokens.ts";
import { handlePeople } from "./access-people.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * Access control, administration side: your own password, signed-in sessions, the audit log (filters and export), the
 * sign-in policy (consent banner, WebAuthn and U2F settings), WebAuthn registration, the effective-permission explorer
 * and scheduled realm sync jobs. Everything is done in Proxmox as the signed-in person, so Proxmox decides what is
 * allowed; the host adds nothing it could get wrong. People tools (change preview, templates, CSV import, group-to-
 * organization mapping) are in access-people.ts.
 */

const enc = encodeURIComponent;
const bad = (m: string): never => {
  throw new HttpError(400, "bad_request", m);
};
const JOB_ID = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;
const REALM_ID = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;
const CALENDAR = /^[A-Za-z0-9 ,*:/.\-~]{1,128}$/;
const FULL_TOKENID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,31}![A-Za-z][A-Za-z0-9._-]{1,63}$/;

async function pveRun<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProxmoxError && e.status === 403) throw new HttpError(403, "forbidden", `Proxmox refused: ${(e.detail ?? "your account doesn't have permission for this").replace(/\s+/g, " ").trim().slice(0, 200)}`);
    throw e;
  }
}

const pw = (v: unknown): string | undefined => {
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string" || v.length > 256) bad("Enter your own password to confirm");
  return v as string;
};

/** Wrong guesses of the current password, per person, so a stolen session can't be used to grind it. */
const passwordFails = new Map<string, { n: number; first: number }>();
const FAIL_WINDOW = 15 * 60_000;
const FAIL_MAX = 5;

/** A Proxmox property string ("a=1,b=two") as an object. */
export function parseProps(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof v !== "string") return out;
  for (const part of v.split(",")) {
    const at = part.indexOf("=");
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

export interface WebauthnPolicy {
  rp: string | null;
  id: string | null;
  origin: string | null;
  allowSubdomains: boolean;
}
export interface U2fPolicy {
  appid: string | null;
  origin: string | null;
}

export function readPolicy(options: Record<string, unknown> | null) {
  const w = parseProps(options?.webauthn);
  const u = parseProps(options?.u2f);
  return {
    webauthn: options?.webauthn === undefined ? null : ({ rp: w.rp ?? null, id: w.id ?? null, origin: w.origin ?? null, allowSubdomains: w["allow-subdomains"] !== "0" } satisfies WebauthnPolicy),
    u2f: options?.u2f === undefined ? null : ({ appid: u.appid ?? null, origin: u.origin ?? null } satisfies U2fPolicy),
    consentText: typeof options?.["consent-text"] === "string" ? (options["consent-text"] as string) : "",
  };
}

const propText = (s: unknown, what: string, max = 128): string => {
  if (typeof s !== "string" || !s.trim() || s.length > max || /[,=\r\n\0]/.test(s)) bad(`${what} can't be empty or contain commas or equals signs`);
  return (s as string).trim();
};

/** The WebAuthn setting as Proxmox writes it, checked against the API description (rp, id, origin, allow-subdomains). */
export function webauthnProp(v: unknown): string {
  if (!v || typeof v !== "object") return bad("WebAuthn needs a relying party name, an ID and an origin");
  const b = v as Record<string, unknown>;
  const rp = propText(b.rp, "The relying party name");
  const id = propText(b.id, "The relying party ID");
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(id)) bad("The relying party ID is a domain name without protocol, port or path");
  const origin = propText(b.origin, "The origin", 256);
  if (!/^https:\/\/[^\s/]+$/i.test(origin) && !/^http:\/\/localhost(:\d+)?$/i.test(origin)) bad("The origin is a https:// address such as https://epaperclip.example.org, or http://localhost");
  if (b.allowSubdomains !== undefined && typeof b.allowSubdomains !== "boolean") bad("allowSubdomains must be true or false");
  return `rp=${rp},id=${id},origin=${origin}${b.allowSubdomains === false ? ",allow-subdomains=0" : ""}`;
}

export function u2fProp(v: unknown): string {
  if (!v || typeof v !== "object") return bad("U2F needs an app ID or an origin");
  const b = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, field] of [["appid", "appid"], ["origin", "origin"]] as const) {
    const x = b[field];
    if (x === undefined || x === null || x === "") continue;
    const t = propText(x, `The U2F ${field}`, 256);
    if (!/^https?:\/\//i.test(t)) bad(`The U2F ${field} is an address starting with https://`);
    parts.push(`${k}=${t}`);
  }
  if (!parts.length) bad("U2F needs an app ID or an origin");
  return parts.join(",");
}

// ---------------------------------------------------------------- audit filters

export interface AuditQuery {
  actor?: string;
  action?: string;
  q?: string;
  from?: number;
  to?: number;
  limit: number;
  offset: number;
}

export function auditQuery(p: URLSearchParams): AuditQuery {
  const num = (k: string) => {
    const v = p.get(k);
    if (v === null || v === "") return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) bad(`${k} must be a time in milliseconds`);
    return n;
  };
  const text = (k: string, max = 128) => {
    const v = p.get(k);
    if (v === null || v === "") return undefined;
    if (v.length > max) bad(`${k} is too long`);
    return v;
  };
  const limit = Math.min(Math.max(Number(p.get("limit") ?? 200) || 200, 1), 2000);
  const offset = Math.max(Number(p.get("offset") ?? 0) || 0, 0);
  return { actor: text("actor"), action: text("action"), q: text("q"), from: num("from"), to: num("to"), limit, offset };
}

export function filterAudit(all: AuditEntry[], q: AuditQuery): AuditEntry[] {
  const needle = q.q?.toLowerCase();
  return all
    .filter((e) => (!q.actor || e.actor === q.actor) && (!q.action || e.action === q.action || e.action.startsWith(`${q.action}.`)) && (q.from === undefined || e.at >= q.from) && (q.to === undefined || e.at <= q.to) && (!needle || [e.actor, e.action, e.target, e.detail, e.ip].some((x) => x?.toLowerCase().includes(needle))))
    .reverse();
}

/** Spreadsheet programs run cells that start with = + - @, so those get a leading apostrophe. */
const cell = (v: unknown) => {
  const s = v === undefined || v === null ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const auditCsv = (rows: AuditEntry[]) => ["time,actor,action,target,detail,address", ...rows.map((e) => [new Date(e.at).toISOString(), e.actor, e.action, e.target, e.detail, e.ip].map(cell).join(","))].join("\r\n") + "\r\n";

// ---------------------------------------------------------------- explorer

interface RawAcl {
  path: string;
  ugid: string;
  type: string;
  roleid: string;
  propagate?: number;
}

/** Whether an ACL entry on `aclPath` reaches `path`: the same path, or an ancestor with propagate on. */
export const aclCovers = (aclPath: string, propagate: boolean, path: string) => aclPath === path || (propagate && (aclPath === "/" || path.startsWith(`${aclPath}/`)));

export async function explore(pve: ProxmoxClient, userid: string) {
  const isToken = userid.includes("!");
  const owner = isToken ? userid.slice(0, userid.indexOf("!")) : userid;
  const [acls, roles, perms, userInfo, tokenInfo] = await Promise.all([
    pve.call<RawAcl[]>("GET", "/access/acl").then((x) => x ?? []),
    pve.call<{ roleid: string; privs?: string }[]>("GET", "/access/roles").then((x) => x ?? []),
    pve.call<Record<string, Record<string, number>>>("GET", "/access/permissions", { userid }).then((x) => x ?? {}),
    pve.call<{ groups?: string | string[] }>("GET", `/access/users/${enc(owner)}`).catch(() => null),
    isToken ? pve.call<{ privsep?: number | boolean }>("GET", `/access/users/${enc(owner)}/token/${enc(userid.slice(userid.indexOf("!") + 1))}`).catch(() => null) : Promise.resolve(null),
  ]);
  const groups = (Array.isArray(userInfo?.groups) ? userInfo!.groups : (userInfo?.groups ?? "").split(",")).map((g) => g.trim()).filter(Boolean);
  const privsep = isToken ? tokenInfo?.privsep !== 0 && tokenInfo?.privsep !== false : false;
  const subjects: { type: "user" | "group" | "token"; id: string; via: string }[] = [];
  if (isToken) subjects.push({ type: "token", id: userid, via: "the token's own permissions" });
  if (!isToken || !privsep) {
    subjects.push({ type: "user", id: owner, via: isToken ? "its owner" : "the user" });
    for (const g of groups) subjects.push({ type: "group", id: g, via: `group ${g}` });
  }
  const privsOf = new Map(roles.map((r) => [r.roleid, (r.privs ?? "").split(",").map((p) => p.trim()).filter(Boolean)]));
  const entries = acls
    .filter((a) => subjects.some((s) => s.type === a.type && s.id === a.ugid))
    .map((a) => ({ path: a.path, role: a.roleid, propagate: a.propagate !== 0, source: subjects.find((s) => s.type === a.type && s.id === a.ugid)!.via, privileges: privsOf.get(a.roleid) ?? [] }))
    .sort((x, y) => x.path.localeCompare(y.path) || x.role.localeCompare(y.role));
  // Effective privileges per path, as Proxmox computes them, each with the entries that grant it.
  const effective = Object.entries(perms)
    .map(([path, p]) => {
      const privileges = Object.entries(p).filter(([, v]) => v === 1).map(([k]) => k).sort();
      const grants: Record<string, { role: string; at: string; source: string }[]> = {};
      for (const priv of privileges) grants[priv] = entries.filter((e) => e.privileges.includes(priv) && aclCovers(e.path, e.propagate, path)).map((e) => ({ role: e.role, at: e.path, source: e.source }));
      return { path, privileges, grants };
    })
    .sort((x, y) => x.path.localeCompare(y.path));
  return { userid, isToken, privsep, groups, entries, effective, note: isToken && privsep ? "This token is privilege-separated: it has only the permissions given to it directly." : null };
}

// ---------------------------------------------------------------- handler

export async function accessAdmin(ctx: FeatureCtx): Promise<boolean> {
  const { method, path } = ctx;
  if (!path.startsWith("/api/access/") && !path.startsWith("/api/login/banner")) return false;
  if (path === "/api/login/banner" && method === "GET") {
    // Public, like the realm list: the notice has to be readable before anyone has signed in.
    ctx.json(200, { text: ctx.state.getSetting<string>("consentText") ?? "" });
    return true;
  }
  if (!path.startsWith("/api/access/")) return false;
  const read = method === "GET";
  if (!read) ctx.sameSite();
  const run = <T>(fn: (pve: ProxmoxClient) => Promise<T>) => ctx.asUser((pve) => pveRun(() => fn(pve)));
  const ticketOnly = (what: string) => {
    if (ctx.session().apiToken) throw new HttpError(403, "ticket_only", `${what} needs a signed-in browser session; API tokens can't do it.`);
  };
  const ip = () => ctx.req.socket.remoteAddress ?? "?";
  const audit = (action: string, target?: string, detail?: string) => appendAudit(ctx.state, ctx.now, { actor: ctx.session().username, action, ip: ip(), ...(target ? { target } : {}), ...(detail ? { detail } : {}) });
  const adminOnly = async (what: string) => {
    const ok = await ctx.asUser((pve) => ctx.isNodeAdmin(pve));
    if (!ok) throw new HttpError(403, "forbidden", `Only Proxmox administrators can ${what}`);
  };

  // ---------------------------------------------------------------- your own password
  if (path === "/api/access/password" && method === "POST") {
    ticketOnly("Changing your password");
    const s = ctx.session();
    const b = await ctx.readJson();
    const current = typeof b.currentPassword === "string" && b.currentPassword.length > 0 && b.currentPassword.length <= 1024 ? b.currentPassword : bad("Enter your current password");
    const next = typeof b.password === "string" && b.password.length >= 8 && b.password.length <= 256 ? b.password : bad("Passwords need at least 8 characters");
    if (next === current) bad("Choose a password that is different from your current one");
    const f = passwordFails.get(s.username);
    if (f && ctx.now() - f.first < FAIL_WINDOW && f.n >= FAIL_MAX) throw new HttpError(429, "too_many_attempts", "Too many wrong passwords. Wait 15 minutes and try again.");
    try {
      await run(async (pve) => {
        const realm = s.username.slice(s.username.lastIndexOf("@") + 1);
        const type = (await pve.call<{ realm: string; type: string }[]>("GET", "/access/domains").catch(() => [])).find((r) => r.realm === realm)?.type;
        if (type && type !== "pve" && type !== "pam") throw new HttpError(400, "managed_elsewhere", `Your account is in the ${type} realm, so its password is changed where that directory lives, not in Proxmox.`);
        await pve.call("PUT", "/access/password", { userid: s.username, password: next, "confirmation-password": current });
      });
    } catch (e) {
      if (e instanceof ProxmoxError && (e.status === 400 || e.status === 401 || e.status === 500) && /password|verif|confirm/i.test(e.detail ?? "")) {
        const t = ctx.now();
        passwordFails.set(s.username, !f || t - f.first >= FAIL_WINDOW ? { n: 1, first: t } : { n: f.n + 1, first: f.first });
        throw new HttpError(403, "bad_current_password", "Your current password isn't right");
      }
      throw e;
    }
    passwordFails.delete(s.username);
    // Every other place you were signed in with the old password ends; this browser stays.
    const ended = ctx.sessions.destroyUserExcept(s.username, ctx.cookieSessionId());
    audit("password.change", s.username, ended ? `${ended} other session${ended === 1 ? "" : "s"} ended` : undefined);
    ctx.json(200, { ok: true, otherSessionsEnded: ended });
    return true;
  }

  // ---------------------------------------------------------------- sessions
  if (path === "/api/access/sessions" && read) {
    const s = ctx.session();
    const all = ctx.url.searchParams.get("all") === "1";
    const isAdmin = await ctx.asUser((pve) => ctx.isNodeAdmin(pve));
    if (all && !isAdmin) throw new HttpError(403, "forbidden", "Only Proxmox administrators can see everyone's sessions");
    const admin = all && isAdmin;
    const current = ctx.cookieSessionId();
    const list = ctx.sessions.list(admin ? undefined : s.username).map((x) => ({
      handle: sessionHandle(x.id),
      username: x.username,
      createdAt: x.createdAt,
      lastSeen: x.lastSeen,
      expiresAt: Math.min(x.lastSeen + IDLE_MS, x.createdAt + MAX_MS),
      ip: x.ip ?? null,
      agent: x.agent ?? null,
      via: x.via ?? null,
      current: x.id === current,
    }));
    ctx.json(200, { sessions: list.reverse(), scope: admin ? "all" : "mine", canManageOthers: isAdmin });
    return true;
  }
  const sess = path.match(/^\/api\/access\/sessions\/([0-9a-f]{16})$/);
  if (sess && method === "DELETE") {
    ticketOnly("Ending a session");
    const s = ctx.session();
    const mine = ctx.sessions.list(s.username).find((x) => sessionHandle(x.id) === sess[1]);
    if (mine?.id === ctx.cookieSessionId()) bad("That's the session you're using. Use Sign out to end it.");
    let admin = false;
    if (!mine) {
      admin = await ctx.asUser((pve) => ctx.isNodeAdmin(pve));
      if (!admin && ctx.sessions.list().some((x) => sessionHandle(x.id) === sess[1])) throw new HttpError(403, "forbidden", "Only you or a Proxmox administrator can end that session");
    }
    const who = ctx.sessions.destroyByHandle(sess[1], mine || !admin ? s.username : null);
    if (!who) throw new HttpError(404, "not_found", "That session has already ended");
    audit("session.revoke", who, who === s.username ? "own session" : "by an administrator");
    ctx.json(200, { ok: true });
    return true;
  }
  if (path === "/api/access/sessions/revoke-others" && method === "POST") {
    ticketOnly("Ending sessions");
    const s = ctx.session();
    const n = ctx.sessions.destroyUserExcept(s.username, ctx.cookieSessionId());
    audit("session.revoke-others", s.username, `${n} ended`);
    ctx.json(200, { ok: true, ended: n });
    return true;
  }
  if (path === "/api/access/sessions/revoke-user" && method === "POST") {
    ticketOnly("Ending someone's sessions");
    await adminOnly("end other people's sessions");
    const b = await ctx.readJson();
    const userid = typeof b.userid === "string" && USERID.test(b.userid) ? b.userid : bad("Pick a user");
    if (userid === ctx.session().username) bad("To end your own other sessions, use Sign out everywhere else");
    const n = ctx.sessions.destroyUser(userid);
    audit("session.revoke-user", userid, `${n} ended`);
    ctx.json(200, { ok: true, ended: n });
    return true;
  }

  // ---------------------------------------------------------------- audit log
  if (path === "/api/access/audit" && read) {
    await adminOnly("read the audit trail");
    const q = auditQuery(ctx.url.searchParams);
    const all = readAudit(ctx.state);
    const rows = filterAudit(all, q);
    ctx.json(200, {
      entries: rows.slice(q.offset, q.offset + q.limit),
      total: rows.length,
      kept: all.length,
      actors: [...new Set(all.map((e) => e.actor))].sort(),
      actions: [...new Set(all.map((e) => e.action))].sort(),
    });
    return true;
  }
  if (path === "/api/access/audit/export" && read) {
    await adminOnly("export the audit trail");
    const q = auditQuery(ctx.url.searchParams);
    const rows = filterAudit(readAudit(ctx.state), { ...q, limit: 100_000, offset: 0 });
    const format = ctx.url.searchParams.get("format") === "json" ? "json" : "csv";
    audit("audit.export", format, `${rows.length} entries`);
    const body = format === "json" ? JSON.stringify({ exportedAt: new Date(ctx.now()).toISOString(), entries: rows }, null, 2) : auditCsv(rows);
    ctx.res.writeHead(200, {
      "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="epaperclip-audit.${format}"`,
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
    });
    ctx.res.end(body);
    return true;
  }

  // ---------------------------------------------------------------- sign-in policy
  if (path === "/api/access/signin-policy" && read) {
    const out = await run(async (pve) => {
      const options = await pve.call<Record<string, unknown>>("GET", "/cluster/options");
      const policy = readPolicy(options);
      const admin = await ctx.isNodeAdmin(pve);
      // The login page shows this notice before anyone has signed in, so the host keeps a copy (set whenever an administrator looks or saves).
      if (admin && (ctx.state.getSetting<string>("consentText") ?? "") !== policy.consentText) ctx.state.setSetting("consentText", policy.consentText);
      return { ...policy, canManage: admin };
    });
    ctx.json(200, out);
    return true;
  }
  if (path === "/api/access/signin-policy" && method === "PUT") {
    ticketOnly("Changing the sign-in policy");
    await adminOnly("change the sign-in policy");
    const b = await ctx.readJson(80 * 1024);
    const params: Record<string, string | undefined> = {};
    const remove: string[] = [];
    if (b.webauthn !== undefined) b.webauthn === null ? remove.push("webauthn") : (params.webauthn = webauthnProp(b.webauthn));
    if (b.u2f !== undefined) b.u2f === null ? remove.push("u2f") : (params.u2f = u2fProp(b.u2f));
    let consent: string | undefined;
    if (b.consentText !== undefined) {
      if (b.consentText === null || b.consentText === "") remove.push("consent-text");
      else if (typeof b.consentText !== "string" || b.consentText.length > 65536 || /\0/.test(b.consentText)) bad("The notice can be up to 65536 characters of text");
      else params["consent-text"] = consent = b.consentText as string;
    }
    if (!Object.keys(params).length && !remove.length) bad("Nothing to change");
    await run((pve) => pve.call("PUT", "/cluster/options", { ...params, ...(remove.length ? { delete: remove.join(",") } : {}) }));
    if (b.consentText !== undefined) ctx.state.setSetting("consentText", consent ?? "");
    audit("signin-policy.update", undefined, [...Object.keys(params), ...remove.map((r) => `${r} cleared`)].join(", "));
    ctx.json(200, { ok: true });
    return true;
  }

  // ---------------------------------------------------------------- WebAuthn registration
  const wa = path.match(/^\/api\/access\/webauthn\/([^/]{3,100})\/(begin|finish)$/);
  if (wa && method === "POST") {
    ticketOnly("Registering a security key");
    const userid = decodeURIComponent(wa[1]);
    if (!USERID.test(userid)) bad("Invalid user id");
    const b = await ctx.readJson(48 * 1024);
    const description = b.description === undefined ? undefined : typeof b.description === "string" && b.description.length <= 255 && !/[\r\n\0]/.test(b.description) ? b.description.trim() || undefined : bad("Keep the description short");
    const password = pw(b.password);
    if (wa[2] === "begin") {
      const r = await run((pve) => pve.call<{ challenge?: string }>("POST", `/access/tfa/${enc(userid)}`, { type: "webauthn", description, password }));
      if (typeof r?.challenge !== "string") throw new HttpError(502, "proxmox_error", "Proxmox didn't return a security key challenge");
      ctx.json(200, { challenge: r.challenge });
      return true;
    }
    // The challenge is the base64url string inside Proxmox's registration options; the value is the browser's answer as JSON.
    const challenge = typeof b.challenge === "string" && /^[A-Za-z0-9_-]{16,512}$/.test(b.challenge) ? b.challenge : bad("The registration expired. Start again.");
    const value = typeof b.value === "string" && b.value.length <= 32 * 1024 ? b.value : bad("The security key's answer is missing");
    try {
      const parsed = JSON.parse(value) as { id?: unknown; type?: unknown };
      if (typeof parsed.id !== "string" || parsed.type !== "public-key") throw new Error();
    } catch {
      bad("The security key's answer isn't valid");
    }
    const r = await run((pve) => pve.call<{ id?: string }>("POST", `/access/tfa/${enc(userid)}`, { type: "webauthn", challenge, value, description, password }));
    audit("tfa.add", userid, "webauthn");
    ctx.json(200, { ok: true, id: r?.id });
    return true;
  }

  // ---------------------------------------------------------------- effective permissions
  if (path === "/api/access/explorer" && read) {
    const userid = ctx.url.searchParams.get("userid") ?? "";
    if (!USERID.test(userid) && !FULL_TOKENID.test(userid)) bad("Pick a user or an API token");
    ctx.json(200, await run((pve) => explore(pve, userid)));
    return true;
  }

  // ---------------------------------------------------------------- scheduled realm sync jobs
  if (path === "/api/access/sync-jobs" && read) {
    const jobs = await run((pve) => pve.call<Record<string, unknown>[]>("GET", "/cluster/jobs/realm-sync"));
    ctx.json(200, {
      jobs: (jobs ?? []).map((j) => ({
        id: String(j.id),
        realm: (j.realm as string | undefined) ?? null,
        schedule: String(j.schedule ?? ""),
        scope: (j.scope as string | undefined) ?? "both",
        enabled: j.enabled !== 0 && j.enabled !== false,
        enableNew: j["enable-new"] !== 0 && j["enable-new"] !== false,
        removeVanished: typeof j["remove-vanished"] === "string" && j["remove-vanished"] !== "none" ? (j["remove-vanished"] as string).split(";").filter(Boolean) : [],
        comment: (j.comment as string | undefined) ?? null,
        nextRun: typeof j["next-run"] === "number" ? (j["next-run"] as number) : null,
        lastRun: typeof j["last-run"] === "number" ? (j["last-run"] as number) : null,
        status: (j.status as string | undefined) ?? null,
      })),
    });
    return true;
  }
  if (path === "/api/access/sync-jobs/preview" && read) {
    const schedule = ctx.url.searchParams.get("schedule") ?? "";
    if (!CALENDAR.test(schedule)) bad("Use a calendar event like daily, hourly, mon..fri 02:30 or *-*-* 03:00");
    const times = await run((pve) => pve.call<{ timestamp: number }[]>("GET", "/cluster/jobs/schedule-analyze", { schedule, iterations: 5 }));
    ctx.json(200, { times: (times ?? []).map((t) => t.timestamp) });
    return true;
  }
  const jobBody = async (creating: boolean) => {
    const b = await ctx.readJson(8 * 1024);
    const params: Record<string, string | number | boolean | undefined> = {};
    const remove: string[] = [];
    if (creating || b.schedule !== undefined) params.schedule = typeof b.schedule === "string" && CALENDAR.test(b.schedule) ? b.schedule.trim() : bad("Use a calendar event like daily, hourly, mon..fri 02:30 or *-*-* 03:00");
    if (creating) params.realm = typeof b.realm === "string" && REALM_ID.test(b.realm) ? b.realm : bad("Pick the realm to sync");
    if (b.scope !== undefined) params.scope = b.scope === "users" || b.scope === "groups" || b.scope === "both" ? b.scope : bad("Sync users, groups or both");
    for (const [k, p] of [["enabled", "enabled"], ["enableNew", "enable-new"]] as const) if (b[k] !== undefined) params[p] = typeof b[k] === "boolean" ? (b[k] as boolean) : bad(`${k} must be true or false`);
    if (b.removeVanished !== undefined) {
      if (!Array.isArray(b.removeVanished) || !b.removeVanished.every((x) => x === "acl" || x === "properties" || x === "entry")) bad("removeVanished lists acl, properties and entry");
      if ((b.removeVanished as string[]).length) params["remove-vanished"] = (b.removeVanished as string[]).join(";");
      else remove.push("remove-vanished");
    }
    if (b.comment !== undefined) {
      const c = b.comment;
      if (typeof c !== "string" || c.length > 512 || /[\r\n\0]/.test(c)) return bad("Keep the comment to one line");
      if (c.trim()) params.comment = c.trim();
      else remove.push("comment");
    }
    return { b, params, remove };
  };
  if (path === "/api/access/sync-jobs" && method === "POST") {
    ticketOnly("Scheduling a sync");
    const { b, params } = await jobBody(true);
    const id = typeof b.id === "string" && JOB_ID.test(b.id) ? b.id : bad("Give the job an ID: letters, digits, - and _, starting with a letter");
    await run((pve) => pve.call("POST", `/cluster/jobs/realm-sync/${enc(id)}`, params));
    audit("sync-job.create", id, `${params.realm} ${params.schedule}`);
    ctx.json(200, { ok: true });
    return true;
  }
  const job = path.match(/^\/api\/access\/sync-jobs\/([A-Za-z][A-Za-z0-9_-]{1,63})$/);
  if (job && method === "PUT") {
    ticketOnly("Changing a sync job");
    const { params, remove } = await jobBody(false);
    // Proxmox wants the schedule on every change; keep the current one when the form didn't change it.
    if (params.schedule === undefined) {
      const cur = await run((pve) => pve.call<{ schedule?: string }>("GET", `/cluster/jobs/realm-sync/${enc(job[1])}`));
      params.schedule = cur?.schedule ?? bad("That job has no schedule yet; give it one");
    }
    await run((pve) => pve.call("PUT", `/cluster/jobs/realm-sync/${enc(job[1])}`, { ...params, ...(remove.length ? { delete: remove.join(",") } : {}) }));
    audit("sync-job.update", job[1]);
    ctx.json(200, { ok: true });
    return true;
  }
  if (job && method === "DELETE") {
    ticketOnly("Deleting a sync job");
    await run((pve) => pve.call("DELETE", `/cluster/jobs/realm-sync/${enc(job[1])}`));
    audit("sync-job.delete", job[1]);
    ctx.json(200, { ok: true });
    return true;
  }
  return handlePeople(ctx, { run, audit, adminOnly, ticketOnly });
}
