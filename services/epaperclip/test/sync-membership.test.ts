import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { managedEmail } from "../src/engine.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeEngine, fakePve, until } from "./fakes.ts";

let eng: Awaited<ReturnType<typeof fakeEngine>>;
let pve: ReturnType<typeof fakePve>;
let server: Server;
let base: string;
let state: StateStore;
let clock = 0;

beforeEach(async () => {
  clock = 0;
  eng = await fakeEngine();
  eng.st.strictMembers = true;
  pve = fakePve();
  const installDir = mkdtempSync(join(tmpdir(), "epc-inst-"));
  mkdirSync(join(installDir, "node_modules", "@paperclipai", "server"), { recursive: true });
  writeFileSync(join(installDir, "node_modules", "@paperclipai", "server", "package.json"), JSON.stringify({ version: "2026.1005.0" }));
  state = new StateStore(mkdtempSync(join(tmpdir(), "epc-syncm-")));
  const app = createApp({
    pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport },
    sessions: new SessionStore(),
    staticDir: null,
    secureCookies: false,
    state,
    now: () => Date.now() + clock,
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
const membersOf = async (cookie: string, co: string) => ((await (await send("GET", `/engine/api/companies/${co}/members`, cookie)).json()) as any).members as any[];

/** sam owns an organization with a resource group; lee is a second Proxmox administrator who is not a member. */
async function setup() {
  const sam = await signIn("sam");
  await until(() => eng.st.admins.size >= 2);
  const co = (await (await send("POST", "/engine/api/companies", sam, { name: "Northwind" })).json()) as { id: string };
  const rg = await send("PUT", `/api/resource-groups/${co.id}`, sam, { name: "Northwind", cores: 4, memoryMb: 8192, diskGb: 64, maxGuests: 4 });
  expect(rg.status).toBe(200);
  const pool = ((await rg.json()) as { group: { pool: string } }).group.pool;
  await send("POST", "/api/iac/users", sam, { userid: "kai@pve", password: "longenough" });
  pve.users["lee@pve"].admin = true;
  const lee = await signIn("lee");
  await until(() => eng.st.admins.size >= 3);
  return { sam, lee, co: co.id, pool };
}

describe("ERR-SYNC-001: a Proxmox administrator can join an organization on this host", () => {
  it("lets a non-member administrator join as admin, with pool access and an audit line", async () => {
    const { lee, co, pool } = await setup();
    expect((await send("GET", `/engine/api/companies/${co}/members`, lee)).status).toBe(403);
    const r = await send("POST", `/api/iac/orgs/${co}/join`, lee, {});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, userid: "lee@pve", role: "admin", joined: true });
    const leeId = eng.userId(managedEmail("lee@pve"))!;
    expect((await membersOf(lee, co)).find((m) => m.principalId === leeId)).toMatchObject({ membershipRole: "admin", status: "active" });
    expect(aclOf("lee@pve")).toEqual(expect.arrayContaining([`/pool/${pool} PVEPoolAdmin`, `/pool/${pool} PVEVMAdmin`]));
    const audit = (await (await send("GET", "/api/access/audit", lee)).json()) as any;
    expect(audit.entries[0]).toMatchObject({ action: "org-membership.grant", actor: "lee@pve", target: "lee@pve" });
  });

  it("lets an administrator grant another Proxmox user, and joining twice is harmless", async () => {
    const { sam, lee, co } = await setup();
    const r = await send("POST", `/api/iac/orgs/${co}/join`, lee, { userid: "kai@pve", role: "viewer" });
    expect(await r.json()).toMatchObject({ ok: true, userid: "kai@pve", role: "viewer", joined: true });
    const again = await send("POST", `/api/iac/orgs/${co}/join`, lee, { userid: "kai@pve", role: "viewer" });
    expect(again.status).toBe(200);
    const kaiId = eng.userId(managedEmail("kai@pve"))!;
    expect((await membersOf(sam, co)).filter((m) => m.principalId === kaiId && m.status === "active")).toHaveLength(1);
  });

  it("refuses anyone who is not a Proxmox administrator, and unknown Proxmox users", async () => {
    const { co } = await setup();
    pve.users["lee@pve"].admin = false;
    const lee = await signIn("lee");
    expect((await send("POST", `/api/iac/orgs/${co}/join`, lee, {})).status).toBe(403);
    pve.users["lee@pve"].admin = true;
    const lee2 = await signIn("lee");
    expect((await send("POST", `/api/iac/orgs/${co}/join`, lee2, { userid: "ghost@pve" })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("ERR-SYNC-002: orphan memberships are removed through the service account, with the real reason", () => {
  it("a non-member administrator deleting a user removes that user's membership without a warning", async () => {
    const { sam, lee, co } = await setup();
    await send("PUT", `/api/iac/orgs/${co}/members/kai@pve`, sam, { role: "operator" });
    const r = await send("DELETE", "/api/iac/users/kai@pve", lee);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).warnings).toEqual([]);
    const kaiId = eng.userId(managedEmail("kai@pve"))!;
    expect((await membersOf(sam, co)).find((m) => m.principalId === kaiId)).toMatchObject({ status: "archived" });
  });

  it("an orphan owner is demoted before removal when another owner exists", async () => {
    const { sam, lee, co } = await setup();
    await send("PUT", `/api/iac/orgs/${co}/members/kai@pve`, sam, { role: "owner" });
    pve.pveUsers.delete("kai@pve");
    const ov = (await (await fetch(base + "/api/iac", { headers: { Cookie: lee } })).json()) as any;
    expect(ov.warnings).toEqual([]);
    const kaiId = eng.userId(managedEmail("kai@pve"))!;
    expect((await membersOf(sam, co)).find((m) => m.principalId === kaiId)).toMatchObject({ status: "archived" });
  });

  it("a sole orphan owner stays, with the reason stored once and shown instead of a misleading 403", async () => {
    const { sam, lee, co } = await setup();
    await send("PUT", `/api/iac/orgs/${co}/members/kai@pve`, sam, { role: "owner" });
    const kaiId = eng.userId(managedEmail("kai@pve"))!;
    eng.company("co_sole", "Solo", { [kaiId]: "owner" });
    pve.pveUsers.delete("kai@pve");
    const first = (await (await fetch(base + "/api/iac", { headers: { Cookie: lee } })).json()) as any;
    expect(first.warnings.join(" ")).toMatch(/only owner of Solo/);
    expect(first.warnings.join(" ")).not.toMatch(/does not have access/i);
    expect(Object.keys(state.getSetting<Record<string, unknown>>("iac.unresolved") ?? {})).toEqual([`kai@pve|co_sole`]);
    const second = (await (await fetch(base + "/api/iac", { headers: { Cookie: lee } })).json()) as any;
    expect(second.warnings).toEqual(first.warnings);
  });
});

describe("ERR-SYNC-006: the cached administrator flag is verified against the engine", () => {
  it("repairs an engine-side demotion at the next sign-in after the cache is ten minutes old", async () => {
    const { lee } = await setup();
    expect(lee).toBeTruthy();
    const leeId = eng.userId(managedEmail("lee@pve"))!;
    eng.st.admins.delete(leeId);
    await signIn("lee");
    await new Promise((r) => setTimeout(r, 100));
    expect(eng.st.admins.has(leeId)).toBe(false); // still inside the window: trusted
    clock = 11 * 60_000;
    await signIn("lee");
    await until(() => eng.st.admins.has(leeId));
    expect(eng.st.admins.has(leeId)).toBe(true);
  });
});

describe("ERR-SYNC-008: deleting a user also drops their engine session", () => {
  it("a re-created user gets a fresh engine session, and the account is demoted", async () => {
    const { sam, co } = await setup();
    await send("PUT", `/api/iac/orgs/${co}/members/kai@pve`, sam, { role: "operator" });
    const before = eng.st.signIns;
    await send("DELETE", "/api/iac/users/kai@pve", sam);
    await send("POST", "/api/iac/users", sam, { userid: "kai@pve", password: "longenough" });
    await send("PUT", `/api/iac/orgs/${co}/members/kai@pve`, sam, { role: "viewer" });
    expect(eng.st.signIns).toBeGreaterThan(before);
  });
});

const spec = { name: "Fabrikam", cores: 2, memoryMb: 4096, diskGb: 32, maxGuests: 2 };
const groups = () => state.getSetting<Record<string, any>>("resourceGroups") ?? {};

describe("ERR-SYNC-003: organization create is one host-side call that completes or rolls back", () => {
  it("creates the engine organization and its pool together", async () => {
    const { sam } = await setup();
    const r = await send("POST", "/api/orgs", sam, spec);
    expect(r.status).toBe(200);
    const out = (await r.json()) as any;
    expect(out.company).toMatchObject({ name: "Fabrikam" });
    expect(out.group).toMatchObject({ companyId: out.company.id, pool: "epc-fabrikam" });
    expect(pve.pools.has("epc-fabrikam")).toBe(true);
    expect(groups()[out.company.id]).toBeTruthy();
    expect(eng.st.archivedCompanies.has(out.company.id)).toBe(false);
  });

  it("archives the organization again when the pool can't be made", async () => {
    const { sam } = await setup();
    pve.failures.add("pool");
    const r = await send("POST", "/api/orgs", sam, spec);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(((await r.json()) as any).error).toMatch(/rolled back/i);
    const created = [...eng.st.archivedCompanies];
    expect(created).toHaveLength(1);
    expect(groups()[created[0]]).toBeUndefined();
  });

  it("makes no pool when the engine refuses the organization", async () => {
    await setup();
    pve.users["lee@pve"].admin = false;
    const lee = await signIn("lee");
    const r = await send("POST", "/api/orgs", lee, spec);
    expect(r.status).toBe(403);
    expect(pve.pools.has("epc-fabrikam")).toBe(false);
  });
});

const poolAcls = (pool: string) => pve.acl.filter((a) => a.path === `/pool/${pool}`);
const drift = async (cookie: string) => ((await (await send("GET", "/api/iac/drift", cookie)).json()) as any).items as any[];

describe("ERR-SYNC-005 and 009: pool ACLs are reconciled against engine members", () => {
  it("reports missing and stale pool ACLs and a group-less organization, and repairs them", async () => {
    const { sam, co, pool } = await setup();
    await send("PUT", `/api/iac/orgs/${co}/members/kai@pve`, sam, { role: "operator" });
    expect(await drift(sam)).toEqual([]);
    pve.acl.splice(pve.acl.findIndex((a) => a.ugid === "kai@pve" && a.path === `/pool/${pool}`), 1);
    pve.acl.push({ path: `/pool/${pool}`, ugid: "lee@pve", type: "user", roleid: "PVEAuditor", propagate: 1 });
    const bare = (await (await send("POST", "/engine/api/companies", sam, { name: "Bare" })).json()) as any;
    const items = await drift(sam);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "missing-acl", userid: "kai@pve", role: "PVEVMUser", companyId: co }),
        expect.objectContaining({ kind: "stale-acl", userid: "lee@pve", role: "PVEAuditor", companyId: co }),
        expect.objectContaining({ kind: "missing-group", companyId: bare.id }),
      ]),
    );
    // Safe repair adds what is missing and leaves hand-made grants alone.
    const fixed = (await (await send("POST", "/api/iac/drift/repair", sam, {})).json()) as any;
    expect(fixed.repaired).toBeGreaterThanOrEqual(1);
    expect(poolAcls(pool).some((a) => a.ugid === "kai@pve" && a.roleid === "PVEVMUser")).toBe(true);
    expect(poolAcls(pool).some((a) => a.ugid === "lee@pve")).toBe(true);
    await send("POST", "/api/iac/drift/repair", sam, { removeStale: true });
    expect(poolAcls(pool).some((a) => a.ugid === "lee@pve")).toBe(false);
    expect((await drift(sam)).map((i) => i.kind)).toEqual(["missing-group"]);
  });

  it("is for Proxmox administrators only", async () => {
    await setup();
    pve.users["lee@pve"].admin = false;
    const lee = await signIn("lee");
    expect((await send("GET", "/api/iac/drift", lee)).status).toBe(403);
    expect((await send("POST", "/api/iac/drift/repair", lee, {})).status).toBe(403);
  });
});

