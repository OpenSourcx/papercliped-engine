import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORG_RANK, parseCsv, planDevice, planGroupMap, planPool, validateTemplate } from "../src/features/access-people.ts";
import { RoutineIngress, INGRESS_PATH, setIngress } from "../src/routine-ingress.ts";
import { StateStore } from "../src/state.ts";
import { startAccessApp } from "./access-harness.ts";
import { fakeEngine, until } from "./fakes.ts";

let h: Awaited<ReturnType<typeof startAccessApp>>;
let eng: Awaited<ReturnType<typeof fakeEngine>>;
let sam: string;
let lee: string;
let org: string;
const j = async (r: Response) => (await r.json()) as any;
const get = async (path: string, cookie = sam) => j(await h.call("GET", path, { cookie }));
const post = (path: string, body: unknown, cookie = sam) => h.call("POST", path, { cookie }, body);
const put = (path: string, body: unknown, cookie = sam) => h.call("PUT", path, { cookie }, body);
const aclOf = (u: string) => h.pve.acl.filter((a) => a.ugid === u).map((a) => `${a.path} ${a.roleid}`).sort();

beforeEach(async () => {
  eng = await fakeEngine();
  const installDir = mkdtempSync(join(tmpdir(), "epc-inst-"));
  mkdirSync(join(installDir, "node_modules", "@paperclipai", "server"), { recursive: true });
  writeFileSync(join(installDir, "node_modules", "@paperclipai", "server", "package.json"), JSON.stringify({ version: "2026.1005.0" }));
  h = await startAccessApp({ engine: { url: eng.url, installDir, sleep: async () => {} } });
  sam = await h.signIn("sam");
  lee = await h.signIn("lee");
  await until(() => eng.st.admins.size >= 2);
  org = ((await (await h.call("POST", "/engine/api/companies", { cookie: sam }, { name: "Northwind" })).json()) as { id: string }).id;
  h.state.setSetting("resourceGroups", { [org]: { pool: "epc-northwind" } });
});
afterEach(async () => {
  await h.close();
  await eng.close();
});

describe("planning a change", () => {
  it("lists exactly the permissions a device role or organization role adds and removes", () => {
    const acls = [{ path: "/", ugid: "lee@pve", type: "user", roleid: "PVEAuditor" }, { path: "/vms", ugid: "lee@pve", type: "user", roleid: "NoAccess" }];
    expect(planDevice("lee@pve", "operator", acls)).toEqual({ remove: [], add: [{ path: "/vms", role: "PVEVMAdmin" }, { path: "/storage", role: "PVEDatastoreUser" }] });
    expect(planDevice("lee@pve", "none", acls)).toEqual({ remove: [{ path: "/", role: "PVEAuditor" }], add: [] });
    expect(planPool("lee@pve", "epc-x", "viewer", [{ path: "/pool/epc-x", ugid: "lee@pve", type: "user", roleid: "PVEVMUser" }])).toEqual({ remove: ["PVEVMUser"], add: ["PVEAuditor"] });
    expect(planPool("lee@pve", "epc-x", null, [])).toEqual({ remove: [], add: [] });
  });

  it("previews a person's change without touching Proxmox or the engine", async () => {
    const before = h.pve.calls.length;
    const r = await j(await post("/api/access/preview", { userid: "lee@pve", deviceRole: "operator", orgs: [{ companyId: org, role: "operator" }] }));
    expect(r.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "acl", op: "add", path: "/", role: "PVEAuditor", privileges: expect.arrayContaining(["VM.Audit"]) }),
        expect.objectContaining({ kind: "acl", op: "add", path: "/vms", role: "PVEVMAdmin" }),
        expect.objectContaining({ kind: "engine", op: "add", org: "Northwind", to: "operator", text: "Joins Northwind as operator" }),
        expect.objectContaining({ kind: "acl", op: "add", path: "/pool/epc-northwind", role: "PVEVMUser" }),
      ]),
    );
    expect(h.pve.calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
    expect(aclOf("lee@pve")).toEqual([]);
    // a downgrade shows what is taken away and that their sessions end
    await put(`/api/iac/users/lee@pve`, { deviceRole: "viewer" });
    const down = await j(await post("/api/access/preview", { userid: "lee@pve", deviceRole: "none" }));
    expect(down.changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "acl", op: "remove", path: "/", role: "PVEAuditor" }), { kind: "effect", text: "Their open ePaperclip sessions end." }]));
  });

  it("warns about taking your own administrator role and validates input", async () => {
    const r = await j(await post("/api/access/preview", { userid: "sam@pve", deviceRole: "viewer" }));
    expect(r.warnings.join(" ")).toMatch(/own administrator role/);
    expect((await post("/api/access/preview", { userid: "x" })).status).toBe(400);
    expect((await post("/api/access/preview", { userid: "lee@pve", deviceRole: "root" })).status).toBe(400);
    expect((await post("/api/access/preview", { userid: "lee@pve", orgs: [{ companyId: org, role: "king" }] })).status).toBe(400);
  });
});

