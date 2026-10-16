import { randomUUID } from "node:crypto";
import type { Transport } from "@papercliped-engine/proxmox-client";

/**
 * A stand-in for Proxmox's access-control API (users, groups, roles, ACLs, API tokens, two-factor, realms, pools),
 * with real permission checks: a request is allowed when the ticket's user (or the API token) holds the privilege
 * through a role on a path that covers it. Errors come back the way Proxmox sends them: 403 for refused, 500 with a
 * message for most invalid requests. Test support only.
 */

const ALL_PRIVS = "Datastore.Allocate Datastore.AllocateSpace Datastore.AllocateTemplate Datastore.Audit Group.Allocate Mapping.Audit Mapping.Modify Mapping.Use Permissions.Modify Pool.Allocate Pool.Audit Realm.Allocate Realm.AllocateUser SDN.Allocate SDN.Audit SDN.Use Sys.AccessNetwork Sys.Audit Sys.Console Sys.Incoming Sys.Modify Sys.PowerMgmt Sys.Syslog User.Modify VM.Allocate VM.Audit VM.Backup VM.Clone VM.Config.CDROM VM.Config.CPU VM.Config.Cloudinit VM.Config.Disk VM.Config.HWType VM.Config.Memory VM.Config.Network VM.Config.Options VM.Console VM.GuestAgent.Audit VM.GuestAgent.FileRead VM.GuestAgent.FileSystemMgmt VM.GuestAgent.FileWrite VM.GuestAgent.Unrestricted VM.Migrate VM.PowerMgmt VM.Replicate VM.Snapshot VM.Snapshot.Rollback".split(" ");

interface FUser {
  userid: string;
  enable: number;
  expire?: number;
  firstname?: string;
  lastname?: string;
  email?: string;
  comment?: string;
  groups: string[];
  keys?: string;
  password?: string;
}
interface FAcl {
  path: string;
  ugid: string;
  type: "user" | "group" | "token";
  roleid: string;
  propagate: number;
}
interface FToken {
  comment?: string;
  expire?: number;
  privsep: number;
  secret: string;
}
interface FTfa {
  id: string;
  type: string;
  description: string;
  created: number;
  enable: number;
}

