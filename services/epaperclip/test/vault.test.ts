import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeEngine, fakePve, until } from "./fakes.ts";

let eng: Awaited<ReturnType<typeof fakeEngine>>;
let server: Server;
let base: string;
let seenBodies: string[];

beforeEach(async () => {
  eng = await fakeEngine();
  seenBodies = [];
  const installDir = mkdtempSync(join(tmpdir(), "epc-vault-inst-"));
  const app = createApp({
    pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: fakePve().transport, caPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----" },
    sessions: new SessionStore(),
    staticDir: null,
    secureCookies: false,
    state: new StateStore(mkdtempSync(join(tmpdir(), "epc-vault-"))),
    engine: { url: eng.url, installDir, sleep: async () => {} },
  });
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await eng.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const send = async (method: string, path: string, cookie: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-EPC-Request": "1", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  seenBodies.push(text);
  return { status: r.status, json: (text ? JSON.parse(text) : null) as any };
};
async function signIn(username: string) {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username, password: "right", realm: "pve" }) });
  expect(r.status).toBe(200);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  // The first administrator signing in is also made the engine's instance admin, in the background.
  if (username === "sam") await until(() => eng.st.admins.size >= 2);
  return cookie;
}
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const org = async (sam: string, name: string) => (await send("POST", "/engine/api/companies", sam, { name })).json.id as string;

describe("the CEO picker", () => {
  it("lists nothing when no organization has a CEO yet", async () => {
    const sam = await signIn("sam");
    expect((await send("GET", "/api/vault/ceos", sam)).json).toEqual({ ceos: [] });
  });
  it("lists the CEOs the engine has, across organizations", async () => {
    const sam = await signIn("sam");
    const a = await org(sam, "Acme");
    const b = await org(sam, "Globex");
    const { ceos } = (await send("GET", "/api/vault/ceos", sam)).json;
    expect(ceos.map((c: any) => [c.companyId, c.companyName, c.name]).sort()).toEqual([[a, "Acme", "CEO"], [b, "Globex", "CEO"]].sort());
  });
});