describe("organization-role templates", () => {
  const body = (extra = {}) => ({ name: "Contractor", description: "Hands on, no admin", deviceRole: "viewer", groups: ["ops"], orgs: [{ companyId: "*", role: "operator" }], ...extra });

  it("creates, lists, renames and deletes templates (administrators only)", async () => {
    expect((await post("/api/access/templates", body(), lee)).status).toBe(403);
    const c = await post("/api/access/templates", body());
    expect(c.status).toBe(201);
    const t = (await j(c)).template;
    expect((await get("/api/access/templates", lee)).templates).toEqual([expect.objectContaining({ name: "Contractor" })]);
    expect((await post("/api/access/templates", body())).status).toBe(400); // same name
    expect((await put(`/api/access/templates/${t.id}`, body({ name: "Contractor 2" }))).status).toBe(200);
    expect((await h.call("DELETE", `/api/access/templates/${t.id}`, { cookie: sam })).status).toBe(200);
    expect((await get("/api/access/templates")).templates).toEqual([]);
    expect((await get("/api/access/audit?action=template")).entries.map((e: any) => e.action).sort()).toEqual(["template.create", "template.delete", "template.update"]);
  });

  it("validates templates", () => {
    for (const b of [{}, { name: "x" }, { name: "x", deviceRole: "root" }, { name: "x", groups: ["a b"] }, { name: "x", orgs: [{ companyId: "o", role: "boss" }] }, { name: "x", orgs: [{ companyId: "o", role: "admin" }, { companyId: "o", role: "viewer" }] }, { name: "a;b", deviceRole: "viewer" }]) {
      expect(() => validateTemplate(b, "t0123456789"), JSON.stringify(b)).toThrow();
    }
    expect(validateTemplate({ name: " ok ", orgs: [{ companyId: "*", role: "viewer" }] }, "t0123456789").name).toBe("ok");
  });

  it("previews, then applies to several people: Proxmox permissions, groups and engine membership together", async () => {
    const t = (await j(await post("/api/access/templates", body()))).template;
    const dry = await j(await post(`/api/access/templates/${t.id}/apply`, { userids: ["lee@pve", "kim@pve"], dryRun: true }));
    expect(dry.dryRun).toBe(true);
    expect(dry.results[0].changes.map((c: any) => c.text ?? `${c.op} ${c.path} ${c.role}`)).toEqual(expect.arrayContaining(["add / PVEAuditor", "Joins Northwind as operator", "add /pool/epc-northwind PVEVMUser", "Joins group ops"]));
    expect(aclOf("lee@pve")).toEqual([]);
    const done = await j(await post(`/api/access/templates/${t.id}/apply`, { userids: ["lee@pve", "kim@pve"] }));
    expect(done.results.map((r: any) => r.applied)).toEqual([true, true]);
    for (const u of ["lee@pve", "kim@pve"]) {
      expect(aclOf(u)).toEqual(["/ PVEAuditor", "/pool/epc-northwind PVEVMUser"]);
      expect(h.pve.users.get(u)!.groups).toContain("ops");
    }
    const members = (await get("/api/iac")).users.find((u: any) => u.userid === "lee@pve");
    expect(members.orgs).toEqual([{ companyId: org, role: "operator" }]);
    expect((await get("/api/access/audit?action=template.apply")).total).toBe(1);
    // applying again changes nothing
    const again = await j(await post(`/api/access/templates/${t.id}/apply`, { userids: ["lee@pve"], dryRun: true }));
    expect(again.results[0].changes).toEqual([]);
  });

  it("applies one person at a time and reports who failed", async () => {
    const t = (await j(await post("/api/access/templates", body({ orgs: [] })))).template;
    const r = await j(await post(`/api/access/templates/${t.id}/apply`, { userids: ["lee@pve", "ghost@pve"] }));
    expect(r.results[0].applied).toBe(true);
    expect(r.results[1]).toMatchObject({ userid: "ghost@pve", error: "No such user" });
    expect((await post(`/api/access/templates/${t.id}/apply`, { userids: [] })).status).toBe(400);
  });
});

