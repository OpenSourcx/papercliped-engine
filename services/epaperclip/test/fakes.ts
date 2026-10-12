import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import type { Transport } from "@papercliped-engine/proxmox-client";

/**
 * Stand-ins for the engine (Paperclip's HTTP API and live-events socket), Proxmox and the model providers, with just
 * the behaviour the host service relies on: Better Auth cookies, the first-admin claim, the Origin guard on mutations,
 * memberships, and SSE streams.
 */

export interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export async function fakeEngine(opts: { bootstrap?: "pending" | "ready" } = {}) {
  const users = new Map<string, { id: string; password: string; name: string }>();
  const sessions = new Map<string, string>(); // token -> user id
  const companies = new Map<string, { name: string; members: Map<string, string> }>();
  const st = { bootstrap: opts.bootstrap ?? "pending", admin: null as string | null, limitSignIns: 0, signIns: 0, signUps: 0, claims: 0, admins: new Set<string>(), archived: new Set<string>(), invites: 0, inviteTokens: new Map<string, { companyId: string; role: string }>() };
  const seen: SeenRequest[] = [];
  const sockets: { url: string; headers: IncomingMessage["headers"] }[] = [];
  let publicUrl = "";

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const userOf = (req: IncomingMessage) => {
    const m = (req.headers.cookie ?? "").match(/paperclip-default\.session_token=([\w.%-]+)/);
    return m ? (sessions.get(m[1]) ?? null) : null;
  };
  const issue = (userId: string) => {
    const tok = randomBytes(12).toString("hex");
    sessions.set(tok, userId);
    return `paperclip-default.session_token=${tok}; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`;
  };
  const memberships = (uid: string) => [...companies].filter(([, c]) => c.members.has(uid)).map(([companyId, c]) => ({ companyId, membershipRole: c.members.get(uid)!, status: "active" }));

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const u = new URL(req.url!, "http://engine");
    const p = u.pathname;
    const b = () => JSON.parse(body.toString() || "{}");
    if (p === "/api/health") return json(res, 200, { status: "ok", bootstrapStatus: st.bootstrap === "pending" ? "bootstrap_pending" : "ready", version: "2026.1005.0" });
    if (p === "/api/auth/sign-up/email") {
      st.signUps++;
      const { email, password, name } = b();
      if (users.has(email)) return json(res, 422, { message: "User already exists. Use another email.", code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" });
      const id = `u_${users.size + 1}`;
      users.set(email, { id, password, name });
      return json(res, 200, { token: "t", user: { id, email, name } }, { "Set-Cookie": issue(id) });
    }
    if (p === "/api/auth/sign-in/email") {
      st.signIns++;
      if (st.limitSignIns > 0) {
        st.limitSignIns--;
        return json(res, 429, { message: "Too many requests" }, { "X-Retry-After": "1" });
      }
      const { email, password } = b();
      const usr = users.get(email);
      if (!usr || usr.password !== password) return json(res, 401, { message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" });
      return json(res, 200, { token: "t", user: { id: usr.id, email } }, { "Set-Cookie": issue(usr.id) });
    }
    // Paperclip's board-mutation guard: session mutations need the engine's own Origin.
    if (!["GET", "HEAD"].includes(req.method!) && req.headers.origin !== publicUrl) return json(res, 403, { error: "Board mutation requires trusted browser origin" });
    const uid = userOf(req);
    if (!uid) return json(res, 401, { error: "Board authentication required" });
    if (p === "/api/bootstrap/claim") {
      st.claims++;
      if (st.bootstrap === "ready") return json(res, 409, { error: "Someone else has already claimed this instance" });
      st.bootstrap = "ready";
      st.admin = uid;
      st.admins.add(uid!);
      return json(res, 200, { claimed: true, userId: uid });
    }
    const promote = p.match(/^\/api\/admin\/users\/([^/]+)\/(promote|demote)-instance-admin$/);
    if (promote && req.method === "POST") {
      if (!uid) return json(res, 401, { error: "Board authentication required" });
      if (!st.admins.has(uid)) return json(res, 403, { error: "Instance admin required" });
      if (promote[2] === "promote") st.admins.add(decodeURIComponent(promote[1]));
      else st.admins.delete(decodeURIComponent(promote[1]));
      return json(res, 200, { ok: true });
    }
    if (p === "/api/cli-auth/me") return json(res, 200, { user: { id: uid }, userId: uid, isInstanceAdmin: st.admins.has(uid!), companyIds: memberships(uid).map((m) => m.companyId), memberships: memberships(uid), source: "session" });
    if (p === "/api/companies" && req.method === "POST") {
      // Like the real engine: only instance admins create organizations; the creator owns it.
      if (!uid) return json(res, 401, { error: "Board authentication required" });
      if (!st.admins.has(uid)) return json(res, 403, { error: "Instance admin required" });
      const body = b() as { name?: string };
      const id = `co_${companies.size + 1}`;
      companies.set(id, { name: body.name ?? "Org", members: new Map([[uid, "owner"]]) });
      return json(res, 201, { id, name: body.name, status: "active" });
    }
    if (p === "/api/companies" && req.method === "GET") return json(res, 200, [...companies].filter(([, c]) => st.admins.has(uid!) || c.members.has(uid)).map(([id, c]) => ({ id, name: c.name, status: "active" })));
    // Membership: list, change role, archive; invitations with a role, accepted by the invitee.
    const mem = p.match(/^\/api\/companies\/([\w-]+)\/(members|invites)(?:\/([\w.-]+)(\/archive)?)?$/);
    if (mem) {
      const c = companies.get(mem[1]);
      if (!c) return json(res, 404, { error: "Company not found" });
      const manager = st.admins.has(uid!) || ["owner", "admin"].includes(c.members.get(uid!) ?? "");
      if (mem[2] === "members" && req.method === "GET" && !mem[3]) {
        if (!manager && !c.members.has(uid)) return json(res, 403, { error: "Not a member" });
        const list = [...c.members].map(([id, role]) => ({ id: `m.${mem[1]}.${id}`, principalType: "user", principalId: id, membershipRole: role, status: "active" }));
        const gone = [...st.archived].filter((k) => k.startsWith(`${mem[1]}|`)).map((k) => ({ id: `m.${mem[1]}.${k.split("|")[1]}`, principalType: "user", principalId: k.split("|")[1], membershipRole: "viewer", status: "archived" }));
        return json(res, 200, { members: [...list, ...gone], access: {} });
      }
      if (!manager) return json(res, 403, { error: "Permission denied" });
      if (mem[2] === "invites" && req.method === "POST") {
        const token = `pcp_invite_${++st.invites}`;
        st.inviteTokens.set(token, { companyId: mem[1], role: (b() as { humanRole?: string }).humanRole ?? "operator" });
        return json(res, 201, { id: `inv${st.invites}`, token });
      }
      const target = mem[3]?.split(".").slice(2).join(".");
      if (mem[2] === "members" && target && req.method === "PATCH") {
        if (!c.members.has(target)) return json(res, 404, { error: "Member not found" });
        c.members.set(target, (b() as { membershipRole: string }).membershipRole);
        return json(res, 200, { id: mem[3], membershipRole: c.members.get(target), status: "active" });
      }
      if (mem[2] === "members" && target && mem[4] && req.method === "POST") {
        c.members.delete(target);
        st.archived.add(`${mem[1]}|${target}`);
        return json(res, 200, { member: { id: mem[3], status: "archived" } });
      }
    }
    const accept = p.match(/^\/api\/invites\/([\w-]+)\/accept$/);
    if (accept && req.method === "POST") {
      const inv = st.inviteTokens.get(accept[1]);
      if (!inv || !uid) return json(res, 404, { error: "Invite not found" });
      st.inviteTokens.delete(accept[1]);
      companies.get(inv.companyId)!.members.set(uid, inv.role);
      st.archived.delete(`${inv.companyId}|${uid}`);
      return json(res, 202, { status: "approved", requestType: "human" });
    }
    const co = p.match(/^\/api\/companies\/([\w-]+)(\/(agents|issues|approvals))?$/);
    if (co) {
      const c = companies.get(co[1]);
      if (!c || !c.members.has(uid)) return json(res, 403, { error: "Not a member" });
      if (!co[3]) return json(res, 200, { id: co[1], name: c.name, status: "active" });
      if (co[3] === "agents") return json(res, 200, [{ id: "a1", name: "CEO", role: "ceo", status: "idle" }]);
      if (co[3] === "issues") return json(res, 200, [{ id: "i1", identifier: "NW-1", title: "Ship it", status: "todo" }, { id: "i2", title: "Old", status: "done" }]);
      return json(res, 200, [{ id: "ap1", type: "hire_agent", status: "pending" }]);
    }
    if (p === "/api/echo") {
      // Sends back what it got, plus headers that must never reach a browser.
      return json(res, 201, { method: req.method, bytes: body.length, query: u.search, user: uid }, { "Set-Cookie": "paperclip-default.session_data=refreshed; Path=/", "X-Internal": "nope", ETag: '"v1"' });
    }
    if (p === "/api/download") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<script>alert(1)</script>");
    }
    if (p === "/api/stream") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      let n = 0;
      const t = setInterval(() => {
        res.write(Buffer.alloc(64 * 1024, n));
        if (++n === 8) {
          clearInterval(t);
          res.end();
        }
      }, 1);
      return;
    }
    json(res, 404, { error: "Not found" });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const m = new URL(req.url!, "http://engine").pathname.match(/^\/api\/companies\/([\w-]+)\/events\/ws$/);
    const uid = userOf(req);
    sockets.push({ url: req.url!, headers: req.headers });
    if (!m || !uid) return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    if (!companies.get(m[1])?.members.has(uid)) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: "hello", companyId: m[1] }));
      ws.on("message", (data, isBinary) => {
        if (data.toString() === "close-me") return ws.close(4005, "bye");
        ws.send(isBinary ? data : `echo:${data}`, { binary: isBinary });
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  publicUrl = url;

  return {
    url,
    st,
    users,
    seen,
    sockets,
    wss,
    /** Makes an organization with the given members ({ userId: role }). */
    company(id: string, name: string, members: Record<string, string>) {
      companies.set(id, { name, members: new Map(Object.entries(members)) });
    },
    userId(email: string) {
      return users.get(email)?.id ?? null;
    },
    /** Forgets every session, as if they all expired. */
    expireSessions() {
      sessions.clear();
    },
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** A small Proxmox: two users (sam is an administrator, lee isn't), a few guests, and pools. */
export function fakePve() {
  const users: Record<string, { admin: boolean }> = { "sam@pve": { admin: true }, "lee@pve": { admin: false } };
  // Proxmox's own records: users with their details, ACL entries, groups.
  const pveUsers = new Map<string, Record<string, unknown>>([["sam@pve", { userid: "sam@pve", enable: 1, firstname: "Sam" }], ["lee@pve", { userid: "lee@pve", enable: 1 }]]);
  const acl: { path: string; ugid: string; type: string; roleid: string; propagate: number }[] = [{ path: "/", ugid: "sam@pve", type: "user", roleid: "Administrator", propagate: 1 }];
  const groups = new Map<string, string>([["ops", "Operations"]]);
  const tickets = new Map<string, string>();
  const pools = new Map<string, { comment?: string; members: unknown[] }>([["existing", { members: [] }]]);
  const calls: { method: string; path: string; body?: string }[] = [];
  let n = 0;
  const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ data }) });
  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const path = u.pathname.replace("/api2/json", "");
    calls.push({ method: req.method, path, body: req.body });
    if (path === "/access/ticket") {
      const f = new URLSearchParams(req.body);
      const user = `${f.get("username")}@${f.get("realm") ?? "pve"}`;
      if (!users[user] || (f.get("password") !== "right" && tickets.get(f.get("password")!) !== user)) return { status: 401, body: "" };
      const t = `PVE:${user}:${++n}`;
      tickets.set(t, user);
      return ok({ username: user, ticket: t, CSRFPreventionToken: `c${n}` });
    }
    const user = tickets.get(decodeURIComponent((req.headers.Cookie ?? "").replace("PVEAuthCookie=", "")));
    if (!user) return { status: 401, body: "" };
    const admin = users[user].admin;
    if (path === "/access/permissions") return ok(admin ? { [u.searchParams.get("path") ?? "/"]: { "Sys.Modify": 1, "Sys.Audit": 1, "User.Modify": 1, "Permissions.Modify": 1 } } : { "/vms": { "VM.Audit": 1 } });
    const f = new URLSearchParams(req.body ?? "");
    const deny = { status: 403, body: JSON.stringify({ message: "Permission check failed\n" }) };
    if (path === "/access/users" && req.method === "GET") return ok([...pveUsers.values()].map((x) => ({ ...x, groups: x.groups ?? "" })));
    if (path === "/access/users" && req.method === "POST") {
      if (!admin) return deny;
      const id = f.get("userid")!;
      if (pveUsers.has(id)) return { status: 500, body: JSON.stringify({ message: `create user failed: user '${id}' already exists\n` }) };
      pveUsers.set(id, Object.fromEntries([...f.entries()].filter(([k]) => k !== "password").map(([k, v]) => [k, k === "enable" ? Number(v) : v])));
      users[id] = { admin: false };
      return ok(null);
    }
    const pu = path.match(/^\/access\/users\/([^/]+)$/);
    if (pu) {
      const id = decodeURIComponent(pu[1]);
      if (!pveUsers.has(id)) return { status: 500, body: JSON.stringify({ message: `no such user ('${id}')\n` }) };
      if (req.method === "GET") return ok(pveUsers.get(id));
      if (!admin) return deny;
      if (req.method === "PUT") {
        pveUsers.set(id, { ...pveUsers.get(id), ...Object.fromEntries([...f.entries()].map(([k, v]) => [k, k === "enable" ? Number(v) : v])) });
        return ok(null);
      }
      if (req.method === "DELETE") {
        pveUsers.delete(id);
        delete users[id];
        for (let i = acl.length - 1; i >= 0; i--) if (acl[i].ugid === id) acl.splice(i, 1);
        return ok(null);
      }
    }
    if (path === "/access/acl" && req.method === "GET") return ok(acl);
    if (path === "/access/acl" && req.method === "PUT") {
      if (!admin) return deny;
      for (const r of f.get("roles")!.split(",")) for (const ug of f.get("users")!.split(",")) {
        const i = acl.findIndex((a) => a.path === f.get("path") && a.ugid === ug && a.roleid === r);
        if (f.get("delete") === "1") { if (i >= 0) acl.splice(i, 1); }
        else if (i < 0) acl.push({ path: f.get("path")!, ugid: ug, type: "user", roleid: r, propagate: 1 });
      }
      return ok(null);
    }
    if (path === "/access/domains") return ok([{ realm: "pve", type: "pve" }, { realm: "pam", type: "pam" }]);
    if (path === "/access/groups" && req.method === "GET") return ok([...groups].map(([groupid, comment]) => ({ groupid, comment })));
    if (path === "/access/groups" && req.method === "POST") return admin ? (groups.set(f.get("groupid")!, f.get("comment") ?? ""), ok(null)) : deny;
    if (path === "/access/password" && req.method === "PUT") return admin && f.get("confirmation-password") === "right" ? ok(null) : deny;
    if (path === "/version") return ok({ version: "9.0.3" });
    if (path === "/nodes/pve/status") return admin ? ok({ cpu: 0.25, memory: { used: 4, total: 16 }, uptime: 100, kversion: "Linux 6" }) : { status: 403, body: "" };
    if (path === "/cluster/resources" && u.searchParams.get("type") === "storage") return ok([{ type: "storage", node: "pve", storage: "local", plugintype: "dir", content: "iso", status: "available", disk: 1, maxdisk: 10 }]);
    if (path === "/cluster/resources") return ok([{ id: "lxc/101", type: "lxc", vmid: 101, node: "pve", name: "web", status: "running", maxmem: 2048 }, { id: "node/pve", type: "node", node: "pve" }]);
    if (path === "/nodes/pve/lxc/101/config") return ok({ hostname: "web", cores: 2, memory: 2048, password: "hunter2", "ssh-public-keys": "ssh-ed25519 AAA" });
    if (path === "/nodes/pve/tasks") return ok([{ upid: "UPID:pve:1:2:3:vzdump::sam@pve:", type: "vzdump", user: "sam@pve", starttime: 1, status: "OK", endtime: 2 }]);
    if (path === "/pools" && req.method === "GET") return ok([...pools.keys()].map((poolid) => ({ poolid })));
    if (path === "/pools" && req.method === "POST") {
      if (!admin) return { status: 403, body: "" };
      const f = new URLSearchParams(req.body);
      const id = f.get("poolid")!;
      if (pools.has(id)) return { status: 500, body: JSON.stringify({ message: `pool '${id}' already exists\n` }) };
      pools.set(id, { comment: f.get("comment") ?? undefined, members: [] });
      return ok(null);
    }
    const pool = path.match(/^\/pools\/([\w-]+)$/);
    if (pool && req.method === "GET") return pools.has(pool[1]) ? ok({ members: pools.get(pool[1])!.members }) : { status: 404, body: "" };
    if (pool && req.method === "DELETE") return admin ? (pools.delete(pool[1]), ok(null)) : { status: 403, body: "" };
    return { status: 404, body: "" };
  };
  return { transport, pools, calls, pveUsers, acl, groups };
}