describe("variables", () => {
  it("keeps a Pin-only variable out of every organization, and never returns the value", async () => {
    const sam = await signIn("sam");
    await org(sam, "Acme");
    const r = await send("POST", "/api/vault", sam, { name: "github token", value: SECRET, description: "For releases", share: "pin" });
    expect(r.status).toBe(201);
    expect(r.json.item).toMatchObject({ name: "GITHUB_TOKEN", share: "pin", targets: [], description: "For releases" });
    expect(eng.st.secrets.size).toBe(0);
    const list = await send("GET", "/api/vault", sam);
    expect(list.json.canManage).toBe(true);
    expect(list.json.items).toHaveLength(1);
    expect(seenBodies.join("")).not.toContain(SECRET);
  });

  it("shares with the chosen CEO only, as a secret the agent points at", async () => {
    const sam = await signIn("sam");
    const a = await org(sam, "Acme");
    const b = await org(sam, "Globex");
    const ceos = (await send("GET", "/api/vault/ceos", sam)).json.ceos as any[];
    const acme = ceos.find((c) => c.companyId === a);
    const r = await send("POST", "/api/vault", sam, { name: "GITHUB_TOKEN", value: SECRET, share: "ceos", targets: [{ companyId: acme.companyId, agentId: acme.agentId }] });
    expect(r.status).toBe(201);
    expect(r.json.problems).toEqual([]);
    expect([...eng.st.secrets.values()]).toEqual([{ companyId: a, name: "VAULT_GITHUB_TOKEN", value: SECRET }]);
    const env = (id: string) => eng.st.agents.get(id)![0].adapterConfig?.env?.GITHUB_TOKEN;
    expect(env(a)).toMatchObject({ type: "secret_ref", secretId: [...eng.st.secrets.keys()][0] });
    expect(eng.st.agents.get(b)?.[0].adapterConfig?.env?.GITHUB_TOKEN).toBeUndefined();
    expect(seenBodies.join("")).not.toContain(SECRET);
  });

  it("rotates when the value changes, and takes it back when a CEO is unchosen or it is removed", async () => {
    const sam = await signIn("sam");
    const a = await org(sam, "Acme");
    const ceo = (await send("GET", "/api/vault/ceos", sam)).json.ceos[0];
    const target = { companyId: ceo.companyId, agentId: ceo.agentId };
    const id = (await send("POST", "/api/vault", sam, { name: "API_KEY", value: SECRET, share: "ceos", targets: [target] })).json.item.id as string;
    const next = "ghp_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    await send("PATCH", `/api/vault/${id}`, sam, { value: next });
    expect([...eng.st.secrets.values()].map((s) => s.value)).toEqual([next]);

    const off = await send("PATCH", `/api/vault/${id}`, sam, { share: "pin" });
    expect(off.json.item).toMatchObject({ share: "pin", targets: [] });
    expect(eng.st.secrets.size).toBe(0);
    expect(eng.st.agents.get(a)![0].adapterConfig.env.API_KEY).toBeUndefined();

    await send("PATCH", `/api/vault/${id}`, sam, { share: "ceos", targets: [target] });
    expect(eng.st.secrets.size).toBe(1);
    expect((await send("DELETE", `/api/vault/${id}`, sam)).status).toBe(200);
    expect(eng.st.secrets.size).toBe(0);
    expect((await send("GET", "/api/vault", sam)).json.items).toEqual([]);
  });

  it("refuses bad names, reserved names, duplicates and empty values", async () => {
    const sam = await signIn("sam");
    for (const name of ["", "1ABC", "has.dot", "x".repeat(65), "PATH", "LD_PRELOAD", "NODE_OPTIONS"]) expect((await send("POST", "/api/vault", sam, { name, value: "v" })).status, name).toBe(400);
    expect((await send("POST", "/api/vault", sam, { name: "A", value: "" })).status).toBe(400);
    expect((await send("POST", "/api/vault", sam, { name: "A", value: "v", share: "everyone" })).status).toBe(400);
    expect((await send("POST", "/api/vault", sam, { name: "A", value: "v" })).status).toBe(201);
    expect((await send("POST", "/api/vault", sam, { name: "a", value: "v" })).status).toBe(409);
  });
});

describe("who may use it", () => {
  it("is for Proxmox administrators only, and for the signed-in person rather than a script", async () => {
    const sam = await signIn("sam");
    await send("POST", "/api/vault", sam, { name: "A", value: "v" });
    const lee = await signIn("lee");
    expect((await send("GET", "/api/vault", lee)).json).toEqual({ items: [], canManage: false });
    expect((await send("POST", "/api/vault", lee, { name: "B", value: "v" })).status).toBe(403);
    expect((await send("GET", "/api/vault/ceos", lee)).status).toBe(403);
    const noHeader = await fetch(base + "/api/vault", { method: "POST", headers: { "Content-Type": "application/json", Cookie: sam }, body: JSON.stringify({ name: "C", value: "v" }) });
    expect(noHeader.status).toBe(403);
  });
});

describe("Pin and the vault", () => {
  it("lists names to an administrator and never a value; refuses everyone else", async () => {
    const { runTool } = await import("../src/pin.ts");
    const { vaultFor } = await import("../src/features/vault-store.ts");
    const state = new StateStore(mkdtempSync(join(tmpdir(), "epc-vault-pin-")));
    const v = vaultFor(state);
    v.create({ name: "DEPLOY_KEY", value: SECRET, description: "Deploys", share: "pin" }, "sam@pve");
    const host = (admin: boolean) => ({ node: "pve", username: "sam@pve", pve: async () => null as never, engine: async () => null as never, vault: async () => (admin ? v.list() : null) });
    const out = (await runTool("vault_list", {}, host(true))) as { variables: { name: string; sharedWith: string }[] };
    expect(out.variables).toEqual([{ name: "DEPLOY_KEY", description: "Deploys", sharedWith: "Pin only" }]);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    await expect(runTool("vault_list", {}, host(false))).rejects.toThrow(/administrators/);
  });
});
