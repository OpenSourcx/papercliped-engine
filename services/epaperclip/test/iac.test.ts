import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { managedEmail } from "../src/engine.ts";
import { deviceRoleOf } from "../src/iac.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeEngine, fakePve, until } from "./fakes.ts";

let eng: Awaited<ReturnType<typeof fakeEngine>>;
let pve: ReturnType<typeof fakePve>;
let server: Server;
let base: string;
let sessions: SessionStore;

beforeEach(async () => {
  eng = await fakeEngine();
  pve = fakePve();
  const installDir = mkdtempSync(join(tmpdir(), "epc-inst-"));
  mkdirSync(join(installDir, "node_modules", "@paperclipai", "server"), { recursive: true });
  writeFileSync(join(installDir, "node_modules", "@paperclipai", "server", "package.json"), JSON.stringify({ version: "2026.1005.0" }));
  sessions = new SessionStore();
  const app = createApp({
    pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport },
    sessions,
    staticDir: null,
    secureCookies: false,
    state: new StateStore(mkdtempSync(join(tmpdir(), "epc-iac-"))),
    engine: { url: eng.url, installDir, sleep: async () => {} },
  });
  server = createServer(app);
  server.on("upgrade", app.upgrade);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await eng.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const send = (method: string, path: string, cookie: string, body?: unknown) =>
  fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-EPC-Request": "1", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
async function signIn(username: string) {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username, password: "right", realm: "pve" }) });
  expect(r.status).toBe(200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
const aclOf = (user: string) => pve.acl.filter((a) => a.ugid === user).map((a) => `${a.path} ${a.roleid}`).sort();

/** sam (a Proxmox administrator, so an engine admin) with one organization that has a resource group. */
async function setup() {
  const sam = await signIn("sam");
  await until(() => eng.st.admins.size >= 2);
  const co = (await (await send("POST", "/engine/api/companies", sam, { name: "Northwind" })).json()) as { id: string };
  const rg = await send("PUT", `/api/resource-groups/${co.id}`, sam, { name: "Northwind", cores: 4, memoryMb: 8192, diskGb: 64, maxGuests: 4 });
  expect(rg.status).toBe(200);
  const pool = ((await rg.json()) as { group: { pool: string } }).group.pool;
  return { sam, co: co.id, pool };
}

describe("integrated access control", () => {
  it("reads people from Proxmox, with device roles from their ACLs and organizations from the engine", async () => {
    const { sam, co } = await setup();
    const r = (await (await fetch(base + "/api/iac", { headers: { Cookie: sam } })).json()) as any;
    expect(r.canManageUsers).toBe(true);
    const bySam = r.users.find((u: any) => u.userid === "sam@pve");
    expect(bySam).toMatchObject({ deviceRole: "admin", name: "Sam", orgs: [{ companyId: co, role: "owner" }], hasEngineAccount: true });
    expect(r.users.find((u: any) => u.userid === "lee@pve")).toMatchObject({ deviceRole: "none", orgs: [] });
    expect(r.orgs).toEqual([expect.objectContaining({ companyId: co, name: "Northwind" })]);
  });

  it("creating a user creates the Proxmox user, its ACLs, and its organization access in both places", async () => {
    const { sam, co, pool } = await setup();
    const r = await send("POST", "/api/iac/users", sam, { userid: "kai@pve", password: "longenough", email: "kai@example.com", deviceRole: "operator", orgs: [{ companyId: co, role: "operator" }] });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).warnings).toEqual([]);
    expect(pve.pveUsers.get("kai@pve")).toMatchObject({ email: "kai@example.com", enable: 1 });
    expect(pve.pveUsers.get("kai@pve")).not.toHaveProperty("password");
    expect(aclOf("kai@pve")).toEqual(["/ PVEAuditor", `/pool/${pool} PVEVMUser`, "/storage PVEDatastoreUser", "/vms PVEVMAdmin"].sort());
    const kaiId = eng.userId(managedEmail("kai@pve"))!;
    const members = (await (await send("GET", `/engine/api/companies/${co}/members`, sam)).json()) as any;
    expect(members.members.find((m: any) => m.principalId === kaiId)).toMatchObject({ membershipRole: "operator", status: "active" });
  });

  it("updating access changes Proxmox ACLs and engine roles together, and removing it removes both", async () => {
    const { sam, co, pool } = await setup();
    await send("POST", "/api/iac/users", sam, { userid: "kai@pve", deviceRole: "operator", orgs: [{ companyId: co, role: "operator" }] });
    const up = await send("PUT", "/api/iac/users/kai@pve", sam, { deviceRole: "viewer", orgs: [{ companyId: co, role: "admin" }], firstname: "Kai" });
    expect(up.status).toBe(200);
    expect(aclOf("kai@pve")).toEqual(["/ PVEAuditor", `/pool/${pool} PVEPoolAdmin`, `/pool/${pool} PVEVMAdmin`].sort());
    expect(pve.pveUsers.get("kai@pve")).toMatchObject({ firstname: "Kai" });
    const kaiId = eng.userId(managedEmail("kai@pve"))!;
    expect(eng.st.admins.has(kaiId)).toBe(false);
    await send("PUT", "/api/iac/users/kai@pve", sam, { orgs: [] });
    expect(aclOf("kai@pve")).toEqual(["/ PVEAuditor"]);
    const members = (await (await send("GET", `/engine/api/companies/${co}/members`, sam)).json()) as any;
    expect(members.members.find((m: any) => m.principalId === kaiId)).toMatchObject({ status: "archived" });
  });

  it("making someone a device admin makes them an engine admin; taking it away takes it back", async () => {
    const { sam } = await setup();
    await signIn("lee");
    await until(() => eng.users.has(managedEmail("lee@pve")));
    await send("PUT", "/api/iac/users/lee@pve", sam, { deviceRole: "admin" });
    const leeId = eng.userId(managedEmail("lee@pve"))!;
    expect(aclOf("lee@pve")).toEqual(["/ Administrator"]);
    expect(eng.st.admins.has(leeId)).toBe(true);
    await send("PUT", "/api/iac/users/lee@pve", sam, { deviceRole: "none" });
    expect(aclOf("lee@pve")).toEqual([]);
    expect(eng.st.admins.has(leeId)).toBe(false);
  });

  it("deleting a user deletes them in Proxmox, removes them from every organization and ends their sessions", async () => {
    const { sam, co } = await setup();
    await send("POST", "/api/iac/users", sam, { userid: "lee2@pve", orgs: [{ companyId: co, role: "viewer" }] });
    const lee = await signIn("lee");
    await send("PUT", `/api/iac/orgs/${co}/members/lee@pve`, sam, { role: "viewer" });
    expect((await send("DELETE", "/api/iac/users/lee@pve", sam)).status).toBe(200);
    expect(pve.pveUsers.has("lee@pve")).toBe(false);
    expect(aclOf("lee@pve")).toEqual([]);
    const leeId = eng.userId(managedEmail("lee@pve"))!;
    const members = (await (await send("GET", `/engine/api/companies/${co}/members`, sam)).json()) as any;
    expect(members.members.find((m: any) => m.principalId === leeId)).toMatchObject({ status: "archived" });
    expect((await fetch(base + "/api/me", { headers: { Cookie: lee } })).status).toBe(401);
  });

  it("leaves the decision to Proxmox: someone without User.Modify can't create users", async () => {
    await setup();
    const lee = await signIn("lee");
    const r = await send("POST", "/api/iac/users", lee, { userid: "eve@pve" });
    expect(r.status).toBe(403);
    expect(pve.pveUsers.has("eve@pve")).toBe(false);
  });

  it("only an organization's owners and admins (or a Proxmox administrator) change its members", async () => {
    const { co } = await setup();
    const lee = await signIn("lee");
    const r = await send("PUT", `/api/iac/orgs/${co}/members/lee@pve`, lee, { role: "owner" });
    expect(r.status).toBe(403);
  });

  it("a new resource group gives the organization's members their roles on its pool", async () => {
    const sam = await signIn("sam");
    await until(() => eng.st.admins.size >= 2);
    const co = ((await (await send("POST", "/engine/api/companies", sam, { name: "Lumen" })).json()) as { id: string }).id;
    await signIn("lee");
    await until(() => eng.users.has(managedEmail("lee@pve")));
    await send("PUT", `/api/iac/orgs/${co}/members/lee@pve`, sam, { role: "operator" });
    const rg = (await (await send("PUT", `/api/resource-groups/${co}`, sam, { name: "Lumen", cores: 2, memoryMb: 2048, diskGb: 16, maxGuests: 2 })).json()) as any;
    expect(aclOf("lee@pve")).toEqual([`/pool/${rg.group.pool} PVEVMUser`]);
    expect(aclOf("sam@pve")).toContain(`/pool/${rg.group.pool} PVEVMAdmin`);
  });

  it("protects people from locking themselves out", async () => {
    const { sam } = await setup();
    expect((await send("DELETE", "/api/iac/users/sam@pve", sam)).status).toBe(400);
    expect((await send("PUT", "/api/iac/users/sam@pve", sam, { deviceRole: "viewer" })).status).toBe(400);
    expect(aclOf("sam@pve")).toContain("/ Administrator");
  });

  it("validates input before anything reaches Proxmox", async () => {
    const { sam } = await setup();
    for (const body of [{ userid: "no-realm" }, { userid: "a b@pve" }, { userid: "x@pve", deviceRole: "root" }, { userid: "x@pve", orgs: [{ companyId: "c", role: "god" }] }, { userid: "x@pve", password: "short" }]) {
      expect((await send("POST", "/api/iac/users", sam, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(pve.pveUsers.size).toBe(2);
  });
});

describe("device roles from ACLs", () => {
  it("recognises our roles exactly and calls anything else custom", () => {
    const acl = (user: string, path: string, roleid: string) => ({ path, ugid: user, type: "user", roleid, propagate: 1 });
    expect(deviceRoleOf("a@pve", [acl("a@pve", "/", "Administrator")])).toBe("admin");
    expect(deviceRoleOf("a@pve", [acl("a@pve", "/", "PVEAuditor"), acl("a@pve", "/vms", "PVEVMAdmin"), acl("a@pve", "/storage", "PVEDatastoreUser")])).toBe("operator");
    expect(deviceRoleOf("a@pve", [acl("a@pve", "/", "PVEAuditor")])).toBe("viewer");
    expect(deviceRoleOf("a@pve", [acl("a@pve", "/pool/x", "PVEVMUser")])).toBe("none");
    expect(deviceRoleOf("a@pve", [acl("a@pve", "/nodes/pve", "PVESysAdmin")])).toBe("custom");
    expect(deviceRoleOf("a@pve", [acl("b@pve", "/", "Administrator")])).toBe("none");
  });
});
