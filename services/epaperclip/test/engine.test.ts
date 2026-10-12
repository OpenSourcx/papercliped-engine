import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { EngineGateway, enginePath, managedEmail, mergeCookies, SERVICE_EMAIL } from "../src/engine.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeEngine, fakePve, until, wsOpen } from "./fakes.ts";

let eng: Awaited<ReturnType<typeof fakeEngine>>;
let pve: ReturnType<typeof fakePve>;
let server: Server;
let base: string;
let stateDir: string;
let app: ReturnType<typeof createApp>;

async function boot(opts: { bootstrap?: "pending" | "ready"; engineUrl?: string; maxUploadBytes?: number } = {}) {
  eng = await fakeEngine({ bootstrap: opts.bootstrap });
  pve = fakePve();
  stateDir = mkdtempSync(join(tmpdir(), "epc-eng-"));
  const installDir = mkdtempSync(join(tmpdir(), "epc-inst-"));
  mkdirSync(join(installDir, "node_modules", "@paperclipai", "server"), { recursive: true });
  writeFileSync(join(installDir, "node_modules", "@paperclipai", "server", "package.json"), JSON.stringify({ version: "2026.1005.0" }));
  app = createApp({
    pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport },
    sessions: new SessionStore(),
    staticDir: null,
    secureCookies: false,
    maxUploadBytes: opts.maxUploadBytes ?? 4 * 1024 * 1024,
    state: new StateStore(stateDir),
    engine: { url: opts.engineUrl ?? eng.url, installDir, sleep: async () => {} },
  });
  server = createServer(app);
  server.on("upgrade", app.upgrade);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => boot());