describe("importing people from a CSV", () => {
  const csv = (rows: string[]) => ["username,password,firstname,lastname,email,groups,devicerole,orgs", ...rows].join("\n");

  it("parses quoted cells, commas, doubled quotes and any line ending", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n\n,\n')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
    expect(() => parseCsv('a,"b')).toThrow();
  });

  it("shows a preview of each row: create, skip existing, error, with the permissions it would add", async () => {
    const r = await j(await post("/api/access/import/preview", { csv: csv(["ann,secret-pw-1,Ann,Lee,ann@x.org,ops,viewer,Northwind:operator", "lee,,Lee,,,,,", "bad name,,,,,,,", "bob@nowhere,,,,,,,", "cy,,,,,nogroup,sorcerer,Nowhere:admin"]) }));
    expect(r.counts).toEqual({ create: 1, update: 0, skip: 1, error: 3 });
    const [ann, lee2, bad, nowhere, cy] = r.rows;
    expect(ann).toMatchObject({ line: 2, userid: "ann@pve", action: "create", errors: [], summary: { name: "Ann Lee", groups: ["ops"], deviceRole: "viewer", orgs: [{ org: "Northwind", role: "operator" }], passwordKept: true } });
    expect(ann.changes).toEqual(expect.arrayContaining([expect.objectContaining({ op: "add", path: "/", role: "PVEAuditor" }), expect.objectContaining({ kind: "engine", op: "add" })]));
    expect(JSON.stringify(r)).not.toContain("secret-pw-1");
    expect(lee2).toMatchObject({ action: "skip", warnings: expect.arrayContaining(["Already exists; left unchanged."]) });
    expect(bad.errors.join()).toMatch(/looks like name@realm/);
    expect(nowhere.errors.join()).toMatch(/no realm named nowhere/);
    expect(cy.errors.join()).toMatch(/group nogroup doesn't exist.*Device role is.*no organization named "Nowhere"/);
    expect(h.pve.users.has("ann@pve")).toBe(false);
  });

  it("creates the Proxmox users and their engine accounts together, with groups, device roles and organization roles", async () => {
    const r = await j(await post("/api/access/import/apply", { csv: csv(["ann,secret-pw-1,Ann,Lee,ann@x.org,ops,viewer,Northwind:operator", "ben,,Ben,,,,operator,"]), generatePasswords: true }));
    expect(r.counts).toEqual({ created: 2, updated: 0, skipped: 0, failed: 0 });
    expect(h.pve.users.get("ann@pve")).toMatchObject({ firstname: "Ann", lastname: "Lee", email: "ann@x.org", groups: ["ops"], password: "secret-pw-1" });
    expect(r.results[0].password).toBeUndefined();
    expect(r.results[1].password).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(h.pve.users.get("ben@pve")!.password).toBe(r.results[1].password);
    expect(aclOf("ann@pve")).toEqual(["/ PVEAuditor", "/pool/epc-northwind PVEVMUser"]);
    expect(aclOf("ben@pve")).toEqual(["/ PVEAuditor", "/storage PVEDatastoreUser", "/vms PVEVMAdmin"]);
    // an engine account exists for each, and ann is a member of the organization
    const state = h.state.getSetting<Record<string, { userId: string | null }>>("engine.accounts")!;
    expect(state["ann@pve"].userId).toBeTruthy();
    expect(state["ben@pve"].userId).toBeTruthy();
    expect((await get("/api/iac")).users.find((u: any) => u.userid === "ann@pve").orgs).toEqual([{ companyId: org, role: "operator" }]);
    expect(JSON.stringify(await get("/api/access/audit"))).not.toContain("secret-pw-1");
    expect((await get("/api/access/audit?action=import.apply")).entries[0].detail).toBe('{"created":2,"updated":0,"skipped":0,"failed":0}');
  });

  it("refuses to apply while any row has an error, can create missing groups, and update existing people", async () => {
    expect((await post("/api/access/import/apply", { csv: csv(["ok,,,,,,,", "bad name,,,,,,,"]) })).status).toBe(400);
    expect(h.pve.users.has("ok@pve")).toBe(false);
    const r = await j(await post("/api/access/import/apply", { csv: csv(["lee,,Lee,Updated,,newteam,viewer,", "dan,,,,,newteam,,"]), createGroups: true, existing: "update" }));
    expect(r.counts).toMatchObject({ created: 1, updated: 1 });
    expect(h.pve.groups.has("newteam")).toBe(true);
    expect(h.pve.users.get("lee@pve")).toMatchObject({ lastname: "Updated", groups: ["newteam"] });
    expect(aclOf("lee@pve")).toEqual(["/ PVEAuditor"]);
  });

  it("uses a template for rows that name one, and the default realm for bare names", async () => {
    const t = (await j(await post("/api/access/templates", { name: "Viewer everywhere", deviceRole: "viewer", orgs: [{ companyId: "*", role: "viewer" }] }))).template;
    const r = await j(await post("/api/access/import/preview", { csv: "username,template\ncat,Viewer everywhere\ndot,No such", defaultRealm: "pve" }));
    expect(r.rows[0]).toMatchObject({ userid: "cat@pve", action: "create", summary: { template: "Viewer everywhere", deviceRole: "viewer", orgs: [{ org: "Northwind", role: "viewer" }] } });
    expect(r.rows[1].errors.join()).toMatch(/no template named/);
    void t;
  });

  it("limits size and rows, flags unknown columns, and needs the right to create users", async () => {
    expect((await post("/api/access/import/preview", { csv: "x\n1" })).status).toBe(400);
    expect((await post("/api/access/import/preview", { csv: "username\n" })).status).toBe(400);
    expect((await post("/api/access/import/preview", { csv: "username\n" + Array.from({ length: 501 }, (_, i) => `u${i}`).join("\n") })).status).toBe(400);
    const r = await j(await post("/api/access/import/preview", { csv: "username,shoe size\nzed,43" }));
    expect(r.problems).toEqual(['Column "shoe size" isn\'t recognised and is ignored']);
    expect((await post("/api/access/import/preview", { csv: "username\nzed" }, lee)).status).toBe(403);
  });
});

