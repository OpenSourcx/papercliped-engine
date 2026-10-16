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
  h.eng.st.envs.set("env1", { id: "env1", name: "Northwind containers", driver: "sandbox", status: "active", metadata: { epaperclip: "agent-containers" } });
});
afterEach(async () => {
  await h.closeAll();
  await up.close();
});

const j = async (r: Response) => (await r.json()) as any;
const start = (body: Record<string, unknown>, cookie = h.sam, co = "co_1") => h.call("POST", `/api/connect/orgs/${co}/login`, { cookie }, body);
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
  });
});

describe("signing an organization's agents in with a subscription", () => {
  it("starts the login in the organization's container environment and relays only what the person needs", async () => {
    const r = await start({ provider: "openai", name: "Team Codex" });
    expect(r.status).toBe(201);
    const first = (await j(r)).login;
    expect(first).toMatchObject({ id: "ls1", status: "starting", adapter: "codex_local", provider: "openai", done: false });
    const sent = h.overlay.logins.get("ls1")!.body;
    expect(sent).toEqual({ aiConnection: { provider: "openai", method: "subscription", name: "Team Codex", ownership: "shared", allAgents: true }, environmentId: "env1" });
    const poll = await j(await h.call("GET", "/api/connect/orgs/co_1/login/ls1", { cookie: h.sam }));
    expect(poll.login).toMatchObject({ status: "waiting_for_browser", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH", done: false });
    const text = JSON.stringify(poll);
    expect(text).not.toContain("SECRETSECRET");
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("ZZZZ-9999");
    const done = await j(await h.call("GET", "/api/connect/orgs/co_1/login/ls1", { cookie: h.sam }));
    expect(done.login).toMatchObject({ status: "completed", done: true });
    expect(JSON.stringify(done)).not.toContain("SECRETSECRET");
    // Finished: the session is forgotten.
    expect((await h.call("GET", "/api/connect/orgs/co_1/login/ls1", { cookie: h.sam })).status).toBe(404);
    const audit = JSON.stringify(await j(await h.call("GET", "/api/access/audit", { cookie: h.sam })));
    expect(audit).toContain("connection.login.start");
    expect(audit).not.toContain("SECRETSECRET");
  });

  it("supports Claude's setup-token flow, including the code from the browser, never echoed back", async () => {
    const s = (await j(await start({ provider: "anthropic", flow: "setup-token" }))).login;
    expect(s).toMatchObject({ adapter: "claude_local", flow: "setup-token" });
    const code = "AbC123-browser-code";
    const r = await h.call("POST", `/api/connect/orgs/co_1/login/${s.id}/code`, { cookie: h.sam }, { browserCode: code });
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain(code);
    expect((await h.call("POST", `/api/connect/orgs/co_1/login/${s.id}/code`, { cookie: h.sam }, { browserCode: "has space" })).status).toBe(400);
    expect((await h.call("POST", `/api/connect/orgs/co_1/login/${s.id}/cancel`, { cookie: h.sam }, {})).status).toBe(200);
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
