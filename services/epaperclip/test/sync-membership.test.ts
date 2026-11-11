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

beforeEach(async () => {
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