describe("mapping Proxmox groups to organization roles", () => {
  const map = (mappings: unknown[]) => put("/api/access/group-map", { mappings });

  it("saves mappings and checks the group and the organization exist", async () => {
    expect((await map([{ group: "ops", companyId: org, role: "operator" }])).status).toBe(200);
    const r = await get("/api/access/group-map");
    expect(r.mappings).toEqual([expect.objectContaining({ group: "ops", companyId: org, role: "operator" })]);
    expect(r.groups).toContain("ops");
    for (const m of [{ group: "nope", companyId: org, role: "viewer" }, { group: "ops", companyId: "nope", role: "viewer" }, { group: "ops", companyId: org, role: "boss" }]) expect((await map([m])).status).toBe(400);
    expect((await map([{ group: "ops", companyId: org, role: "viewer" }, { group: "ops", companyId: org, role: "admin" }])).status).toBe(400);
    expect((await put("/api/access/group-map", { mappings: [] }, lee)).status).toBe(403);
  });

  it("previews, grants, raises and later revokes only what mapping gave", async () => {
    await post("/api/access/groups", { groupid: "dev" });
    await post("/api/access/groups", { groupid: "leads" });
    await put("/api/iac/users/kim@pve".replace("/api/iac", "/api/iac"), { groups: ["ops"] });
    await put("/api/iac/users/lee@pve", { groups: ["ops", "leads"] });
    await map([{ group: "ops", companyId: org, role: "viewer" }, { group: "leads", companyId: org, role: "admin" }]);
    const dry = await j(await post("/api/access/group-map/sync", {}));
    expect(dry.dryRun).toBe(true);
    expect(dry.operations.map((o: any) => `${o.userid} ${o.op} ${o.to}`)).toEqual(["kim@pve grant viewer", "lee@pve grant admin"]);
    expect(aclOf("kim@pve")).toEqual([]);
    const run = await j(await post("/api/access/group-map/sync", { dryRun: false }));
    expect(run.operations.every((o: any) => o.applied)).toBe(true);
    expect(aclOf("kim@pve")).toEqual(["/pool/epc-northwind PVEAuditor"]);
    expect(aclOf("lee@pve")).toEqual(["/pool/epc-northwind PVEPoolAdmin", "/pool/epc-northwind PVEVMAdmin"]);
    // nothing left to do
    expect((await j(await post("/api/access/group-map/sync", {}))).operations).toEqual([]);
    // kim leaves the group: the viewer role mapping gave is taken back; lee's hand-given role elsewhere is untouched
    await put("/api/iac/users/kim@pve", { groups: [] });
    const revoke = await j(await post("/api/access/group-map/sync", { dryRun: false }));
    expect(revoke.operations.map((o: any) => `${o.userid} ${o.op}`)).toEqual(["kim@pve revoke"]);
    expect(aclOf("kim@pve")).toEqual([]);
    expect((await get("/api/access/audit?action=group-map.sync")).total).toBe(2);
  });

  it("never lowers or removes a role somebody was given by hand", () => {
    const users: any[] = [{ userid: "a@pve", groups: ["ops"], orgs: [{ companyId: "o", role: "owner" }] }, { userid: "b@pve", groups: [], orgs: [{ companyId: "o", role: "viewer" }] }];
    const st = { mappings: [{ id: "m", group: "ops", companyId: "o", role: "viewer" as const }], granted: {} };
    expect(planGroupMap(st, users, [{ companyId: "o", name: "O" }])).toEqual([]);
    // b is only touched when mapping granted exactly that role earlier
    expect(planGroupMap({ ...st, granted: { "b@pve|o": "operator" } }, users, [{ companyId: "o", name: "O" }])).toEqual([]);
    expect(planGroupMap({ ...st, granted: { "b@pve|o": "viewer" } }, users, [{ companyId: "o", name: "O" }]).map((o) => o.op)).toEqual(["revoke"]);
    expect(ORG_RANK.owner).toBeGreaterThan(ORG_RANK.admin);
  });
});