export function fakeAccessPve() {
  const users = new Map<string, FUser>();
  const mk = (u: Partial<FUser> & { userid: string }) => users.set(u.userid, { enable: 1, groups: [], ...u });
  mk({ userid: "sam@pve", firstname: "Sam", password: "right" });
  mk({ userid: "lee@pve", password: "right" });
  mk({ userid: "kim@pve", password: "right" });
  mk({ userid: "yuki@pve", password: "right" });
  mk({ userid: "root@pam", password: "right" });
  const groups = new Map<string, string>([["ops", "Operations"]]);
  const roles = new Map<string, { privs: string[]; special: boolean }>([
    ["Administrator", { privs: ALL_PRIVS, special: true }],
    ["NoAccess", { privs: [], special: true }],
    ["PVEAuditor", { privs: ["VM.Audit", "Sys.Audit", "Datastore.Audit", "Pool.Audit", "SDN.Audit", "Mapping.Audit"], special: true }],
    ["PVEVMAdmin", { privs: ALL_PRIVS.filter((p) => p.startsWith("VM.")), special: true }],
    ["PVEPoolAdmin", { privs: ["Pool.Allocate", "Pool.Audit"], special: true }],
    ["PVEVMUser", { privs: ["VM.Audit", "VM.Console", "VM.PowerMgmt"], special: true }],
    ["PVEDatastoreUser", { privs: ["Datastore.Audit", "Datastore.AllocateSpace"], special: true }],
  ]);
  const acl: FAcl[] = [
    { path: "/", ugid: "sam@pve", type: "user", roleid: "Administrator", propagate: 1 },
    { path: "/", ugid: "root@pam", type: "user", roleid: "Administrator", propagate: 1 },
  ];
  const tokens = new Map<string, Map<string, FToken>>(); // userid -> tokenid -> token
  const tfa = new Map<string, FTfa[]>();
  const realms = new Map<string, Record<string, unknown>>([
    ["pam", { realm: "pam", type: "pam", comment: "Linux PAM standard authentication" }],
    ["pve", { realm: "pve", type: "pve", comment: "Proxmox VE authentication server", default: 1 }],
  ]);
  const pools = new Map<string, { comment?: string; vms: Set<number>; storage: Set<string> }>([["existing", { vms: new Set(), storage: new Set() }]]);
  const guests = [
    { type: "lxc", vmid: 101, name: "web", node: "pve", status: "running" },
    { type: "qemu", vmid: 200, name: "db", node: "pve", status: "stopped" },
  ];
  const tasks = new Map<string, string[]>();
  const tickets = new Map<string, string>();
  const calls: { method: string; path: string; body?: string; auth: "ticket" | "token" | "none" }[] = [];
  const st = { totpCode: "123456", failTfa: false, syncFails: false, n: 0 };
  /** Datacenter options this fake knows: the sign-in ones (webauthn, u2f, consent-text). */
  const options: Record<string, string> = {};
  const jobs = new Map<string, Record<string, unknown>>();
  /** OpenID Connect: codes the identity provider would hand back, by state, and who they sign in. */
  const openid = { codes: new Map<string, string>(), states: new Set<string>(), user: "oidc-ann@sso" };
  /** Users that need a second factor at sign-in: "totp" or "webauthn" only. */
  const needTfa = new Map<string, "totp" | "webauthn">();
  const webauthnPending = new Map<string, string>();

  const privsFor = (principal: { user: string; token?: string; privsep?: boolean }, path: string): Set<string> => {
    const out = new Set<string>();
    const subjects: { type: string; id: string }[] = [];
    if (principal.token && principal.privsep) subjects.push({ type: "token", id: `${principal.user}!${principal.token}` });
    else {
      subjects.push({ type: "user", id: principal.user });
      for (const g of users.get(principal.user)?.groups ?? []) subjects.push({ type: "group", id: g });
      if (principal.token) subjects.push({ type: "token", id: `${principal.user}!${principal.token}` });
    }
    for (const a of acl) {
      if (!subjects.some((s) => s.type === a.type && s.id === a.ugid)) continue;
      const covers = a.path === path || (a.propagate && (a.path === "/" || path.startsWith(`${a.path}/`)));
      if (covers) for (const p of roles.get(a.roleid)?.privs ?? []) out.add(p);
    }
    return out;
  };

  const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ status: 200, body: JSON.stringify({ data, ...extra }) });
  const err = (message: string, status = 500) => ({ status, body: JSON.stringify({ message: `${message}\n` }) });
  const csvOf = (v: string | null) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const path = decodeURIComponent(u.pathname.replace("/api2/json", ""));
    const f = new URLSearchParams(req.method === "GET" || req.method === "DELETE" ? u.search : (req.body ?? ""));
    const auth = (req.headers.Authorization ?? "").startsWith("PVEAPIToken=") ? "token" : req.headers.Cookie ? "ticket" : "none";
    calls.push({ method: req.method, path, body: req.body ?? (u.search || undefined), auth });

    if (path === "/access/domains" && req.method === "GET") return ok([...realms.values()].map((r) => ({ realm: r.realm, type: r.type, comment: r.comment, default: r.default, tfa: r.tfa })));
    if (path === "/access/ticket") {
      const g = new URLSearchParams(req.body);
      const name = g.get("username")!;
      const userid = name.includes("@") ? name : `${name}@${g.get("realm") ?? "pve"}`;
      const pass = g.get("password")!;
      const user = users.get(userid);
      const viaTicket = tickets.get(pass) === userid;
      if (g.get("tfa-challenge")) {
        const webauthnOk = needTfa.get(userid) === "webauthn" && pass.startsWith("webauthn:") && (() => { try { return Boolean(JSON.parse(pass.slice(9)).id); } catch { return false; } })();
        if (tickets.get(g.get("tfa-challenge")!) !== userid || st.failTfa || (!webauthnOk && (!/^totp:\d{6}$/.test(pass) || pass !== `totp:${st.totpCode}`))) return { status: 401, body: "" };
        const t = `PVE:${userid}:${++st.n}`;
        tickets.set(t, userid);
        return ok({ username: userid, ticket: t, CSRFPreventionToken: `c${st.n}` });
      }
      if (!user || user.enable === 0 || (pass !== user.password && !viaTicket)) return { status: 401, body: "" };
      const second = needTfa.get(userid);
      if (second && !viaTicket) {
        const challenge = second === "totp" ? { totp: true, recovery: "available" } : { webauthn: { publicKey: { challenge: "YWJj", timeout: 60000, rpId: "pve.test", allowCredentials: [{ type: "public-key", id: "Y3JlZA" }], userVerification: "preferred" } } };
        const partial = `PVE:!tfa!${encodeURIComponent(JSON.stringify(challenge))}:00AA::sig`;
        tickets.set(partial, userid);
        return ok({ username: userid, ticket: partial, NeedTFA: 1 });
      }
      const t = `PVE:${userid}:${++st.n}`;
      tickets.set(t, userid);
      return ok({ username: userid, ticket: t, CSRFPreventionToken: `c${st.n}` });
    }

    if (path === "/access/openid/auth-url" && req.method === "POST") {
      const g = new URLSearchParams(req.body);
      const r = realms.get(g.get("realm") ?? "");
      if (!r || r.type !== "openid") return err("authentication domain does not exist or is not an OpenID realm");
      const state = `st${++st.n}`;
      openid.states.add(state);
      return ok(`${r["issuer-url"] ?? "https://idp.example/auth"}?client_id=${r["client-id"] ?? "epc"}&state=${state}&redirect_uri=${encodeURIComponent(g.get("redirect-url") ?? "")}`);
    }
    if (path === "/access/openid/login" && req.method === "POST") {
      const g = new URLSearchParams(req.body);
      if (!openid.states.delete(g.get("state") ?? "") || openid.codes.get(g.get("code") ?? "") === undefined) return err("openid login failed: invalid state or code", 401);
      const userid = openid.codes.get(g.get("code")!)!;
      if (!users.has(userid)) users.set(userid, { userid, enable: 1, groups: [] });
      const t = `PVE:${userid}:${++st.n}`;
      tickets.set(t, userid);
      return ok({ username: userid, ticket: t, CSRFPreventionToken: `c${st.n}` });
    }

    // Who is calling?
    let principal: { user: string; token?: string; privsep?: boolean } | null = null;
    if (auth === "token") {
      const m = /^PVEAPIToken=([^!]+)!([^=]+)=(.+)$/.exec(req.headers.Authorization!);
      const tk = m ? tokens.get(m[1])?.get(m[2]) : undefined;
      const owner = m ? users.get(m[1]) : undefined;
      if (!m || !tk || tk.secret !== m[3] || !owner || owner.enable === 0 || (tk.expire && tk.expire * 1000 < Date.now())) return { status: 401, body: JSON.stringify({ message: "invalid token" }) };
      principal = { user: m[1], token: m[2], privsep: tk.privsep === 1 };
    } else {
      const user = tickets.get(decodeURIComponent((req.headers.Cookie ?? "").replace("PVEAuthCookie=", "")));
      const rec = user ? users.get(user) : undefined;
      if (!user || !rec || rec.enable === 0) return { status: 401, body: "" };
      principal = { user };
    }
    const me = principal.user;
    const need = (priv: string, at = "/") => (privsFor(principal!, at).has(priv) ? null : err(`Permission check failed (${at}, ${priv})`, 403));
    const selfOr = (uid: string, priv: string, at: string) => (uid === me ? null : need(priv, at));

    if (path === "/version") return ok({ version: "8.4.1", release: "8.4" });
    if (path === "/access/permissions") {
      const target = f.get("userid") ?? me;
      if (target !== me && !privsFor(principal, "/access").has("Sys.Audit")) return err("Permission check failed (/access, Sys.Audit)", 403);
      const [uid, tid] = target.split("!");
      const subject = { user: uid, token: tid, privsep: tid ? tokens.get(uid)?.get(tid)?.privsep === 1 : false };
      // Without a path Proxmox lists every path the person has anything on.
      const wanted = f.has("path") ? [f.get("path")!] : [...new Set(["/", ...acl.map((a) => a.path)])];
      const out: Record<string, Record<string, number>> = {};
      for (const p of wanted) {
        const privs = privsFor(subject, p);
        if (privs.size) out[p] = Object.fromEntries([...privs].map((k) => [k, 1]));
      }
      return ok(out);
    }

    // ---- users
    if (path === "/access/users" && req.method === "GET") return ok([...users.values()].map((x) => ({ userid: x.userid, enable: x.enable, expire: x.expire, firstname: x.firstname, lastname: x.lastname, email: x.email, comment: x.comment, groups: x.groups.join(","), keys: x.keys, "realm-type": realms.get(x.userid.split("@")[1])?.type })));
    if (path === "/access/users" && req.method === "POST") {
      const d = need("User.Modify");
      if (d) return d;
      const id = f.get("userid")!;
      if (users.has(id)) return err(`create user failed: user '${id}' already exists`);
      const rt = realms.get(id.split("@")[1]);
      if (!rt) return err(`unknown realm '${id.split("@")[1]}'`);
      if (f.get("password") && rt.type !== "pve") return err("parameter verification failed: password: only valid for the pve realm", 400);
      mk({ userid: id, firstname: f.get("firstname") ?? undefined, lastname: f.get("lastname") ?? undefined, email: f.get("email") ?? undefined, comment: f.get("comment") ?? undefined, groups: csvOf(f.get("groups")), enable: f.get("enable") === "0" ? 0 : 1, keys: f.get("keys") ?? undefined, password: f.get("password") ?? undefined });
      return ok(null);
    }
    const pu = path.match(/^\/access\/users\/([^/]+)$/);
    if (pu) {
      const id = pu[1];
      const x = users.get(id);
      if (!x) return err(`no such user ('${id}')`);
      if (req.method === "GET") {
        const d = selfOr(id, "User.Modify", "/access/groups") && need("Sys.Audit", "/access/groups");
        if (d) return d;
        return ok({ ...x, password: undefined, groups: x.groups, tokens: Object.fromEntries([...(tokens.get(id) ?? [])].map(([k, v]) => [k, { comment: v.comment, privsep: v.privsep }])) });
      }
      const d = need("User.Modify", "/access/groups");
      if (d) return d;
      if (req.method === "PUT") {
        for (const [k, v] of f.entries()) {
          if (k === "groups") x.groups = f.get("append") === "1" ? [...new Set([...x.groups, ...csvOf(v)])] : csvOf(v);
          else if (k === "enable") x.enable = Number(v);
          else if (k === "expire") x.expire = Number(v);
          else if (["firstname", "lastname", "email", "comment", "keys"].includes(k)) (x as unknown as Record<string, string>)[k] = v;
        }
        return ok(null);
      }
      if (req.method === "DELETE") {
        users.delete(id);
        tokens.delete(id);
        for (let i = acl.length - 1; i >= 0; i--) if (acl[i].ugid === id || acl[i].ugid.startsWith(`${id}!`)) acl.splice(i, 1);
        return ok(null);
      }
    }
    const tk = path.match(/^\/access\/users\/([^/]+)\/token(?:\/([^/]+))?$/);
    if (tk) {
      const uid = tk[1];
      const tid = tk[2];
      const d = selfOr(uid, "User.Modify", "/access/groups");
      if (d) return d;
      if (!users.has(uid)) return err(`no such user ('${uid}')`);
      const set = tokens.get(uid) ?? new Map<string, FToken>();
      tokens.set(uid, set);
      if (req.method === "GET" && !tid) return ok([...set].map(([tokenid, t]) => ({ tokenid, comment: t.comment, expire: t.expire, privsep: t.privsep })));
      if (req.method === "GET" && tid) return set.has(tid) ? ok({ comment: set.get(tid)!.comment, expire: set.get(tid)!.expire, privsep: set.get(tid)!.privsep }) : err("no such token");
      if (req.method === "POST" && tid) {
        if (set.has(tid)) return err(`Token already exists: ${tid}`);
        const secret = randomUUID();
        set.set(tid, { comment: f.get("comment") ?? undefined, expire: f.has("expire") ? Number(f.get("expire")) : undefined, privsep: f.get("privsep") === "0" ? 0 : 1, secret });
        return ok({ "full-tokenid": `${uid}!${tid}`, info: { privsep: set.get(tid)!.privsep }, value: secret });
      }
      if (req.method === "PUT" && tid) {
        const t = set.get(tid);
        if (!t) return err("no such token");
        if (f.has("comment")) t.comment = f.get("comment")!;
        if (f.has("expire")) t.expire = Number(f.get("expire"));
        if (f.has("privsep")) t.privsep = Number(f.get("privsep"));
        if (f.get("regenerate") === "1") {
          t.secret = randomUUID();
          return ok({ "full-tokenid": `${uid}!${tid}`, value: t.secret });
        }
        return ok({});
      }
      if (req.method === "DELETE" && tid) {
        if (!set.delete(tid)) return err("no such token");
        for (let i = acl.length - 1; i >= 0; i--) if (acl[i].ugid === `${uid}!${tid}`) acl.splice(i, 1);
        return ok(null);
      }
    }
    const ul = path.match(/^\/access\/users\/([^/]+)\/unlock-tfa$/);
    if (ul && req.method === "PUT") return need("User.Modify", "/access/groups") ?? ok(true);

    // ---- groups
    if (path === "/access/groups" && req.method === "GET") return ok([...groups].map(([groupid, comment]) => ({ groupid, comment, users: [...users.values()].filter((x) => x.groups.includes(groupid)).map((x) => x.userid).join(",") })));
    if (path === "/access/groups" && req.method === "POST") {
      const d = need("Group.Allocate", "/access/groups");
      if (d) return d;
      const id = f.get("groupid")!;
      if (groups.has(id)) return err(`create group failed: group '${id}' already exists`);
      groups.set(id, f.get("comment") ?? "");
      return ok(null);
    }
    const pg = path.match(/^\/access\/groups\/([^/]+)$/);
    if (pg) {
      const id = pg[1];
      if (!groups.has(id)) return err(`group '${id}' does not exist`);
      if (req.method === "GET") return ok({ comment: groups.get(id), members: [...users.values()].filter((x) => x.groups.includes(id)).map((x) => x.userid) });
      const d = need("Group.Allocate", "/access/groups");
      if (d) return d;
      if (req.method === "PUT") return groups.set(id, f.get("comment") ?? ""), ok(null);
      if (req.method === "DELETE") {
        groups.delete(id);
        for (const x of users.values()) x.groups = x.groups.filter((g) => g !== id);
        for (let i = acl.length - 1; i >= 0; i--) if (acl[i].type === "group" && acl[i].ugid === id) acl.splice(i, 1);
        return ok(null);
      }
    }

    // ---- roles
    if (path === "/access/roles" && req.method === "GET") return ok([...roles].map(([roleid, r]) => ({ roleid, privs: r.privs.join(","), special: r.special ? 1 : 0 })));
    if (path === "/access/roles" && req.method === "POST") {
      const d = need("Sys.Modify", "/access");
      if (d) return d;
      const id = f.get("roleid")!;
      if (roles.has(id)) return err(`role '${id}' already exists`);
      roles.set(id, { privs: csvOf(f.get("privs")), special: false });
      return ok(null);
    }
    const pr = path.match(/^\/access\/roles\/([^/]+)$/);
    if (pr) {
      const id = pr[1];
      const r = roles.get(id);
      if (!r) return err(`role '${id}' does not exist`);
      const d = need("Sys.Modify", "/access");
      if (d) return d;
      if (r.special) return err(`can't modify special role '${id}'`);
      if (req.method === "PUT") return (r.privs = f.get("append") === "1" ? [...new Set([...r.privs, ...csvOf(f.get("privs"))])] : csvOf(f.get("privs"))), ok(null);
      if (req.method === "DELETE") {
        roles.delete(id);
        return ok(null);
      }
    }

    // ---- ACLs
    if (path === "/access/acl" && req.method === "GET") return ok(acl);
    if (path === "/access/acl" && req.method === "PUT") {
      const p = f.get("path")!;
      const d = need("Permissions.Modify", p);
      if (d) return d;
      for (const r of csvOf(f.get("roles"))) if (!roles.has(r)) return err(`role '${r}' does not exist`);
      for (const [key, type] of [["users", "user"], ["groups", "group"], ["tokens", "token"]] as const)
        for (const ug of csvOf(f.get(key))) for (const r of csvOf(f.get("roles"))) {
          const i = acl.findIndex((a) => a.path === p && a.ugid === ug && a.roleid === r && a.type === type);
          if (f.get("delete") === "1") {
            if (i >= 0) acl.splice(i, 1);
          } else if (i < 0) acl.push({ path: p, ugid: ug, type, roleid: r, propagate: f.get("propagate") === "0" ? 0 : 1 });
        }
      return ok(null);
    }

    // ---- passwords
    if (path === "/access/password" && req.method === "PUT") {
      const uid = f.get("userid")!;
      const rec = users.get(uid);
      if (!rec) return err(`no such user ('${uid}')`);
      const type = realms.get(uid.split("@")[1])?.type;
      if (type !== "pve" && type !== "pam") return err(`parameter verification failed: userid: can only change passwords of pve and pam users`, 400);
      if (uid === me) {
        if (f.get("confirmation-password") !== rec.password) return err("confirmation-password: Verification failed", 500);
      } else {
        const d = need("User.Modify", "/access/groups");
        if (d) return d;
        if (f.get("confirmation-password") !== users.get(me)?.password) return err("confirmation-password: Verification failed", 500);
      }
      rec.password = f.get("password")!;
      return ok(null);
    }

    // ---- datacenter options (sign-in policy) and scheduled realm syncs
    if (path === "/cluster/options" && req.method === "GET") return ok({ keyboard: "en-us", ...options });
    if (path === "/cluster/options" && req.method === "PUT") {
      const d = need("Sys.Modify", "/");
      if (d) return d;
      for (const [k, v] of f.entries()) if (k !== "delete") options[k] = v;
      for (const k of csvOf(f.get("delete"))) delete options[k];
      return ok(null);
    }
    if (path === "/cluster/jobs/schedule-analyze" && req.method === "GET") {
      if (!/^[A-Za-z0-9 ,*:/.\-~]+$/.test(f.get("schedule") ?? "") || (f.get("schedule") ?? "").startsWith("bogus")) return err("parameter verification failed: schedule: invalid calendar event", 400);
      return ok(Array.from({ length: Number(f.get("iterations") ?? 5) }, (_, i) => ({ timestamp: 1_800_000_000 + i * 86_400 })));
    }
    if (path === "/cluster/jobs/realm-sync" && req.method === "GET") {
      const d = need("Sys.Audit", "/");
      return d ?? ok([...jobs.values()]);
    }
    const pj = path.match(/^\/cluster\/jobs\/realm-sync\/([^/]+)$/);
    if (pj) {
      const id = pj[1];
      if (req.method === "GET") return jobs.has(id) ? ok(jobs.get(id)) : err(`no such job '${id}'`);
      const d = req.method === "DELETE" ? need("Sys.Modify", "/") : need("Realm.AllocateUser", `/access/realm/${f.get("realm") ?? jobs.get(id)?.realm ?? "x"}`);
      if (d) return d;
      if (req.method === "DELETE") return jobs.delete(id) ? ok(null) : err(`no such job '${id}'`);
      if (req.method === "POST") {
        if (jobs.has(id)) return err(`job '${id}' already exists`);
        const r = realms.get(f.get("realm") ?? "");
        if (!r || (r.type !== "ldap" && r.type !== "ad")) return err("parameter verification failed: realm: realm does not support syncing", 400);
        const j: Record<string, unknown> = { id };
        for (const [k, v] of f.entries()) j[k] = k === "enabled" || k === "enable-new" ? Number(v) : v;
        j["next-run"] = 1_800_086_400;
        jobs.set(id, j);
        return ok(null);
      }
      if (req.method === "PUT") {
        const j = jobs.get(id);
        if (!j) return err(`no such job '${id}'`);
        for (const [k, v] of f.entries()) if (k !== "delete") j[k] = k === "enabled" || k === "enable-new" ? Number(v) : v;
        for (const k of csvOf(f.get("delete"))) delete j[k];
        return ok(null);
      }
    }

    // ---- two-factor
    if (path === "/access/tfa" && req.method === "GET") return ok([...tfa].filter(([uid]) => uid === me || privsFor(principal!, "/access/groups").has("User.Modify")).map(([userid, entries]) => ({ userid, entries })));
    const pt = path.match(/^\/access\/tfa\/([^/]+)(?:\/([^/]+))?$/);
    if (pt) {
      const uid = pt[1];
      const tid = pt[2];
      if (req.method !== "GET" && auth === "token") return { status: 401, body: JSON.stringify({ message: "api token not allowed" }) };
      const d = selfOr(uid, req.method === "GET" ? "Sys.Audit" : "User.Modify", "/access/groups");
      if (d) return d;
      const list = tfa.get(uid) ?? [];
      if (req.method === "GET" && !tid) return ok(list);
      if (req.method === "POST" && !tid) {
        const type = f.get("type")!;
        if (uid === me && users.get(me)?.password && f.get("password") !== users.get(me)!.password) return err("parameter verification failed: password: invalid current password", 400);
        const entry: FTfa = { id: `e${++st.n}`, type, description: f.get("description") ?? "", created: 1_700_000_000, enable: 1 };
        if (type === "totp") {
          if (!/secret=[A-Z2-7]{16,}/.test(f.get("totp") ?? "")) return err("invalid totp uri", 400);
          if (f.get("value") !== st.totpCode) return err("failed to verify TOTP challenge", 400);
          tfa.set(uid, [...list, entry]);
          return ok({ id: entry.id });
        }
        if (type === "recovery") {
          tfa.set(uid, [...list, entry]);
          return ok({ id: entry.id, recovery: ["1111-2222-3333", "4444-5555-6666", "7777-8888-9999"] });
        }
        if (type === "webauthn") {
          if (uid === me && users.get(me)?.password && f.get("password") !== users.get(me)!.password) return err("parameter verification failed: password: invalid current password", 400);
          if (!f.has("challenge")) {
            const challenge = `chal${"A".repeat(20)}${++st.n}`;
            webauthnPending.set(challenge, uid);
            return ok({ challenge: JSON.stringify({ publicKey: { challenge, rp: { name: "Test", id: "pve.test" }, user: { id: "dXNlcg", name: uid, displayName: uid }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [] } }) });
          }
          if (webauthnPending.get(f.get("challenge")!) !== uid) return err("failed to verify webauthn registration: unknown challenge", 400);
          let cred: { id?: string };
          try {
            cred = JSON.parse(f.get("value") ?? "");
          } catch {
            return err("failed to verify webauthn registration: bad response", 400);
          }
          if (!cred.id) return err("failed to verify webauthn registration: bad response", 400);
          webauthnPending.delete(f.get("challenge")!);
          tfa.set(uid, [...list, entry]);
          return ok({ id: entry.id });
        }
        return err(`unsupported type ${type}`, 400);
      }
      const e = list.find((x) => x.id === tid);
      if (tid && !e) return err("no such tfa entry");
      if (req.method === "PUT" && e) {
        if (f.has("enable")) e.enable = Number(f.get("enable"));
        if (f.has("description")) e.description = f.get("description")!;
        return ok(null);
      }
      if (req.method === "DELETE" && e) {
        tfa.set(uid, list.filter((x) => x !== e));
        return ok(null);
      }
    }

    // ---- realms
    if (path === "/access/domains" && req.method === "POST") {
      const d = need("Realm.Allocate", "/access/realm");
      if (d) return d;
      const id = f.get("realm")!;
      if (realms.has(id)) return err(`realm '${id}' already exists`);
      const cfg: Record<string, unknown> = {};
      for (const [k, v] of f.entries()) cfg[k] = v;
      if (f.get("check-connection") === "1" && String(cfg.server1).startsWith("down")) return err("unable to connect to server: connection refused");
      delete cfg["check-connection"];
      realms.set(id, cfg);
      return ok(null);
    }
    const pd = path.match(/^\/access\/domains\/([^/]+)(\/sync)?$/);
    if (pd) {
      const id = pd[1];
      const r = realms.get(id);
      if (!r) return err(`authentication domain '${id}' does not exist`);
      if (pd[2] && req.method === "POST") {
        const d = need("Realm.AllocateUser", `/access/realm/${id}`);
        if (d) return d;
        const upid = `UPID:pve:0000${tasks.size + 1}:00000001:00000001:auth-realm-sync:${id}:${me}:`;
        tasks.set(upid, st.syncFails ? ["TASK ERROR: unable to connect"] : [f.get("dry-run") === "1" ? "would create user ann@" + id : "created user ann@" + id, "TASK OK"]);
        return ok(upid);
      }
      if (req.method === "GET") {
        const d = need("Realm.Allocate", "/access/realm") && need("Sys.Audit", "/access/realm");
        if (d) return d;
        return ok({ ...r, password: "SHOULD-NEVER-LEAK", "client-key": "SHOULD-NEVER-LEAK" });
      }
      const d = need("Realm.Allocate", "/access/realm");
      if (d) return d;
      if (req.method === "PUT") {
        for (const [k, v] of f.entries()) if (k !== "delete" && k !== "check-connection") r[k] = v;
        for (const k of csvOf(f.get("delete"))) delete r[k];
        return ok(null);
      }
      if (req.method === "DELETE") return realms.delete(id), ok(null);
    }
    const tp = path.match(/^\/nodes\/pve\/tasks\/([^/]+)\/(status|log)$/);
    if (tp) {
      const lines = tasks.get(tp[1]);
      if (!lines) return err("no such task");
      return tp[2] === "status" ? ok({ status: "stopped", exitstatus: lines.at(-1) === "TASK OK" ? "OK" : lines.at(-1) }) : ok(lines.map((t, i) => ({ n: i + 1, t })));
    }

    // ---- pools and resources
    if (path === "/pools" && req.method === "GET") {
      const pid = f.get("poolid");
      const view = (id: string) => {
        const p = pools.get(id)!;
        return { poolid: id, comment: p.comment, members: [...[...p.vms].map((vmid) => ({ id: `${guests.find((g) => g.vmid === vmid)?.type}/${vmid}`, type: guests.find((g) => g.vmid === vmid)?.type ?? "qemu", vmid, node: "pve" })), ...[...p.storage].map((s) => ({ id: `storage/pve/${s}`, type: "storage", storage: s, node: "pve" }))] };
      };
      if (pid) return pools.has(pid) ? ok([view(pid)]) : err(`pool '${pid}' does not exist`);
      return ok([...pools].map(([poolid, p]) => ({ poolid, comment: p.comment })));
    }
    if (path === "/pools" && req.method === "POST") {
      const id = f.get("poolid")!;
      const d = need("Pool.Allocate", `/pool/${id}`);
      if (d) return d;
      if (pools.has(id)) return err(`pool '${id}' already exists`);
      pools.set(id, { comment: f.get("comment") ?? undefined, vms: new Set(), storage: new Set() });
      return ok(null);
    }
    if (path === "/pools" && (req.method === "PUT" || req.method === "DELETE")) {
      const id = f.get("poolid")!;
      const d = need("Pool.Allocate", `/pool/${id}`);
      if (d) return d;
      const p = pools.get(id);
      if (!p) return err(`pool '${id}' does not exist`);
      if (req.method === "DELETE") {
        if (p.vms.size || p.storage.size) return err(`pool '${id}' is not empty`);
        return pools.delete(id), ok(null);
      }
      if (f.has("comment")) p.comment = f.get("comment")!;
      const del = f.get("delete") === "1";
      for (const v of csvOf(f.get("vms"))) del ? p.vms.delete(Number(v)) : p.vms.add(Number(v));
      for (const s of csvOf(f.get("storage"))) del ? p.storage.delete(s) : p.storage.add(s);
      return ok(null);
    }
    if (path === "/cluster/resources") {
      const t = f.get("type");
      const vm = guests.map((g) => ({ id: `${g.type}/${g.vmid}`, ...g }));
      const storage = [{ id: "storage/pve/local", type: "storage", storage: "local", node: "pve", status: "available" }];
      if (t === "vm") return ok(vm);
      if (t === "storage") return ok(storage);
      return ok([...vm, ...storage, { id: "node/pve", type: "node", node: "pve", status: "online" }, { id: "sdn/pve/zone1", type: "sdn", sdn: "zone1", node: "pve" }]);
    }
    if (path === "/nodes/pve/status") return ok({ cpu: 0.07, cpuinfo: { cpus: 8, model: "Test CPU" }, memory: { total: 17_179_869_184, used: 4_294_967_296, free: 12_884_901_888 }, rootfs: { total: 107_374_182_400, used: 21_474_836_480 }, uptime: 86_400, pveversion: "pve-manager/8.4.1", loadavg: ["0.10", "0.08", "0.05"] });
    return err(`no such fake endpoint ${req.method} ${path}`, 501);
  };

  return { transport, users, groups, roles, acl, tokens, tfa, realms, pools, calls, st, needTfa, tasks, tickets, options, jobs, openid };
}