/**
 * A fake model provider: an HTTP server whose answer each test sets, and a fetch that sends the providers' real
 * addresses to it (recording what was asked).
 */
export async function fakeProviders() {
  const asked: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  let answer: (req: { url: string; body: string }, res: ServerResponse) => void = (_r, res) => res.end("{}");
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    answer({ url: req.url!, body: Buffer.concat(chunks).toString() }, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetchImpl = async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    asked.push({ url, method: init.method ?? "GET", headers, body: typeof init.body === "string" ? init.body : "" });
    const u = new URL(url);
    return fetch(`${local}/${u.hostname}${u.pathname}${u.search}`, init);
  };
  return {
    fetch: fetchImpl,
    asked,
    set(fn: typeof answer) {
      answer = fn;
    },
    /** Answers with these server-sent events, one per write. */
    sse(events: { event?: string; data: unknown }[], status = 200) {
      answer = (_r, res) => {
        res.writeHead(status, { "Content-Type": "text/event-stream" });
        for (const e of events) res.write(`${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`);
        res.end();
      };
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export const wsOpen = (url: string, headers: Record<string, string>) =>
  new Promise<{ ws: WebSocket; out: string[]; closed: Promise<{ code: number; reason: string }> }>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const out: string[] = [];
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (code, reason) => r({ code, reason: reason.toString() })));
    ws.on("message", (m) => out.push(m.toString()));
    ws.on("open", () => resolve({ ws, out, closed }));
    ws.on("unexpected-response", (_req, res) => reject(new Error(String(res.statusCode))));
    ws.on("error", reject);
  });

export const until = async (fn: () => boolean, ms = 2000) => {
  for (let i = 0; i < ms / 10 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
};