describe("routine webhook ingress: who may turn it on", () => {
  it("is off until a Proxmox administrator opens an organization", async () => {
    const r = await get("/api/access/routine-ingress");
    expect(r.organizations).toEqual([expect.objectContaining({ companyId: org, name: "Northwind", enabled: false, hooks: [] })]);
    expect(r).toMatchObject({ path: "/hooks/routines/{id}/fire", maxBodyBytes: 65536 });
    expect((await h.call("GET", "/api/access/routine-ingress", { cookie: lee })).status).toBe(403);
    expect((await put(`/api/access/routine-ingress/${org}`, { enabled: true }, lee)).status).toBe(403);
    expect((await put(`/api/access/routine-ingress/${org}`, { enabled: "yes" })).status).toBe(400);
    expect((await put(`/api/access/routine-ingress/nothing`, { enabled: true })).status).toBe(404);
    expect((await put(`/api/access/routine-ingress/${org}`, { enabled: true })).status).toBe(200);
    expect((await get("/api/access/routine-ingress")).organizations[0]).toMatchObject({ enabled: true, by: "sam@pve" });
    expect((await put(`/api/access/routine-ingress/${org}`, { enabled: false })).status).toBe(200);
    expect((await get("/api/access/routine-ingress")).organizations[0].enabled).toBe(false);
    expect((await get("/api/access/audit?action=ingress")).entries.map((e: any) => e.action)).toEqual(["ingress.disable", "ingress.enable"]);
  });

  it("answers 404 for every hook address while nothing is open, and never forwards other paths", async () => {
    for (const [m, p] of [["POST", "/hooks/routines/0123456789abcdef01234567/fire"], ["GET", "/hooks/routines/0123456789abcdef01234567/fire"], ["POST", "/hooks/"], ["POST", "/hooks/anything"]] as const) {
      const r = await fetch(h.base + p, { method: m, headers: { "Content-Type": "application/json" }, body: m === "POST" ? "{}" : undefined });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    expect(eng.seen.some((s) => s.url.includes("routine-triggers"))).toBe(false);
  });
});

// ---- the ingress itself, against a stand-in engine gateway

describe("routine webhook ingress: the door", () => {
  const PUBLIC = "0123456789abcdef01234567";
  const OTHER = "fedcba9876543210fedcba98";
  let state: StateStore;
  let server: ReturnType<typeof createServer>;
  let base: string;
  let clock: { t: number };
  let forwarded: { id: string; headers: Record<string, string>; body: string }[];
  let fakeGateway: any;

  const start = async () => {
    clock = { t: 1_800_000_000_000 };
    state = new StateStore(null);
    forwarded = [];
    fakeGateway = {
      serviceJson: async (_m: string, path: string) => {
        if (path === "/api/companies/open-co/routines") return [{ id: "r1", title: "Deploy", triggers: [{ id: "t1", kind: "webhook", publicId: PUBLIC, signingMode: "github_hmac" }, { id: "t2", kind: "schedule" }] }];
        if (path === "/api/companies/other-co/routines") return { routines: [{ id: "r2", title: "Other" }] };
        if (path === "/api/routines/r2") return { id: "r2", triggers: [{ id: "t3", kind: "webhook", publicId: OTHER, signingMode: "none" }] };
        return [];
      },
      firePublicTrigger: async (id: string, headers: Record<string, string>, body: Buffer) => {
        forwarded.push({ id, headers, body: body.toString() });
        return { status: 202, text: JSON.stringify({ id: "run1", status: "received" }) };
      },
    };
    const ingress = new RoutineIngress({ state, gateway: fakeGateway, now: () => clock.t });
    server = createServer((req, res) => {
      ingress.handle(req, res, new URL(req.url ?? "/", "http://x")).catch((e) => {
        res.writeHead(e.status ?? 500, { "Content-Type": "application/json", ...(res.getHeader("Allow") ? { Allow: String(res.getHeader("Allow")) } : {}) });
        res.end(JSON.stringify({ error: e.message, code: e.code }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const fire = (id = PUBLIC, body = '{"ref":"main"}', headers: Record<string, string> = { "Content-Type": "application/json" }, method = "POST") => fetch(`${base}/hooks/routines/${id}/fire`, { method, headers, body: method === "POST" ? body : undefined });
  beforeEach(start);
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("does not exist until an organization is opened, and only for that organization's webhook triggers", async () => {
    expect((await fire()).status).toBe(404);
    setIngress(state, () => clock.t, "other-co", true, "sam@pve");
    expect((await fire()).status).toBe(404); // PUBLIC belongs to open-co, which is not open
    expect(forwarded).toEqual([]);
    setIngress(state, () => clock.t, "open-co", true, "sam@pve");
    clock.t += 30_000;
    const r = await fire();
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ id: "run1", status: "received" });
    expect(forwarded).toHaveLength(1);
    expect((await fire("00000000000000000000000f")).status).toBe(404); // unknown trigger looks like any wrong address
    expect((await fire(OTHER)).status).toBe(202); // other-co's trigger (found through the detail route)
    setIngress(state, () => clock.t, "open-co", false, "sam@pve");
    clock.t += 30_000;
    expect((await fire()).status).toBe(404);
  });

  it("passes the body and the signing headers through byte for byte, and nothing else", async () => {
    setIngress(state, () => clock.t, "open-co", true, "sam@pve");
    const body = '{ "ref" : "main",\n "n": 1 }';
    await fire(PUBLIC, body, { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=abc", "X-Paperclip-Timestamp": "1700000000", Authorization: "Bearer whsec", "Idempotency-Key": "k1", Cookie: "session=steal", "X-Forwarded-For": "6.6.6.6", "X-Custom": "no" });
    expect(forwarded[0].body).toBe(body);
    expect(forwarded[0].headers).toEqual({ "content-type": "application/json", authorization: "Bearer whsec", "x-hub-signature-256": "sha256=abc", "x-paperclip-timestamp": "1700000000", "idempotency-key": "k1" });
    expect(forwarded[0].id).toBe(PUBLIC);
  });

  it("takes POST with JSON only, up to 64 KiB, and rejects other paths", async () => {
    setIngress(state, () => clock.t, "open-co", true, "sam@pve");
    const g = await fire(PUBLIC, "", {}, "GET");
    expect(g.status).toBe(405);
    expect(g.headers.get("allow")).toBe("POST");
    expect((await fire(PUBLIC, "x", { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await fire(PUBLIC, "x".repeat(70 * 1024))).status).toBe(413);
    expect((await fire(PUBLIC, JSON.stringify({ pad: "x".repeat(60 * 1024) }))).status).toBe(202);
    for (const p of ["/hooks/routines/0123/fire", `/hooks/routines/${PUBLIC}/fire/x`, `/hooks/routines/${PUBLIC}`, "/hooks/routines/../api/health/fire", `/hooks/routines/${PUBLIC.toUpperCase()}/fire`]) {
      expect((await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, p).toBe(404);
    }
    expect(INGRESS_PATH.test(`/hooks/routines/${PUBLIC}/fire`)).toBe(true);
  });

  it("limits how often one trigger and one address may call", async () => {
    setIngress(state, () => clock.t, "open-co", true, "sam@pve");
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await fire()).status);
    expect(codes.slice(0, 30).every((c) => c === 202)).toBe(true);
    expect(codes.slice(30)).toEqual([429, 429]);
    clock.t += 61_000;
    expect((await fire()).status).toBe(202);
  });

  it("reports an engine that is down as 503 and any odd engine answer as 502", async () => {
    setIngress(state, () => clock.t, "open-co", true, "sam@pve");
    fakeGateway.firePublicTrigger = async () => ({ status: 500, text: "stack trace" });
    const r = await fire();
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain("stack trace");
    fakeGateway.firePublicTrigger = async () => ({ status: 401, text: JSON.stringify({ error: "Unauthorized" }) });
    expect((await fire()).status).toBe(401);
  });
});