afterEach(async () => {
  await eng.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-EPC-Request": "1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
async function signIn(username = "sam") {
  const r = await send("POST", "/api/login", { username, password: "right", realm: "pve" });
  expect(r.status).toBe(200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
/** A request with the path exactly as written (fetch would tidy away dot segments). */
const raw = (method: string, path: string, headers: Record<string, string> = {}, body?: Buffer) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const u = new URL(base);
    const req = request({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });

describe("engine accounts", () => {
  it("derives a stable, distinct managed email for each Proxmox user", () => {
    expect(managedEmail("sam@pve")).toMatch(/^sam\.pve-[0-9a-f]{8}@epaperclip\.invalid$/);
    expect(managedEmail("sam@pve")).toBe(managedEmail("sam@pve"));
    expect(managedEmail("a_b@pve")).not.toBe(managedEmail("a-b@pve"));
    expect(managedEmail("Sam@pve")).not.toBe(managedEmail("sam@pve"));
    expect(managedEmail("ünï cødé!!@ldap")).toMatch(/^[a-z0-9._-]+-[0-9a-f]{8}@epaperclip\.invalid$/);
    expect(managedEmail(`${"x".repeat(100)}@pam`).split("@")[0].length).toBeLessThanOrEqual(49);
  });

  it("creates the service account and claims a fresh engine, keeping its password only in the vault", async () => {
    await app.engine!.start(() => {});
    expect(eng.st.admin).toBe(eng.userId(SERVICE_EMAIL));
    const c = await signIn();
    const st = await (await fetch(base + "/api/engine/status", { headers: { Cookie: c } })).json() as any;
    expect(st).toEqual({ installed: true, reachable: true, ready: true, version: "2026.1005.0", bootstrap: "ready", serviceAccount: "ours" });
    const password = eng.users.get(SERVICE_EMAIL)!.password;
    expect(password.length).toBeGreaterThanOrEqual(40);
    expect(readFileSync(join(stateDir, "state.json"), "utf8")).not.toContain(password);
    // A restart with the same state doesn't make another account.
    const again = new EngineGateway({ url: eng.url, state: new StateStore(stateDir) });
    expect(await again.ensureServiceAccount()).toEqual({ state: "ours" });
    expect(eng.st.signUps).toBe(2); // the service account and sam's managed account
  });

  it("reports, without failing, an engine someone else already claimed", async () => {
    await eng.close();
    await server.close();
    await boot({ bootstrap: "ready" });
    await app.engine!.start(() => {});
    expect(eng.users.has(SERVICE_EMAIL)).toBe(false);
    const c = await signIn();
    const st = await (await fetch(base + "/api/engine/status", { headers: { Cookie: c } })).json() as any;
    expect(st).toMatchObject({ reachable: true, ready: true, bootstrap: "ready", serviceAccount: "other" });
    expect(st.error).toContain("another account");
    // People still get managed accounts.
    expect((await fetch(base + "/engine/api/cli-auth/me", { headers: { Cookie: c } })).status).toBe(200);
  });

  it("waits for an engine that isn't up yet, backing off, and says so in the status", async () => {
    const delays: number[] = [];
    const g = new EngineGateway({ url: "http://127.0.0.1:9", state: new StateStore(null), sleep: async (ms) => void (delays.push(ms), delays.length >= 6 && g.stop()) });
    await g.start(() => {});
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(await g.status()).toMatchObject({ reachable: false, ready: false, bootstrap: "pending", error: expect.stringContaining("isn't installed") });
  });

  it("makes a managed account on sign-in and reuses its engine session across browser sessions", async () => {
    await signIn();
    const email = managedEmail("sam@pve");
    await until(() => eng.users.has(email));
    expect(eng.users.get(email)!.name).toBe("sam");
    const before = { ups: eng.st.signUps, ins: eng.st.signIns };
    const c2 = await signIn();
    const me = await (await fetch(base + "/engine/api/cli-auth/me", { headers: { Cookie: c2 } })).json() as any;
    expect(me.userId).toBe(eng.userId(email));
    expect(eng.st.signUps).toBe(before.ups);
    expect(eng.st.signIns).toBe(before.ins);
  });

  it("signs in again when the engine session expires, waiting out the engine's rate limit", async () => {
    const c = await signIn();
    await until(() => eng.users.has(managedEmail("sam@pve")));
    eng.expireSessions();
    eng.st.limitSignIns = 2;
    const r = await fetch(base + "/engine/api/cli-auth/me", { headers: { Cookie: c } });
    expect(r.status).toBe(200);
    expect(eng.st.signIns).toBe(3);
    // And a small write is replayed after renewing, so the person never sees the expiry.
    eng.expireSessions();
    const w = await send("POST", "/engine/api/echo", { x: 1 }, { Cookie: c });
    expect(w.status).toBe(201);
    expect((await w.json() as any).bytes).toBe(7);
  });

  it("refuses, clearly, when the engine has an account for this person that the vault can't open", async () => {
    eng.users.set(managedEmail("lee@pve"), { id: "u_x", password: "someone-elses", name: "lee" });
    const c = await signIn("lee");
    const r = await fetch(base + "/engine/api/cli-auth/me", { headers: { Cookie: c } });
    expect(r.status).toBe(409);
    expect((await r.json() as any).code).toBe("engine_account_conflict");
  });

  it("folds refreshed and cleared cookies into the stored session", () => {
    expect(mergeCookies("a=1; b=2", ["b=3; Path=/", "a=; Max-Age=0"])).toBe("b=3");
  });
});

describe("the /engine/api proxy", () => {
  it("needs a session, and the request header and same-site Origin for changes", async () => {
    expect((await fetch(base + "/engine/api/companies")).status).toBe(401);
    const c = await signIn();
    expect((await fetch(base + "/engine/api/echo", { method: "POST", headers: { Cookie: c, "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await send("POST", "/engine/api/echo", {}, { Cookie: c, Origin: "https://evil.example" })).status).toBe(403);
    expect((await send("POST", "/engine/api/echo", {}, { Cookie: c, Origin: base })).status).toBe(201);
  });

  it("forwards only allowed headers, as the person's engine account, and returns only safe ones", async () => {
    const c = await signIn();
    const r = await fetch(base + "/engine/api/echo?a=1&b=two", {
      method: "PUT",
      headers: { Cookie: `${c}; paperclip-default.session_token=browser-forged`, "X-EPC-Request": "1", "Content-Type": "application/json", Authorization: "Bearer agent-key", "X-Paperclip-Cloud-User": "root", "X-Forwarded-Host": "evil", Referer: "https://evil.example/", "Accept-Language": "nl", "X-Paperclip-Route": "/issues" },
      body: "{}",
    });
    expect(r.status).toBe(201);
    expect((await r.json() as any).query).toBe("?a=1&b=two");
    const got = eng.seen.filter((x) => x.url.startsWith("/api/echo")).at(-1)!;
    expect(got.method).toBe("PUT");
    expect(got.headers.cookie).toMatch(/^paperclip-default\.session_token=[0-9a-f]+$/);
    expect(got.headers.cookie).not.toContain("epc_session");
    expect(got.headers.cookie).not.toContain("forged");
    expect(got.headers.origin).toBe(eng.url);
    for (const h of ["authorization", "x-paperclip-cloud-user", "x-forwarded-host", "referer", "x-epc-request"]) expect(got.headers[h]).toBeUndefined();
    expect(got.headers["accept-language"]).toBe("nl");
    expect(got.headers["x-paperclip-route"]).toBe("/issues");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("x-internal")).toBeNull();
    expect(r.headers.get("etag")).toBe('"v1"');
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("streams large bodies both ways, within the upload cap", async () => {
    const c = await signIn();
    const big = Buffer.alloc(3 * 1024 * 1024, 1);
    const up = await raw("POST", "/engine/api/echo", { Cookie: c, "X-EPC-Request": "1", "Content-Type": "application/octet-stream", "Content-Length": String(big.length) }, big);
    expect(up.status).toBe(201);
    expect(JSON.parse(up.body).bytes).toBe(big.length);
    const tooBig = await raw("POST", "/engine/api/echo", { Cookie: c, "X-EPC-Request": "1", "Content-Type": "application/octet-stream", "Content-Length": String(5 * 1024 * 1024) }, Buffer.alloc(5 * 1024 * 1024));
    expect(tooBig.status).toBe(413);
    const down = await fetch(base + "/engine/api/stream", { headers: { Cookie: c } });
    expect((await down.arrayBuffer()).byteLength).toBe(8 * 64 * 1024);
  });

  it("refuses paths that climb out, encoded slashes, the account and bootstrap areas, and odd methods", async () => {
    const c = await signIn();
    for (const p of ["/engine/api/../api/health", "/engine/api/%2e%2e/x", "/engine/api/a%2Fb", "/engine/api/a%5cb", "/engine/api//x", "/engine/api/x%00"]) expect((await raw("GET", p, { Cookie: c })).status, p).toBe(400);
    for (const p of ["/engine/api/auth/sign-out", "/engine/api/AUTH/get-session", "/engine/api/%61uth/x", "/engine/api/bootstrap/claim", "/engine/api/cli-auth/challenges", "/engine/x", "/engine"]) expect((await raw("POST", p, { Cookie: c, "X-EPC-Request": "1" })).status, p).toBe(404);
    expect((await raw("OPTIONS", "/engine/api/companies", { Cookie: c, "X-EPC-Request": "1" })).status).toBe(405);
    expect(eng.seen.some((x) => x.url.includes("auth/sign-out") || x.url.includes("bootstrap/claim") || x.url.includes(".."))).toBe(false);
  });

  it("makes active content from the engine download instead of render", async () => {
    const c = await signIn();
    const r = await fetch(base + "/engine/api/download", { headers: { Cookie: c } });
    expect(r.headers.get("content-disposition")).toBe("attachment");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
  });

  it("answers 503 engine_unavailable when the engine is down", async () => {
    const c = await signIn();
    await until(() => eng.users.has(managedEmail("sam@pve")));
    await eng.close();
    const r = await fetch(base + "/engine/api/companies", { headers: { Cookie: c } });
    expect(r.status).toBe(503);
    expect((await r.json() as any).code).toBe("engine_unavailable");
    const st = await (await fetch(base + "/api/engine/status", { headers: { Cookie: c } })).json() as any;
    expect(st).toMatchObject({ reachable: false, ready: false });
  });
});

describe("the live-events socket", () => {
  const wsBase = () => base.replace("http", "ws");

  it("relays an organization's events as the person, without passing on a token", async () => {
    const c = await signIn();
    await until(() => eng.users.has(managedEmail("sam@pve")));
    eng.company("c1", "Northwind", { [eng.userId(managedEmail("sam@pve"))!]: "owner" });
    const { ws, out } = await wsOpen(`${wsBase()}/engine/api/companies/c1/events/ws?token=agent-key`, { Cookie: c, Origin: base });
    ws.send("hi");
    await until(() => out.length >= 2);
    expect(out).toEqual([JSON.stringify({ type: "hello", companyId: "c1" }), "echo:hi"]);
    const up = eng.sockets.at(-1)!;
    expect(up.url).toBe("/api/companies/c1/events/ws");
    expect(up.headers.cookie).toMatch(/^paperclip-default\.session_token=/);
    expect(up.headers.origin).toBe(eng.url);
    ws.close();
    await until(() => eng.wss.clients.size === 0);
    expect(eng.wss.clients.size).toBe(0);
  });

  it("passes the engine's close on to the browser", async () => {
    const c = await signIn();
    await until(() => eng.users.has(managedEmail("sam@pve")));
    eng.company("c1", "Northwind", { [eng.userId(managedEmail("sam@pve"))!]: "viewer" });
    const { ws, closed } = await wsOpen(`${wsBase()}/engine/api/companies/c1/events/ws`, { Cookie: c, Origin: base });
    ws.send("close-me");
    expect(await closed).toEqual({ code: 4005, reason: "bye" });
  });

  it("refuses signed-out, cross-site, non-member and unknown sockets before upgrading", async () => {
    const c = await signIn();
    await until(() => eng.users.has(managedEmail("sam@pve")));
    eng.company("c2", "Other", {});
    await expect(wsOpen(`${wsBase()}/engine/api/companies/c2/events/ws`, { Origin: base })).rejects.toThrow("401");
    await expect(wsOpen(`${wsBase()}/engine/api/companies/c2/events/ws`, { Cookie: c, Origin: "https://evil.example" })).rejects.toThrow("403");
    await expect(wsOpen(`${wsBase()}/engine/api/companies/c2/events/ws`, { Cookie: c, Origin: base })).rejects.toThrow("403");
    await expect(wsOpen(`${wsBase()}/engine/api/companies/c2/other`, { Cookie: c, Origin: base })).rejects.toThrow("404");
  });
});

describe("resource groups", () => {
  async function owner(username = "sam", role = "owner") {
    const c = await signIn(username);
    const email = managedEmail(`${username}@pve`);
    await until(() => eng.users.has(email));
    eng.company("c1", "Northwind Labs", { [eng.userId(email)!]: role });
    return c;
  }
  const limits = { name: "Northwind Labs", cores: 8, memoryMb: 16384, diskGb: 200, maxGuests: 5 };

  it("creates a pool as the person and stores the limits; members can list it", async () => {
    const c = await owner();
    const r = await send("PUT", "/api/resource-groups/c1", limits, { Cookie: c });
    expect(r.status).toBe(200);
    const { group } = await r.json() as any;
    expect(group).toMatchObject({ companyId: "c1", pool: "epc-northwind-labs", cores: 8, maxGuests: 5, updatedBy: "sam@pve" });
    expect(pve.pools.get("epc-northwind-labs")!.comment).toBe("ePaperclip organization: Northwind Labs");
    const again = await send("PUT", "/api/resource-groups/c1", { ...limits, cores: 16 }, { Cookie: c });
    expect((await again.json() as any).group).toMatchObject({ pool: "epc-northwind-labs", cores: 16 });
    expect(pve.calls.filter((x) => x.method === "POST" && x.path === "/pools")).toHaveLength(1);
    const list = await (await fetch(base + "/api/resource-groups", { headers: { Cookie: c } })).json() as any;
    expect(list.groups).toEqual([expect.objectContaining({ companyId: "c1", pool: "epc-northwind-labs", cores: 16 })]);
  });

  it("picks a free pool name when the obvious one is taken", async () => {
    pve.pools.set("epc-northwind-labs", { members: [] });
    const c = await owner();
    expect((await (await send("PUT", "/api/resource-groups/c1", limits, { Cookie: c })).json() as any).group.pool).toBe("epc-northwind-labs-2");
  });

  it("is only for the organization's owners and admins, and checks the limits", async () => {
    const c = await signIn();
    await until(() => eng.users.has(managedEmail("sam@pve")));
    const notMember = await send("PUT", "/api/resource-groups/c1", limits, { Cookie: c });
    expect(notMember.status).toBe(403);
    expect((await notMember.json() as any).code).toBe("not_member");
    eng.company("c1", "Northwind Labs", { [eng.userId(managedEmail("sam@pve"))!]: "viewer" });
    expect((await send("PUT", "/api/resource-groups/c1", limits, { Cookie: c })).status).toBe(403);
    eng.company("c1", "Northwind Labs", { [eng.userId(managedEmail("sam@pve"))!]: "admin" });
    expect((await send("PUT", "/api/resource-groups/c1", { ...limits, cores: 0 }, { Cookie: c })).status).toBe(400);
    expect((await fetch(base + "/api/resource-groups/c1", { method: "PUT", headers: { Cookie: c, "Content-Type": "application/json" }, body: JSON.stringify(limits) })).status).toBe(403);
    expect(pve.pools.size).toBe(1);
  });

  it("leaves pool creation to Proxmox's permissions", async () => {
    const c = await owner("lee");
    const r = await send("PUT", "/api/resource-groups/c1", limits, { Cookie: c });
    expect(r.status).toBe(403);
    expect(await (await fetch(base + "/api/resource-groups", { headers: { Cookie: c } })).json() as any).toEqual({ groups: [] });
  });

  it("removes the mapping, and the pool only while it is empty", async () => {
    const c = await owner();
    await send("PUT", "/api/resource-groups/c1", limits, { Cookie: c });
    pve.pools.get("epc-northwind-labs")!.members.push({ vmid: 101 });
    expect(await (await send("DELETE", "/api/resource-groups/c1", undefined, { Cookie: c })).json() as any).toEqual({ ok: true, pool: "epc-northwind-labs", poolRemoved: false });
    expect(pve.pools.has("epc-northwind-labs")).toBe(true);
    await send("PUT", "/api/resource-groups/c1", { ...limits, name: "Second" }, { Cookie: c });
    pve.pools.get("epc-second")!.members.length = 0;
    expect((await (await send("DELETE", "/api/resource-groups/c1", undefined, { Cookie: c })).json() as any).poolRemoved).toBe(true);
    expect(pve.pools.has("epc-second")).toBe(false);
    expect((await send("DELETE", "/api/resource-groups/c1", undefined, { Cookie: c })).status).toBe(404);
  });
});

describe("engine paths", () => {
  it("maps /engine/api to /api and keeps the query as sent", () => {
    expect(enginePath("/engine/api/companies/c1/issues?status=todo&q=a%20b")).toBe("/api/companies/c1/issues?status=todo&q=a%20b");
    expect(enginePath("/engine/api/cli-auth/me")).toBe("/api/cli-auth/me");
    expect(() => enginePath("/engine/api/x?a=\u0001")).toThrow();
  });
});