describe("ERR-SYNC-004: archiving an organization cleans up its Proxmox side", () => {
  it("removes the pool, its ACLs and the stored group when the organization is archived", async () => {
    const { sam, co, pool } = await setup();
    await send("PUT", `/api/iac/orgs/${co}/members/kai@pve`, sam, { role: "operator" });
    expect(poolAcls(pool).length).toBeGreaterThan(0);
    expect((await send("DELETE", `/engine/api/companies/${co}`, sam)).status).toBe(200);
    await until(() => !groups()[co]);
    expect(groups()[co]).toBeUndefined();
    expect(pve.pools.has(pool)).toBe(false);
    expect(poolAcls(pool)).toEqual([]);
  });

  it("keeps a pool that still holds machines, and reports it as an orphan group until they are gone", async () => {
    const { sam, co, pool } = await setup();
    pve.pools.get(pool)!.members.push({ vmid: 105, type: "lxc" });
    eng.st.archivedCompanies.add(co); // archived behind the host's back
    const found = await drift(sam);
    expect(found).toEqual([expect.objectContaining({ kind: "orphan-group", companyId: co, pool, repair: "cleanup" })]);
    await send("POST", "/api/iac/drift/repair", sam, {});
    expect(pve.pools.has(pool)).toBe(true);
    expect(groups()[co]).toBeTruthy();
    pve.pools.get(pool)!.members.length = 0;
    await send("POST", "/api/iac/drift/repair", sam, {});
    expect(pve.pools.has(pool)).toBe(false);
    expect(groups()[co]).toBeUndefined();
    expect(await drift(sam)).toEqual([]);
  });
});
