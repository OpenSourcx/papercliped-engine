import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditCsv, filterAudit, auditQuery, parseProps, readPolicy, webauthnProp, u2fProp, aclCovers } from "../src/features/access-admin.ts";
import { startAccessApp } from "./access-harness.ts";

let h: Awaited<ReturnType<typeof startAccessApp>>;
let sam: string;
let lee: string;
beforeEach(async () => {
  h = await startAccessApp();
  sam = await h.signIn("sam");
  lee = await h.signIn("lee");
});
afterEach(async () => {
  await h.close();
});
const j = async (r: Response) => (await r.json()) as any;
const get = async (path: string, cookie = sam) => j(await h.call("GET", path, { cookie }));
const post = (path: string, body: unknown, cookie = sam) => h.call("POST", path, { cookie }, body);

describe("your own password", () => {
  it("changes it with the current one, ends your other sessions, keeps this one", async () => {
    const other = await h.signIn("sam");
    const r = await post("/api/access/password", { currentPassword: "right", password: "a-new-password" });
    expect(r.status).toBe(200);
    expect(await j(r)).toMatchObject({ ok: true, otherSessionsEnded: 1 });
    expect(h.pve.users.get("sam@pve")!.password).toBe("a-new-password");
    expect((await h.call("GET", "/api/me", { cookie: sam })).status).toBe(200);
    expect((await h.call("GET", "/api/me", { cookie: other })).status).toBe(401);
    expect((await get("/api/access/audit")).entries[0]).toMatchObject({ action: "password.change", target: "sam@pve" });
  });

  it("refuses a wrong current password, then locks the guessing after five tries", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await post("/api/access/password", { currentPassword: "wrong", password: "a-new-password" }, lee);
      expect(r.status).toBe(403);
      expect((await j(r)).code).toBe("bad_current_password");
    }
    const locked = await post("/api/access/password", { currentPassword: "right", password: "a-new-password" }, lee);
    expect(locked.status).toBe(429);
    expect(h.pve.users.get("lee@pve")!.password).toBe("right");
  });

  it("checks the new password and the realm before asking Proxmox", async () => {
    const before = h.pve.calls.length;
    for (const body of [{ currentPassword: "right", password: "short" }, { currentPassword: "right", password: "right" }, { password: "a-new-password" }]) expect((await post("/api/access/password", body)).status).toBe(400);
    expect(h.pve.calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
    h.pve.realms.set("corp", { realm: "corp", type: "ldap" });
    h.pve.users.set("dir@corp", { userid: "dir@corp", enable: 1, groups: [], password: "right" });
    const ldap = await h.signIn("dir@corp").catch(() => null);
    if (ldap) expect((await j(await post("/api/access/password", { currentPassword: "right", password: "a-new-password" }, ldap))).code).toBe("managed_elsewhere");
  });
});

