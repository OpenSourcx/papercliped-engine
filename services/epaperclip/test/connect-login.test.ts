import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sanitizeLogin, signInAddress } from "../src/features/connect-login.ts";
import { fakeCompat, startConnectApp, type ConnectApp } from "./fakes-connect.ts";

let h: ConnectApp;
let up: Awaited<ReturnType<typeof fakeCompat>>;
beforeEach(async () => {
  up = await fakeCompat();
  h = await startConnectApp({ providers: (u, i) => fetch(u, i) });
  // The engine's instance admin sees every organization's environments. Put another org's first: the route must
  // still pick the one that belongs to the organization in the URL.
  h.eng.st.envs.set("env9", { id: "env9", name: "Another org's containers", driver: "sandbox", status: "active", metadata: { epaperclip: "agent-containers", companyId: "co_2" } });
  h.eng.st.envs.set("env1", { id: "env1", name: "Northwind containers", driver: "sandbox", status: "active", metadata: { epaperclip: "agent-containers", companyId: "co_1" } });
});
afterEach(async () => {
  await h.closeAll();
  await up.close();
});

const j = async (r: Response) => (await r.json()) as any;
const start = (body: Record<string, unknown>, cookie = h.sam, co = "co_1") => h.call("POST", `/api/connect/orgs/${co}/login`, { cookie }, body);
/** Poll the local attempt until the engine session id replaces it. */
const settle = async (id: string, cookie = h.sam, co = "co_1") => {
  for (let i = 0; i < 100; i++) {
    const r = await h.call("GET", `/api/connect/orgs/${co}/login/${id}`, { cookie });
    if (r.status !== 200) throw new Error(`poll answered ${r.status}`);
    const l = (await j(r)).login;
    if (!l || l.id !== id || l.failed) return l;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("the login did not start in time");
};
const KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX";

describe("sanitising the engine's login session", () => {
  it("keeps only sign-in addresses on the providers' own hosts", () => {
    expect(signInAddress("https://claude.ai/oauth/authorize?code=true")).toBeTruthy();
    expect(signInAddress("https://auth.openai.com/codex/device")).toBeTruthy();
    for (const bad of ["https://evil.example/claude.ai", "http://claude.ai/x", "https://claude.ai.evil.com/", "https://user:pw@claude.ai/", "javascript:alert(1)", 5, null]) expect(signInAddress(bad), String(bad)).toBeNull();
  });
  it("drops credentials, tokens and unlisted addresses, however deep", () => {
    const v = sanitizeLogin({ id: "s1", status: "waiting", verification_url: "https://evil.example/x", nested: { accessToken: "sk-ant-oat01-XXXXXXXXXXXXXXXXXXXX", userCode: "WXYZ-1234" }, output: "open https://claude.ai/device then sk-ant-oat01-XXXXXXXXXXXXXXXXXXXX", credential: { token: "t" } }, { adapter: "claude_local", provider: "anthropic", flow: "device", fallbackId: "f" });
    expect(v).toMatchObject({ id: "s1", status: "waiting", verificationUrl: "https://claude.ai/device", userCode: "WXYZ-1234", done: false });
    expect(JSON.stringify(v)).not.toMatch(/sk-ant|evil\.example|credential/);
    // Claude's prompt route calls the address `authorizationUrl`; it must survive the generic credential filter.
    const prompt = v && sanitizeLogin({ status: "waiting_for_user", authorizationUrl: "https://claude.com/cai/oauth/authorize?code=true&state=x", accessToken: "sk-ant-oat01-NOPE" }, { adapter: "claude_local", provider: "anthropic", flow: "setup-token", fallbackId: "s2" });
    expect(prompt.verificationUrl).toBe("https://claude.com/cai/oauth/authorize?code=true&state=x");
    expect(JSON.stringify(prompt)).not.toContain("sk-ant");
  });
});

describe("signing an organization's agents in with a subscription", () => {
  it("starts the login in the organization's container environment and relays only what the person needs", async () => {
    const r = await start({ provider: "openai", name: "Team Codex" });
    expect(r.status).toBe(202);
    const first = (await j(r)).login;
    expect(first).toMatchObject({ status: "starting", adapter: "codex_local", provider: "openai", done: false });
    expect(first.id).toMatch(/^p_/);
    const live = await settle(first.id);
    expect(live).toMatchObject({ id: "ls1", status: "waiting_for_browser", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH", done: false });
    const sent = h.overlay.logins.get("ls1")!.body;
    expect(sent).toEqual({ aiConnection: { provider: "openai", method: "subscription", name: "Team Codex", ownership: "personal", allAgents: false, agentIds: [] }, environmentId: "env1" });
    const text = JSON.stringify(live);
    expect(text).not.toContain("SECRETSECRET");
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("ZZZZ-9999");
    const done = await j(await h.call("GET", "/api/connect/orgs/co_1/login/ls1", { cookie: h.sam }));
    expect(done.login).toMatchObject({ status: "completed", done: true });
    expect(JSON.stringify(done)).not.toContain("SECRETSECRET");
    // Finished: the outcome is remembered for 15 minutes (ERR-OAU-007), not answered with a 404.
    expect((await j(await h.call("GET", "/api/connect/orgs/co_1/login/ls1", { cookie: h.sam }))).login).toMatchObject({ status: "completed", done: true });
    const audit = JSON.stringify(await j(await h.call("GET", "/api/access/audit", { cookie: h.sam })));
    expect(audit).toContain("connection.login.start");
    expect(audit).not.toContain("SECRETSECRET");
  });

  it("keeps the account personal unless the person shares it, and can install it on chosen agents", async () => {
    const personal = await settle((await j(await start({ provider: "openai", name: "My Codex" }))).login.id);
    expect(h.overlay.logins.get(personal.id)!.body.aiConnection).toEqual({ provider: "openai", method: "subscription", name: "My Codex", ownership: "personal", allAgents: false, agentIds: [] });

    const shared = await settle((await j(await start({ provider: "openai", name: "Team Codex", ownership: "shared" }))).login.id);
    expect(h.overlay.logins.get(shared.id)!.body.aiConnection).toMatchObject({ ownership: "shared", allAgents: true, agentIds: [] });

    const selected = await settle((await j(await start({ provider: "openai", name: "Two agents", ownership: "shared", allAgents: false, agentIds: ["ag1", "ag2", "ag1"] }))).login.id);
    expect(h.overlay.logins.get(selected.id)!.body.aiConnection).toMatchObject({ ownership: "shared", allAgents: false, agentIds: ["ag1", "ag2"] });
  });

  it("refuses a personal account for every agent, and all agents plus a selected list", async () => {
    expect((await start({ provider: "openai", ownership: "personal", allAgents: true })).status).toBe(400);
    expect((await start({ provider: "openai", ownership: "shared", allAgents: true, agentIds: ["ag1"] })).status).toBe(400);
    expect((await start({ provider: "openai", agentIds: ["not an id"] })).status).toBe(400);
    expect((await start({ provider: "openai", allAgents: "yes" })).status).toBe(400);
  });

  it("supports Claude's setup-token flow, including the code from the browser, never echoed back", async () => {
    const pending = (await j(await start({ provider: "anthropic", flow: "setup-token" }))).login;
    expect(pending).toMatchObject({ adapter: "claude_local", flow: "setup-token" });
    const s = await settle(pending.id);
    expect(s).toMatchObject({ adapter: "claude_local", flow: "setup-token" });
    // Claude with no flow picks setup-token, the only Claude sign-in the engine has.
    expect((await j(await start({ provider: "anthropic" }))).login).toMatchObject({ adapter: "claude_local", flow: "setup-token" });
    const code = "AbC123-browser-code";
    const r = await h.call("POST", `/api/connect/orgs/co_1/login/${s.id}/code`, { cookie: h.sam }, { browserCode: code });
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain(code);
    expect((await h.call("POST", `/api/connect/orgs/co_1/login/${s.id}/code`, { cookie: h.sam }, { browserCode: "has space" })).status).toBe(400);
    expect((await h.call("POST", `/api/connect/orgs/co_1/login/${s.id}/cancel`, { cookie: h.sam }, {})).status).toBe(200);
  });

  it("says which resource limit is full when the engine answers a bare 500 to a sign-in start", async () => {
    h.overlay.loginMode.startStatus = 500;
    // Not full (no group): the engine's failure stays a failure, with no invented cause.
    const plain = await start({ provider: "anthropic" });
    expect(plain.status).toBe(202);
    const failedPlain = await settle((await j(plain)).login.id);
    expect(failedPlain.failed).toBe(true);
    expect(failedPlain.message).not.toMatch(/resource group/);
    // Two machines in the pool (the template does not count) and the group allows two.
    h.state.setSetting("resourceGroups", { co_1: { pool: "epc-co1", maxGuests: 2, cores: 16 } });
    const full = await settle((await j(await start({ provider: "anthropic" }))).login.id);
    expect(full.failed).toBe(true);
    expect(full.message).toMatch(/machines \(2 of 2 in use\)/);
    expect(full.message).not.toMatch(/CPU/);
    // Room left: back to the plain failure.
    h.state.setSetting("resourceGroups", { co_1: { pool: "epc-co1", maxGuests: 3, cores: 16 } });
    const room = await settle((await j(await start({ provider: "anthropic" }))).login.id);
    expect(room.failed).toBe(true);
    expect(room.message).not.toMatch(/resource group/);
  });

  it("is for organization owners and admins, own sessions only, and validates the request", async () => {
    expect((await start({ provider: "openai" }, h.lee)).status).toBe(403); // lee is an operator
    expect((await start({ provider: "gemini" })).status).toBe(400);
    expect((await start({ provider: "openai", flow: "setup-token" })).status).toBe(400);
    expect((await start({ provider: "openai", ownership: "everyone" })).status).toBe(400);
    expect((await start({ provider: "openai", extra: 1 })).status).toBe(400);
    expect((await start({ provider: "openai" }, h.sam, "co_9")).status).toBe(403);
    const s = (await j(await start({ provider: "openai" }))).login;
    expect((await h.call("GET", `/api/connect/orgs/co_1/login/${s.id}`, { cookie: h.lee })).status).toBeGreaterThanOrEqual(403);
    expect((await h.call("GET", `/api/connect/orgs/co_2/login/${s.id}`, { cookie: h.sam })).status).toBe(404);
    const noHeader = await fetch(`${h.base}/api/connect/orgs/co_1/login`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: h.sam }, body: JSON.stringify({ provider: "openai" }) });
    expect(noHeader.status).toBe(403);
  });

  it("limits how often sign-ins are started, and needs a container environment", async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await start({ provider: "openai" })).status;
    expect(last).toBe(429);
    h.eng.st.envs.clear();
    h.clock.t += 11 * 60_000;
    const r = await start({ provider: "openai" });
    expect(r.status).toBe(409);
    expect((await j(r)).code).toBe("no_environment");
  });

  it("never runs anything on the host", async () => {
    // The only things this service does are HTTP calls to the engine as the person.
    const src = readFileSync(join(__dirname, "../src/features/connect-login.ts"), "utf8");
    expect(src).not.toMatch(/child_process|spawn\(|exec\(|execFile|node-pty/);
  });
});

describe("never abandoning an engine sign-in (ERR-OAU-005, ERR-OAU-007)", () => {
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(f()).toBe(true);
  };

  it("cancels in the engine a session whose start was cancelled while the container was still starting", async () => {
    let release!: () => void;
    h.overlay.loginCtl.gate = new Promise<void>((r) => (release = r));
    const pending = (await j(await start({ provider: "anthropic", flow: "setup-token" }))).login;
    expect((await h.call("POST", `/api/connect/orgs/co_1/login/${pending.id}/cancel`, { cookie: h.sam }, {})).status).toBe(200);
    release();
    await until(() => h.overlay.loginCtl.cancels.includes("ls1"));
    // The slot is free: a new start works and is tracked normally.
    h.overlay.loginCtl.gate = null;
    const again = (await j(await start({ provider: "anthropic", flow: "setup-token" }))).login;
    expect(await settle(again.id)).toMatchObject({ id: "ls2" });
  });

  it("adopts and cancels the engine's active session when the start's answer was lost", async () => {
    h.overlay.loginCtl.dropStart = true;
    const pending = (await j(await start({ provider: "anthropic", flow: "setup-token" }))).login;
    expect((await settle(pending.id)).failed).toBe(true);
    await until(() => h.overlay.loginCtl.cancels.includes("ls1"));
  });

  it("keeps the end of a sign-in after the engine has purged it", async () => {
    const pending = (await j(await start({ provider: "anthropic", flow: "setup-token" }))).login;
    const s1 = await settle(pending.id);
    let last: any;
    for (let i = 0; i < 5 && !last?.done; i++) last = (await j(await h.call("GET", `/api/connect/orgs/co_1/login/${s1.id}`, { cookie: h.sam }))).login;
    expect(last.done).toBe(true);
    h.overlay.logins.delete(s1.id); // the engine's 60 s retention ended
    const late = await h.call("GET", `/api/connect/orgs/co_1/login/${s1.id}`, { cookie: h.sam });
    expect(late.status).toBe(200);
    expect((await j(late)).login).toMatchObject({ id: s1.id, done: true });
  });
});