describe("sessions", () => {
  it("lists your sessions, marks this one, ends another and refuses to end the current one", async () => {
    const second = await h.signIn("sam");
    const list = await get("/api/access/sessions");
    expect(list.sessions.map((s: any) => s.username)).toEqual(["sam@pve", "sam@pve"]);
    expect(list.sessions.filter((s: any) => s.current)).toHaveLength(1);
    expect(list.canManageOthers).toBe(true);
    for (const s of list.sessions) expect(JSON.stringify(s)).not.toMatch(/ticket|csrf|PVE:/);
    const other = list.sessions.find((s: any) => !s.current);
    const mine = list.sessions.find((s: any) => s.current);
    expect((await h.call("DELETE", `/api/access/sessions/${mine.handle}`, { cookie: sam })).status).toBe(400);
    expect((await h.call("DELETE", `/api/access/sessions/${other.handle}`, { cookie: sam })).status).toBe(200);
    expect((await h.call("GET", "/api/me", { cookie: second })).status).toBe(401);
    expect((await h.call("DELETE", `/api/access/sessions/${other.handle}`, { cookie: sam })).status).toBe(404);
  });

  it("ends all your other sessions at once", async () => {
    await h.signIn("sam");
    await h.signIn("sam");
    const r = await j(await post("/api/access/sessions/revoke-others", {}));
    expect(r.ended).toBe(2);
    expect((await get("/api/access/sessions")).sessions).toHaveLength(1);
  });

  it("lets a non-administrator see and end only their own, and an administrator end anyone's", async () => {
    const mine = await get("/api/access/sessions", lee);
    expect(mine.sessions).toHaveLength(1);
    expect(mine.scope).toBe("mine");
    expect((await h.call("GET", "/api/access/sessions?all=1", { cookie: lee })).status).toBe(403);
    const all = await get("/api/access/sessions?all=1");
    expect(all.sessions.map((s: any) => s.username).sort()).toEqual(["lee@pve", "sam@pve"]);
    const leeHandle = all.sessions.find((s: any) => s.username === "lee@pve").handle;
    // lee can't end sam's session, even knowing a handle
    const samHandle = all.sessions.find((s: any) => s.username === "sam@pve").handle;
    expect((await h.call("DELETE", `/api/access/sessions/${samHandle}`, { cookie: lee })).status).toBe(403);
    expect((await h.call("DELETE", `/api/access/sessions/${leeHandle}`, { cookie: sam })).status).toBe(200);
    expect((await h.call("GET", "/api/me", { cookie: lee })).status).toBe(401);
  });

  it("an administrator ends every session of one person, and others can't", async () => {
    const lee2 = await h.signIn("lee");
    expect((await post("/api/access/sessions/revoke-user", { userid: "lee@pve" }, lee)).status).toBe(403);
    const r = await j(await post("/api/access/sessions/revoke-user", { userid: "lee@pve" }));
    expect(r.ended).toBe(2);
    expect((await h.call("GET", "/api/me", { cookie: lee2 })).status).toBe(401);
    expect((await post("/api/access/sessions/revoke-user", { userid: "sam@pve" })).status).toBe(400);
  });
});

describe("audit log", () => {
  it("records sign-ins and filters by actor, action, text and time", async () => {
    h.clock.t += 1000;
    await post("/api/access/groups", { groupid: "dev" });
    h.clock.t += 1000;
    await post("/api/access/groups", { groupid: "ops2" }, lee).catch(() => {});
    const all = await get("/api/access/audit");
    expect(all.total).toBeGreaterThan(2);
    expect(all.actions).toEqual(expect.arrayContaining(["session.sign-in", "group.create"]));
    expect(all.actors).toEqual(["lee@pve", "sam@pve"]);
    const groups = await get("/api/access/audit?action=group.create");
    expect(groups.entries.every((e: any) => e.action === "group.create")).toBe(true);
    expect(groups.total).toBe(1);
    expect((await get("/api/access/audit?actor=lee@pve")).entries.every((e: any) => e.actor === "lee@pve")).toBe(true);
    expect((await get("/api/access/audit?q=dev")).entries.map((e: any) => e.target)).toEqual(["dev"]);
    expect((await get(`/api/access/audit?from=${h.clock.t - 1500}`)).entries.every((e: any) => e.at >= h.clock.t - 1500)).toBe(true);
    expect((await get("/api/access/audit?limit=1&offset=1")).entries).toHaveLength(1);
    expect((await h.call("GET", "/api/access/audit", { cookie: lee })).status).toBe(403);
  });

  it("exports CSV and JSON of the filtered entries, neutralising spreadsheet formulas", async () => {
    await post("/api/access/groups", { groupid: "dev", comment: "=HYPERLINK(1)" });
    h.state.setSetting("audit", [...(h.state.getSetting<any[]>("audit") ?? []), { at: h.clock.t, actor: "=cmd|x", action: "test.formula", detail: 'a "quoted", value' }]);
    const csv = await h.call("GET", "/api/access/audit/export?format=csv&action=test.formula", { cookie: sam });
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/attachment; filename="epaperclip-audit\.csv"/);
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe("time,actor,action,target,detail,address");
    expect(text).toContain("'=cmd|x");
    expect(text).toContain('"a ""quoted"", value"');
    const json = await j(await h.call("GET", "/api/access/audit/export?format=json&action=group.create", { cookie: sam }));
    expect(json.entries).toHaveLength(1);
    expect((await get("/api/access/audit?action=audit.export")).total).toBe(2);
    expect((await h.call("GET", "/api/access/audit/export", { cookie: lee })).status).toBe(403);
  });

  it("parses filters strictly", () => {
    expect(() => auditQuery(new URLSearchParams("from=abc"))).toThrow();
    expect(auditQuery(new URLSearchParams("limit=999999")).limit).toBe(2000);
    expect(filterAudit([{ at: 1, actor: "a", action: "x.y" }, { at: 2, actor: "b", action: "x" }], { action: "x", limit: 10, offset: 0 }).map((e) => e.at)).toEqual([2, 1]);
    expect(auditCsv([{ at: 0, actor: "a", action: "b" }])).toBe("time,actor,action,target,detail,address\r\n1970-01-01T00:00:00.000Z,a,b,,,\r\n");
  });
});

describe("sign-in policy", () => {
  it("reads and writes WebAuthn, U2F and the consent notice in Proxmox, and keeps a copy of the notice for the login page", async () => {
    expect((await j(await fetch(h.base + "/api/login/banner"))).text).toBe("");
    const put = await h.call("PUT", "/api/access/signin-policy", { cookie: sam }, { webauthn: { rp: "Acme", id: "epc.example.org", origin: "https://epc.example.org", allowSubdomains: false }, u2f: { appid: "https://epc.example.org" }, consentText: "Authorised use only." });
    expect(put.status).toBe(200);
    expect(h.pve.options.webauthn).toBe("rp=Acme,id=epc.example.org,origin=https://epc.example.org,allow-subdomains=0");
    expect(h.pve.options.u2f).toBe("appid=https://epc.example.org");
    const p = await get("/api/access/signin-policy");
    expect(p).toMatchObject({ webauthn: { rp: "Acme", id: "epc.example.org", origin: "https://epc.example.org", allowSubdomains: false }, u2f: { appid: "https://epc.example.org", origin: null }, consentText: "Authorised use only.", canManage: true });
    expect((await get("/api/login/banner", "")).text).toBe("Authorised use only.");
    await h.call("PUT", "/api/access/signin-policy", { cookie: sam }, { webauthn: null, consentText: null });
    expect(h.pve.options.webauthn).toBeUndefined();
    expect((await get("/api/login/banner", "")).text).toBe("");
  });

  it("validates before sending, and only administrators change it", async () => {
    const before = h.pve.calls.length;
    for (const body of [{ webauthn: { rp: "A", id: "x y", origin: "https://a.b" } }, { webauthn: { rp: "A,B", id: "a.b", origin: "https://a.b" } }, { webauthn: { rp: "A", id: "a.b", origin: "http://a.b" } }, { u2f: {} }, { consentText: 5 }, {}]) {
      expect((await h.call("PUT", "/api/access/signin-policy", { cookie: sam }, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.pve.calls.slice(before).filter((c) => c.method === "PUT")).toEqual([]);
    expect((await h.call("PUT", "/api/access/signin-policy", { cookie: lee }, { consentText: "x" })).status).toBe(403);
  });

  it("builds and parses Proxmox property strings", () => {
    expect(parseProps("rp=A,id=b.c,allow-subdomains=0")).toEqual({ rp: "A", id: "b.c", "allow-subdomains": "0" });
    expect(readPolicy({ webauthn: "rp=A,id=b.c,origin=https://b.c" }).webauthn).toEqual({ rp: "A", id: "b.c", origin: "https://b.c", allowSubdomains: true });
    expect(webauthnProp({ rp: "A", id: "b.c", origin: "http://localhost:8080" })).toBe("rp=A,id=b.c,origin=http://localhost:8080");
    expect(u2fProp({ origin: "https://x.y", appid: "https://x.y/app" })).toBe("appid=https://x.y/app,origin=https://x.y");
  });
});

describe("security keys (WebAuthn)", () => {
  it("begins a registration, then finishes it with the browser's answer", async () => {
    const b = await j(await post("/api/access/webauthn/sam@pve/begin", { description: "Desk key", password: "right" }));
    const options = JSON.parse(b.challenge);
    expect(options.publicKey.challenge).toMatch(/^chal/);
    const cred = { id: "abc", rawId: "abc", type: "public-key", response: { attestationObject: "x", clientDataJSON: "y" } };
    const done = await post("/api/access/webauthn/sam@pve/finish", { challenge: options.publicKey.challenge, value: JSON.stringify(cred), description: "Desk key", password: "right" });
    expect(done.status).toBe(200);
    expect(h.pve.tfa.get("sam@pve")).toEqual([expect.objectContaining({ type: "webauthn" })]);
    expect((await get("/api/access/audit?action=tfa.add")).entries[0]).toMatchObject({ detail: "webauthn", target: "sam@pve" });
  });

  it("refuses a stale challenge, a malformed answer and an API token", async () => {
    expect((await post("/api/access/webauthn/sam@pve/finish", { challenge: "nope", value: "{}" })).status).toBe(400);
    expect((await post("/api/access/webauthn/sam@pve/finish", { challenge: "chal" + "A".repeat(20), value: "not json" })).status).toBe(400);
    expect((await post("/api/access/webauthn/sam@pve/finish", { challenge: "chal" + "A".repeat(20) + "9", value: JSON.stringify({ id: "a", type: "public-key" }) })).status).toBe(400);
    const t = await j(await post("/api/access/epc-tokens", { name: "ci", expiresInDays: 5 }));
    expect((await h.call("POST", "/api/access/webauthn/sam@pve/begin", { bearer: t.token }, {})).status).toBe(403);
  });
});

describe("effective permissions explorer", () => {
  it("shows a user's entries and effective privileges, each with the entries that grant it", async () => {
    await post("/api/access/groups", { groupid: "dev", members: ["lee@pve"] });
    await post("/api/access/acl", { path: "/vms", roles: ["PVEAuditor"], groups: ["dev"] });
    await post("/api/access/acl", { path: "/vms/101", roles: ["PVEVMAdmin"], users: ["lee@pve"], propagate: false });
    const r = await get("/api/access/explorer?userid=lee@pve");
    expect(r.groups).toEqual(["dev"]);
    expect(r.entries.map((e: any) => `${e.path} ${e.role} ${e.source}`)).toEqual(["/vms PVEAuditor group dev", "/vms/101 PVEVMAdmin the user"]);
    const at = r.effective.find((e: any) => e.path === "/vms/101");
    expect(at.privileges).toEqual(expect.arrayContaining(["VM.Audit", "VM.PowerMgmt"]));
    expect(at.grants["VM.PowerMgmt"]).toEqual([{ role: "PVEVMAdmin", at: "/vms/101", source: "the user" }]);
    expect(at.grants["VM.Audit"]).toEqual(expect.arrayContaining([{ role: "PVEAuditor", at: "/vms", source: "group dev" }]));
    expect(r.effective.find((e: any) => e.path === "/vms").privileges).not.toContain("VM.PowerMgmt");
  });

  it("explains a privilege-separated token as having only its own permissions", async () => {
    const t = await j(await post("/api/access/users/sam@pve/tokens", { tokenid: "robot", privsep: true }));
    await post("/api/access/acl", { path: "/storage", roles: ["PVEAuditor"], tokens: [t.fullTokenid] });
    const r = await get(`/api/access/explorer?userid=${encodeURIComponent(t.fullTokenid)}`);
    expect(r).toMatchObject({ isToken: true, privsep: true, groups: [] });
    expect(r.entries).toEqual([expect.objectContaining({ path: "/storage", role: "PVEAuditor" })]);
    expect(r.effective.map((e: any) => e.path)).toEqual(["/storage"]);
    expect(r.note).toMatch(/privilege-separated/);
  });

  it("validates the subject and shows Proxmox's refusal to people who may not look", async () => {
    expect((await h.call("GET", "/api/access/explorer?userid=nonsense", { cookie: sam })).status).toBe(400);
    expect((await h.call("GET", "/api/access/explorer?userid=sam@pve", { cookie: lee })).status).toBe(403);
    expect(aclCovers("/vms", true, "/vms/1")).toBe(true);
    expect(aclCovers("/vms", false, "/vms/1")).toBe(false);
    expect(aclCovers("/", true, "/anything")).toBe(true);
    expect(aclCovers("/vm", true, "/vms/1")).toBe(false);
  });
});

describe("scheduled realm sync jobs", () => {
  beforeEach(() => {
    h.pve.realms.set("corp", { realm: "corp", type: "ldap", server1: "ldap.example" });
  });

  it("creates, lists, edits and deletes a job, and previews the schedule", async () => {
    const c = await post("/api/access/sync-jobs", { id: "nightly", realm: "corp", schedule: "daily", scope: "both", enableNew: true, removeVanished: ["acl", "entry"], comment: "Nightly" });
    expect(c.status).toBe(200);
    const list = (await get("/api/access/sync-jobs")).jobs;
    expect(list).toEqual([expect.objectContaining({ id: "nightly", realm: "corp", schedule: "daily", scope: "both", enabled: true, enableNew: true, removeVanished: ["acl", "entry"], comment: "Nightly", nextRun: 1_800_086_400 })]);
    expect((await h.call("PUT", "/api/access/sync-jobs/nightly", { cookie: sam }, { enabled: false, comment: "" })).status).toBe(200);
    expect(h.pve.jobs.get("nightly")).toMatchObject({ enabled: 0, schedule: "daily" });
    expect(h.pve.jobs.get("nightly")!.comment).toBeUndefined();
    expect((await get("/api/access/sync-jobs/preview?schedule=daily")).times).toHaveLength(5);
    expect((await h.call("GET", "/api/access/sync-jobs/preview?schedule=bogus!", { cookie: sam })).status).toBe(400);
    expect((await h.call("DELETE", "/api/access/sync-jobs/nightly", { cookie: sam })).status).toBe(200);
    expect(h.pve.jobs.size).toBe(0);
    expect((await get("/api/access/audit?action=sync-job")).entries.map((e: any) => e.action).sort()).toEqual(["sync-job.create", "sync-job.delete", "sync-job.update"]);
  });

  it("validates jobs before sending and shows Proxmox's reasons", async () => {
    const before = h.pve.calls.length;
    for (const body of [{ id: "1bad", realm: "corp", schedule: "daily" }, { id: "ok1", realm: "corp" }, { id: "ok1", realm: "corp", schedule: "daily; rm" }, { id: "ok1", realm: "corp", schedule: "daily", scope: "all" }, { id: "ok1", realm: "corp", schedule: "daily", removeVanished: ["everything"] }]) {
      expect((await post("/api/access/sync-jobs", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.pve.calls.slice(before).filter((c) => c.method === "POST")).toEqual([]);
    const pam = await post("/api/access/sync-jobs", { id: "bad1", realm: "pve", schedule: "daily" });
    expect(pam.status).toBe(400);
    expect((await post("/api/access/sync-jobs", { id: "nope", realm: "corp", schedule: "daily" }, lee)).status).toBe(403);
  });
});

describe("renewing and rotating ePaperclip API tokens", () => {
  it("renews a token for another stretch, in Proxmox and here", async () => {
    const t = await j(await post("/api/access/epc-tokens", { name: "ci", expiresInDays: 2 }));
    const day = 86_400_000;
    h.clock.t += 3 * day;
    expect((await h.call("GET", "/api/me", { bearer: t.token })).status).toBe(401);
    sam = await h.signIn("sam"); // the browser session idled out meanwhile
    const r = await post(`/api/access/epc-tokens/${t.record.id}/renew`, { expiresInDays: 30 });
    expect(r.status).toBe(200);
    expect((await j(r)).record.expiresAt).toBe(h.clock.t + 30 * day);
    expect(h.pve.tokens.get("sam@pve")!.get(t.record.pveName)!.expire).toBe(Math.floor((h.clock.t + 30 * day) / 1000));
    expect((await h.call("GET", "/api/me", { bearer: t.token })).status).toBe(200);
    expect((await post(`/api/access/epc-tokens/${t.record.id}/renew`, { expiresInDays: 400 })).status).toBe(400);
    expect((await get("/api/access/audit?action=token.renew")).total).toBe(1);
  });

  it("rotates the secret: the old string stops working at once, the new one works", async () => {
    const t = await j(await post("/api/access/epc-tokens", { name: "ci", expiresInDays: 10 }));
    const r = await j(await post(`/api/access/epc-tokens/${t.record.id}/rotate`, { expiresInDays: 20 }));
    expect(r.token).toMatch(new RegExp(`^epc_${t.record.id}_`));
    expect(r.token).not.toBe(t.token);
    expect(JSON.stringify(r)).not.toMatch(/"salt"|"hash"/);
    expect((await h.call("GET", "/api/me", { bearer: t.token })).status).toBe(401);
    expect((await h.call("GET", "/api/me", { bearer: r.token })).status).toBe(200);
  });

  it("is for the owner or an administrator, and never for a token", async () => {
    const t = await j(await post("/api/access/epc-tokens", { name: "ci", expiresInDays: 10 }, lee));
    expect((await post(`/api/access/epc-tokens/${t.record.id}/renew`, {}, lee)).status).toBe(200);
    expect((await post(`/api/access/epc-tokens/${t.record.id}/rotate`, {})).status).toBe(200); // sam is an administrator
    const other = await j(await post("/api/access/epc-tokens", { name: "sam-ci", expiresInDays: 10 }));
    expect((await post(`/api/access/epc-tokens/${other.record.id}/renew`, {}, lee)).status).toBe(403);
    expect((await h.call("POST", `/api/access/epc-tokens/${other.record.id}/renew`, { bearer: other.token }, {})).status).toBe(403);
    expect((await post("/api/access/epc-tokens/0123456789abcdef/renew", {})).status).toBe(404);
  });
});

describe("OpenID Connect sign-in", () => {
  const start = async (realm = "sso") => {
    const r = await h.call("POST", "/api/login/openid/start", { headers: { "X-EPC-Request": "1" } }, { realm });
    return r;
  };
  const cookieOf = (r: Response) => r.headers.get("set-cookie")!.split(";")[0];
  beforeEach(() => {
    h.pve.realms.set("sso", { realm: "sso", type: "openid", "issuer-url": "https://idp.example/auth", "client-id": "epc" });
    h.pve.openid.codes.set("good", "oidc-ann@sso");
  });

  it("sends the person to the provider, then signs them in with the code it returns", async () => {
    const s = await start();
    expect(s.status).toBe(200);
    const { url } = await j(s);
    expect(url).toMatch(/^https:\/\/idp\.example\/auth\?/);
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(h.base);
    const state = new URL(url).searchParams.get("state")!;
    const fin = await h.call("POST", "/api/login/openid/finish", { headers: { "X-EPC-Request": "1", Cookie: cookieOf(s) } }, { code: "good", state });
    expect(fin.status).toBe(200);
    expect((await j(fin)).user.username).toBe("oidc-ann@sso");
    const cookies = fin.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("epc_session"))!.split(";")[0];
    expect(cookies.find((c) => c.startsWith("epc_oidc="))).toMatch(/Max-Age=0/);
    expect((await h.call("GET", "/api/me", { cookie: session })).status).toBe(200);
    const sessions = await get("/api/access/sessions", session);
    expect(sessions.sessions[0].via).toBe("openid");
    expect((await get("/api/access/audit?action=session.sign-in")).entries.some((e: any) => e.actor === "oidc-ann@sso" && e.detail === "OpenID Connect")).toBe(true);
  });

  it("is single use, tied to the browser that started it, and checks the state", async () => {
    const s = await start();
    const state = new URL((await j(s)).url).searchParams.get("state")!;
    const headers = { "X-EPC-Request": "1", Cookie: cookieOf(s) };
    expect((await h.call("POST", "/api/login/openid/finish", { headers: { "X-EPC-Request": "1" } }, { code: "good", state })).status).toBe(401); // no cookie: someone else's browser
    const s2 = await start();
    const st2 = new URL((await j(s2)).url).searchParams.get("state")!;
    expect((await h.call("POST", "/api/login/openid/finish", { headers: { "X-EPC-Request": "1", Cookie: cookieOf(s2) } }, { code: "good", state })).status).toBe(401); // the other flow's state
    expect((await h.call("POST", "/api/login/openid/finish", { headers: { "X-EPC-Request": "1", Cookie: cookieOf(s2) } }, { code: "good", state: st2 })).status).toBe(401); // already burnt by the failed try
    expect((await h.call("POST", "/api/login/openid/finish", { headers }, { code: "bad", state })).status).toBe(401);
    expect((await h.call("POST", "/api/login/openid/finish", { headers }, { code: "good", state })).status).toBe(401); // used up
  });

  it("only starts for OpenID realms and needs the page header", async () => {
    expect((await start("pve")).status).toBe(400);
    expect((await start("nonexistent")).status).toBe(400);
    expect((await fetch(h.base + "/api/login/openid/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ realm: "sso" }) })).status).toBe(403);
  });
});