describe("handing a connection to an organization's agents", () => {
  const KEYS = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX";
  const seed = async () => {
    expect((await h.call("PUT", "/api/connectors/anthropic/credential", { cookie: h.sam }, { apiKey: KEYS })).status).toBe(200);
  };

  it("sends the sealed key to the engine only for shared organizations and never shows it", async () => {
    await seed();
    const apply = () => h.call("POST", "/api/connect/orgs/co_1/apply/anthropic", { cookie: h.sam }, {});
    expect((await apply()).status).toBe(403); // not shared with the organization yet
    expect((await h.call("PATCH", "/api/connect/connections/anthropic", { cookie: h.sam }, { orgs: ["co_1"] })).status).toBe(200);
    const r = await apply();
    const body = await r.text();
    expect(r.status).toBe(200);
    expect(body).not.toContain(KEYS);
    expect(h.overlay.aiConnections[0]).toMatchObject({ provider: "anthropic", method: "api_key", ownership: "shared", apiKey: KEYS });
    const list = await h.call("GET", "/api/connect/orgs/co_1/ai", { cookie: h.sam });
    expect(await list.text()).not.toContain(KEYS);
    expect((await h.call("POST", "/api/connect/orgs/co_1/apply/anthropic", { cookie: h.lee }, {})).status).toBe(403); // operators can't
    expect(readFileSync(join(h.state.dir!, "state.json"), "utf8")).not.toContain(KEYS);
  });

  it("explains providers the engine can't hand to agents", async () => {
    await h.call("POST", "/api/connect/connections", { cookie: h.sam }, { catalog: "ollama", baseUrl: up.base });
    await h.call("PATCH", "/api/connect/connections/ollama", { cookie: h.sam }, { orgs: ["co_1"] });
    const r = await h.call("POST", "/api/connect/orgs/co_1/apply/ollama", { cookie: h.sam }, {});
    expect(r.status).toBe(400);
    expect((await j(r)).code).toBe("unsupported");
  });
});
