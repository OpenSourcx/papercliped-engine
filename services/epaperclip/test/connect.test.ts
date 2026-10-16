import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calculate } from "../src/features/connect-tools.ts";
import { DENIED_SCHEMES, checkAllowEntry, checkRedirectUri, pkceMatches, redirectMatches } from "../src/features/connect-util.ts";
import { startConnectApp, pkce, type ConnectApp } from "./fakes-connect.ts";

let h: ConnectApp;
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "epc-console-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>console</title>");
  h = await startConnectApp({ staticDir: dir });
});
afterEach(async () => {
  await h.closeAll();
});

const j = async (r: Response) => (await r.json()) as any;
const stateText = () => readFileSync(join(h.state.dir!, "state.json"), "utf8");
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) });

describe("redirect address rules", () => {
  it("accepts https and loopback http, nothing else", () => {
    expect(checkRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(checkRedirectUri("http://127.0.0.1:8123/callback")).toBe("http://127.0.0.1:8123/callback");
    expect(checkRedirectUri("http://localhost/cb")).toBe("http://localhost/cb");
    for (const bad of ["http://example.com/cb", "javascript:alert(1)", "data:text/html,x", "myapp://cb", "https://a.example/cb#frag", "https://user:pw@a.example/cb", "https://*.example.com/cb", "https://a.example/ cb", "", "not a url", "ftp://a.example/", `https://a.example/${"x".repeat(2100)}`, "http://127.0.0.1.evil.com/cb", "http://[::2]/cb"])
      expect(() => checkRedirectUri(bad), bad.slice(0, 40)).toThrow();
    expect(() => checkRedirectUri(42)).toThrow();
  });
  it("refuses app-specific schemes by default and accepts them only when an administrator listed them", () => {
    const cursor = "cursor://anysphere.cursor-mcp/oauth/callback";
    expect(() => checkRedirectUri(cursor)).toThrow(/administrator/);
    expect(() => checkRedirectUri(cursor, [])).toThrow();
    expect(checkRedirectUri(cursor, [{ uri: cursor, kind: "exact" }])).toBe(cursor);
    expect(checkRedirectUri(cursor, [{ uri: "cursor://anysphere.cursor-mcp/", kind: "prefix" }])).toBe(cursor);
    // Not the same address, and not another app that merely starts with the same letters.
    expect(() => checkRedirectUri("cursor://anysphere.cursor-mcp/oauth/other", [{ uri: cursor, kind: "exact" }])).toThrow();
    expect(() => checkRedirectUri("cursor://anysphere.cursor-mcp-evil/oauth/callback", [{ uri: "cursor://anysphere.cursor-mcp/", kind: "prefix" }])).toThrow();
    expect(() => checkRedirectUri("vscode://x.y/cb", [{ uri: "cursor://anysphere.cursor-mcp/", kind: "prefix" }])).toThrow();
    // The checks that apply to every address still apply.
    expect(() => checkRedirectUri(`${cursor}#frag`, [{ uri: cursor, kind: "exact" }])).toThrow();
    expect(() => checkRedirectUri("cursor://u:p@anysphere.cursor-mcp/cb", [{ uri: "cursor://u:p@anysphere.cursor-mcp/cb", kind: "exact" }])).toThrow();
  });
  it("never accepts a denied scheme, even if one somehow reached the list", () => {
    for (const scheme of ["javascript", "data", "file", "blob", "about", "vbscript", "ws", "wss"]) {
      expect(DENIED_SCHEMES).toContain(scheme);
      const uri = `${scheme}://example/cb`;
      expect(() => checkRedirectUri(uri, [{ uri, kind: "exact" }, { uri: `${scheme}://example/`, kind: "prefix" }]), scheme).toThrow();
      expect(() => checkAllowEntry(uri, "exact"), scheme).toThrow(/never be allowed/);
    }
    expect(() => checkRedirectUri("javascript:alert(1)", [{ uri: "javascript:alert(1)", kind: "exact" }])).toThrow();
    // Plain http beyond loopback stays refused and can't be listed; https needs no listing.
    expect(() => checkRedirectUri("http://example.com/cb", [{ uri: "http://example.com/cb", kind: "exact" }])).toThrow();
    expect(() => checkAllowEntry("http://example.com/cb", "exact")).toThrow();
    expect(() => checkAllowEntry("https://example.com/cb", "exact")).toThrow();
  });
  it("only lists specific, plain addresses", () => {
    expect(checkAllowEntry("cursor://anysphere.cursor-mcp/oauth/callback", "exact")).toMatchObject({ scheme: "cursor", kind: "exact" });
    expect(checkAllowEntry("vscode://vscode.github-authentication/", "prefix")).toMatchObject({ scheme: "vscode", kind: "prefix" });
    for (const [uri, kind] of [["cursor://", "prefix"], ["cursor:///", "prefix"], ["cursor://app", "prefix"], ["cursor://app/*", "exact"], ["cursor://app/cb#x", "exact"], ["cursor://app/ cb", "exact"], ["cursor://a/", "weird"], ["", "exact"], ["not a url", "exact"], ["cursor://u:p@app/", "prefix"]] as const)
      expect(() => checkAllowEntry(uri, kind), `${uri} ${kind}`).toThrow();
    expect(() => checkAllowEntry(42, "exact")).toThrow();
  });
  it("matches exactly, except that a loopback address may use any port", () => {
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb")).toBe(true);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb2")).toBe(false);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb?x=1")).toBe(false);
    expect(redirectMatches(["http://127.0.0.1/cb"], "http://127.0.0.1:5555/cb")).toBe(true);
    expect(redirectMatches(["http://127.0.0.1/cb"], "http://127.0.0.1:5555/other")).toBe(false);
    expect(redirectMatches(["https://a.example:8443/cb"], "https://a.example:9999/cb")).toBe(false);
  });
  it("checks PKCE strictly", () => {
    const { verifier, challenge } = pkce();
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches(verifier + "x", challenge)).toBe(false);
    expect(pkceMatches("short", challenge)).toBe(false);
    expect(pkceMatches(verifier, "plain")).toBe(false);
  });
});

describe("discovery", () => {
  it("publishes the protected resource and the authorization server, open to other origins", async () => {
    const pr = await fetch(`${h.base}/.well-known/oauth-protected-resource`);
    expect(pr.status).toBe(200);
    expect(pr.headers.get("access-control-allow-origin")).toBe("*");
    const prj = await j(pr);
    expect(prj).toMatchObject({ resource: `${h.base}/mcp`, authorization_servers: [h.base], scopes_supported: ["paperclip:read", "paperclip:control"], bearer_methods_supported: ["header"] });
    expect((await j(await fetch(`${h.base}/.well-known/oauth-protected-resource/mcp`))).resource).toBe(`${h.base}/mcp`);
    const as = await j(await fetch(`${h.base}/.well-known/oauth-authorization-server`));
    expect(as).toMatchObject({ issuer: h.base, authorization_endpoint: `${h.base}/oauth/authorize`, token_endpoint: `${h.base}/oauth/token`, registration_endpoint: `${h.base}/oauth/register`, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], grant_types_supported: ["authorization_code", "refresh_token"] });
    const pre = await fetch(`${h.base}/oauth/token`, { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("Authorization");
  });
  it("keeps the strict content security policy on every response", async () => {
    for (const path of ["/.well-known/oauth-authorization-server", "/mcp", "/oauth/authorize?client_id=x"]) {
      const r = await fetch(h.base + path);
      expect(r.headers.get("content-security-policy"), path).toContain("script-src 'self'");
      expect(r.headers.get("content-security-policy"), path).not.toContain("unsafe");
    }
  });
});

describe("registering an app", () => {
  it("registers a public client and refuses unsafe metadata", async () => {
    const post = (body: unknown) => fetch(`${h.base}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const ok = await post({ client_name: "Codex‮", redirect_uris: ["http://127.0.0.1:1455/auth/callback"] });
    expect(ok.status).toBe(201);
    const c = await j(ok);
    expect(c).toMatchObject({ token_endpoint_auth_method: "none", redirect_uris: ["http://127.0.0.1:1455/auth/callback"] });
    expect(c.client_name).toBe("Codex");
    expect(c.client_secret).toBeUndefined();
    for (const body of [{}, { redirect_uris: [] }, { redirect_uris: ["http://evil.example/cb"] }, { redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" }, { redirect_uris: ["https://a.example/cb"], grant_types: ["password"] }, { redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`) }, { redirect_uris: ["https://a.example/cb"], scope: "admin" }]) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await j(r)).error).toMatch(/invalid_/);
    }
  });
  it("limits registrations per address", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await fetch(`${h.base}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://a.example/cb"] }) })).status;
    expect(last).toBe(429);
  });
});

describe("authorizing in the console", () => {
  const params = (client_id: string, over: Record<string, string> = {}) => {
    const { challenge } = pkce();
    return new URLSearchParams({ client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", response_type: "code", scope: "paperclip:read", state: "s1", code_challenge: challenge, code_challenge_method: "S256", ...over });
  };

  it("answers an unknown app or a wrong redirect address with an error page, never a redirect", async () => {
    const unknown = await fetch(`${h.base}/oauth/authorize?${params("nope")}`, { redirect: "manual" });
    expect(unknown.status).toBe(400);
    expect((await j(unknown)).error).toBe("invalid_client");
    const { client_id } = await h.register();
    const wrong = await fetch(`${h.base}/oauth/authorize?${params(client_id, { redirect_uri: "https://evil.example/cb" })}`, { redirect: "manual" });
    expect(wrong.status).toBe(400);
    expect(wrong.headers.get("location")).toBeNull();
    const fine = await fetch(`${h.base}/oauth/authorize?${params(client_id)}`, { redirect: "manual" });
    expect(fine.status).toBe(200);
    expect(await fine.text()).toContain("<title>console</title>"); // the console's consent page
  });

  it("describes the request to a signed-in person, and checks every part", async () => {
    const { client_id } = await h.register();
    const ask = (over: Record<string, string> = {}, cookie: string | null = h.sam) => h.call("GET", `/api/connect/oauth/request?${params(client_id, over)}`, { cookie: cookie ?? undefined });
    const r = await ask();
    expect(r.status).toBe(200);
    const body = await j(r);
    expect(body).toMatchObject({ client: { name: "Claude", redirectHost: "claude.ai" }, scope: "paperclip:read", user: "sam@pve" });
    expect(body.orgs.map((o: any) => o.id).sort()).toEqual(["co_1", "co_2"]);
    expect((await ask({}, null)).status).toBe(401);
    for (const bad of [{ response_type: "token" }, { code_challenge_method: "plain" }, { code_challenge: "short" }, { scope: "paperclip:admin" }, { resource: "https://elsewhere.example/mcp" }, { redirect_uri: "https://claude.ai/other" }, { state: "a\nb" }] as Record<string, string>[])
      expect((await ask(bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await ask({ resource: `${h.base}/mcp` })).status).toBe(200);
    // Highest asked-for scope wins.
    expect((await j(await ask({ scope: "paperclip:read paperclip:control" }))).scope).toBe("paperclip:control");
  });

  it("is for a signed-in browser session, never a token", async () => {
    const { client_id } = await h.register();
    expect((await h.call("GET", `/api/connect/oauth/request?${params(client_id)}`, {})).status).toBe(401);
    const t = await h.connect();
    const r = await h.call("GET", `/api/connect/oauth/request?${params(client_id)}`, { bearer: t.access });
    expect([401, 403]).toContain(r.status);
  });

  it("sends the person back with a code, state and issuer, and makes a real Proxmox token that the app never sees", async () => {
    const t = await h.connect({ scope: "paperclip:control" });
    expect(t.access).toMatch(/^epo_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(t.refresh).toMatch(/^epr_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    const toks = [...(h.pve.tokens.get("sam@pve") ?? [])];
    expect(toks).toHaveLength(1);
    expect(toks[0][0]).toMatch(/^epc-[0-9a-f]{16}$/);
    expect(toks[0][1].privsep).toBeFalsy();
    // The credential shows up in the Access screen's token list under the app's name, so it can be revoked there too.
    const list = await j(await h.call("GET", "/api/access/epc-tokens", { cookie: h.sam }));
    expect(list.tokens.map((x: any) => x.name)).toContain("App: Claude (Full control)");
    // At rest: hashes and sealed values only.
    const disk = stateText();
    for (const secret of [t.access.split("_")[2], t.refresh.split("_")[2], toks[0][1].secret]) expect(disk).not.toContain(secret);
  });

  it("carries a refusal back as access_denied", async () => {
    const { client_id } = await h.register();
    const p = pkce();
    const r = await h.call("POST", "/api/connect/oauth/consent", { cookie: h.sam }, { client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", response_type: "code", scope: "paperclip:read", state: "zz", code_challenge: p.challenge, code_challenge_method: "S256", approve: false });
    const to = new URL((await j(r)).redirect);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("zz");
    expect(to.searchParams.get("code")).toBeNull();
    expect(h.pve.tokens.get("sam@pve")?.size ?? 0).toBe(0);
  });

  it("only lets the person narrow the request and share organizations they belong to", async () => {
    const { client_id } = await h.register();
    const p = pkce();
    const body = { client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", response_type: "code", scope: "paperclip:read", state: "q", code_challenge: p.challenge, code_challenge_method: "S256", approve: true };
    // lee isn't in co_2.
    expect((await h.call("POST", "/api/connect/oauth/consent", { cookie: h.lee }, { ...body, orgs: ["co_2"] })).status).toBe(400);
    expect((await h.call("POST", "/api/connect/oauth/consent", { cookie: h.lee }, { ...body, orgs: ["../x"] })).status).toBe(400);
    expect((await h.call("POST", "/api/connect/oauth/consent", { cookie: h.lee }, { ...body, orgs: ["co_1"] })).status).toBe(200);
    // Asking for read can't be turned into control by the page.
    const g = await j(await h.call("GET", "/api/connect/apps", { cookie: h.lee }));
    expect(g.apps).toEqual([]); // not exchanged yet, so not active
  });
});

describe("the token endpoint", () => {
  const start = async (over: { scope?: string } = {}) => {
    const { client_id, redirect } = await h.register();
    const p = pkce();
    const r = await h.call("POST", "/api/connect/oauth/consent", { cookie: h.sam }, { client_id, redirect_uri: redirect, response_type: "code", scope: over.scope ?? "paperclip:read", state: "s", code_challenge: p.challenge, code_challenge_method: "S256", approve: true });
    const code = new URL((await j(r)).redirect).searchParams.get("code")!;
    return { client_id, redirect, code, ...p };
  };
  const exchange = (o: Record<string, string>) => fetch(`${h.base}/oauth/token`, form({ grant_type: "authorization_code", ...o }));

  it("needs the right client, redirect address and PKCE verifier, and the code works once", async () => {
    const s = await start();
    expect((await exchange({ code: s.code, redirect_uri: s.redirect, client_id: "other", code_verifier: s.verifier })).status).toBe(400);
    const s2 = await start();
    expect((await exchange({ code: s2.code, redirect_uri: "https://claude.ai/different", client_id: s2.client_id, code_verifier: s2.verifier })).status).toBe(400);
    const s3 = await start();
    const wrongVerifier = await exchange({ code: s3.code, redirect_uri: s3.redirect, client_id: s3.client_id, code_verifier: pkce().verifier });
    expect(wrongVerifier.status).toBe(400);
    expect((await j(wrongVerifier)).error).toBe("invalid_grant");
    // A code already tried (even wrongly) is spent.
    const s4 = await start();
    const good = await exchange({ code: s4.code, redirect_uri: s4.redirect, client_id: s4.client_id, code_verifier: s4.verifier });
    expect(good.status).toBe(200);
    const body = await j(good);
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "paperclip:read" });
    expect(good.headers.get("cache-control")).toBe("no-store");
    const again = await exchange({ code: s4.code, redirect_uri: s4.redirect, client_id: s4.client_id, code_verifier: s4.verifier });
    expect(again.status).toBe(400);
    // Presenting a used code ends the grant it made.
    expect((await h.mcp(body.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });

  it("refuses an expired code and anything that isn't a known grant type", async () => {
    const s = await start();
    h.clock.t += 61_000;
    expect((await exchange({ code: s.code, redirect_uri: s.redirect, client_id: s.client_id, code_verifier: s.verifier })).status).toBe(400);
    const r = await fetch(`${h.base}/oauth/token`, form({ grant_type: "password", username: "sam", password: "x" }));
    expect((await j(r)).error).toBe("unsupported_grant_type");
    expect((await fetch(`${h.base}/oauth/token`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" })).status).toBe(415);
  });

  it("rotates refresh tokens, and ends the connection if an old one comes back", async () => {
    const t = await h.connect();
    const refresh = (token: string) => fetch(`${h.base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: token, client_id: t.clientId }));
    const r1 = await refresh(t.refresh);
    expect(r1.status).toBe(200);
    const n = await j(r1);
    expect(n.refresh_token).not.toBe(t.refresh);
    expect((await h.mcp(n.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
    // The first access token was replaced.
    expect((await h.mcp(t.access, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    // Using the old refresh token again: a copy was taken, so everything of this connection ends.
    expect((await refresh(t.refresh)).status).toBe(400);
    expect((await h.mcp(n.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    expect((await refresh(n.refresh_token)).status).toBe(400);
    expect([...(h.pve.tokens.get("sam@pve") ?? [])]).toHaveLength(1); // still queued for deletion until sam is next signed in
    const apps = await j(await h.call("GET", "/api/connect/apps", { cookie: h.sam }));
    expect(apps.apps).toEqual([]);
    expect([...(h.pve.tokens.get("sam@pve") ?? [])]).toHaveLength(0); // swept
  });

  it("refuses another app's refresh token and expired connections", async () => {
    const t = await h.connect();
    const other = await h.register("https://chatgpt.com/connector_platform_oauth_redirect", "ChatGPT");
    expect((await fetch(`${h.base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: other.client_id }))).status).toBe(400);
    h.clock.t += 91 * 86_400_000;
    expect((await fetch(`${h.base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: t.clientId }))).status).toBe(400);
  });

  it("limits requests and bad tries per address", async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await fetch(`${h.base}/oauth/token`, form({ grant_type: "authorization_code", code: "bogus", client_id: "x", redirect_uri: "https://a.example/cb", code_verifier: "y" }))).status;
    expect(last).toBe(429);
  });

  it("revokes at the app's request", async () => {
    const t = await h.connect();
    expect((await fetch(`${h.base}/oauth/revoke`, form({ token: t.refresh, client_id: t.clientId }))).status).toBe(200);
    expect((await h.mcp(t.access, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    // Same answer for rubbish.
    expect((await fetch(`${h.base}/oauth/revoke`, form({ token: "nonsense" }))).status).toBe(200);
  });
});

describe("the MCP endpoint", () => {
  const rpc = (method: string, params?: unknown, id: number | undefined = 1) => ({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) });

  it("tells an app without a token where to sign in", async () => {
    const r = await h.mcp(null, rpc("initialize", { protocolVersion: "2025-06-18" }));
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer realm="ePaperclip", resource_metadata="${h.base}/.well-known/oauth-protected-resource", scope="paperclip:read"`);
    const bad = await h.mcp("epo_0000000000000000_" + "a".repeat(43), rpc("ping"));
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await h.mcp("rubbish", rpc("ping"))).status).toBe(401);
    expect((await fetch(`${h.base}/mcp`)).status).toBe(405);
  });

  it("speaks MCP: initialize, ping, notifications, batches, errors", async () => {
    const t = await h.connect({ scope: "paperclip:read" });
    const init = await j(await h.mcp(t.access, rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } })));
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "epaperclip" } });
    expect(init.result.instructions).toContain("Read only");
    expect((await j(await h.mcp(t.access, rpc("initialize", { protocolVersion: "1999-01-01" })))).result.protocolVersion).toBe("2025-11-25");
    expect((await h.mcp(t.access, rpc("notifications/initialized", undefined, undefined))).status).toBe(202);
    const batch = await j(await h.mcp(t.access, [rpc("ping", undefined, 1), rpc("notifications/initialized", undefined, undefined), rpc("ping", undefined, 2)]));
    expect(batch.map((x: any) => x.id)).toEqual([1, 2]);
    expect((await j(await h.mcp(t.access, rpc("nope")))).error.code).toBe(-32601);
    expect((await j(await h.mcp(t.access, { id: 1, method: "ping" }))).error.code).toBe(-32600);
    expect((await h.mcp(t.access, rpc("ping"), { "MCP-Protocol-Version": "1999-01-01" })).status).toBe(400);
    expect((await h.mcp(t.access, Array.from({ length: 21 }, (_, i) => rpc("ping", undefined, i + 1)))).status).toBe(200);
    const raw = await fetch(`${h.base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${t.access}`, "Content-Type": "application/json" }, body: "{nope" });
    expect((await j(raw)).error.code).toBe(-32700);
    expect((await fetch(`${h.base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${t.access}`, "Content-Type": "text/plain" }, body: "x" })).status).toBe(415);
  });

  it("offers Read only apps only the read tools, and Full control apps all of them", async () => {
    const ro = await h.connect({ scope: "paperclip:read" });
    const rw = await h.connect({ scope: "paperclip:control" });
    const names = async (t: string) => (await j(await h.mcp(t, rpc("tools/list")))).result.tools.map((x: any) => x.name) as string[];
    const readNames = await names(ro.access);
    const allNames = await names(rw.access);
    expect(readNames).toEqual(expect.arrayContaining(["host_status", "list_machines", "list_issues", "calculate"]));
    for (const w of ["power_machine", "create_issue", "decide_approval", "propose_plan", "fetch_url"]) expect(readNames).not.toContain(w);
    expect(allNames).toEqual(expect.arrayContaining([...readNames, "power_machine", "create_issue", "decide_approval", "propose_plan", "snapshot_machine"]));
    expect(allNames).not.toContain("fetch_url"); // off until an administrator allows it
    const tools = (await j(await h.mcp(rw.access, rpc("tools/list")))).result.tools;
    expect(tools.find((x: any) => x.name === "host_status").annotations.readOnlyHint).toBe(true);
    expect(tools.find((x: any) => x.name === "power_machine").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    // A control tool asked of a Read only app is said plainly.
    const denied = await h.tool(ro.access, "create_issue", { companyId: "co_1", title: "x" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("Read only");
    expect(h.overlay.seen).toEqual([]);
    expect((await j(await h.mcp(ro.access, rpc("tools/call", { name: "no_such_tool" })))).error.code).toBe(-32602);
  });

  it("reads this host and the organizations as the person, so Proxmox decides what comes back", async () => {
    const sam = await h.connect({ scope: "paperclip:read" });
    const lee = await h.connect({ cookie: h.lee, scope: "paperclip:read" });
    const samList = await h.tool(sam.access, "list_machines");
    expect(samList.data.machines.map((m: any) => m.vmid).sort()).toEqual([101, 102, 200]);
    const leeList = await h.tool(lee.access, "list_machines");
    expect(leeList.data.machines.map((m: any) => m.vmid)).toContain(101);
    expect((await h.tool(sam.access, "host_status")).data).toMatchObject({ node: "pve", version: expect.any(String) });
    const detail = await h.tool(sam.access, "machine_detail", { vmid: 101 });
    expect(detail.data.name).toBe("web");
    expect(detail.text).not.toContain("hunter2"); // credentials in a config stay out
    expect(detail.text).not.toContain("ssh-rsa");
    expect((await h.tool(sam.access, "cluster_status")).data.entries[0]).toMatchObject({ type: "node", name: "pve", online: true });
    expect((await h.tool(sam.access, "machine_snapshots", { vmid: 101 })).data.vmid).toBe(101);
    expect((await h.tool(sam.access, "machine_detail", { vmid: 101.5 })).isError).toBe(true);
    expect((await h.tool(sam.access, "list_organizations")).data.organizations.map((o: any) => o.id).sort()).toEqual(["co_1", "co_2"]);
    expect((await h.tool(lee.access, "list_organizations")).data.organizations.map((o: any) => o.id)).toEqual(["co_1"]);
    expect((await h.tool(sam.access, "list_issues", { companyId: "co_1" })).data.issues[0]).toMatchObject({ identifier: "NW-1" });
    expect((await h.tool(lee.access, "list_issues", { companyId: "co_2" })).isError).toBe(true); // lee isn't a member: the engine says no
    expect((await h.tool(sam.access, "get_issue", { issueId: "i1" })).data.description).toBe("Do the thing");
    expect((await h.tool(sam.access, "get_agent", { agentId: "ag1" })).data.name).toBe("CEO");
    expect((await h.tool(sam.access, "list_approvals", { companyId: "co_1" })).data.approvals).toHaveLength(1);
    expect((await h.tool(sam.access, "org_costs", { companyId: "co_1" })).data.spendCents).toBe(1234);
    expect((await h.tool(sam.access, "current_time")).data.utc).toMatch(/^2026-/);
    expect((await h.tool(sam.access, "calculate", { expression: "2*(3+4)^2" })).data.result).toBe(98);
    // Unknown arguments are refused, not ignored.
    expect((await h.tool(sam.access, "list_issues", { companyId: "co_1", sneaky: 1 })).isError).toBe(true);
    expect((await h.tool(sam.access, "list_issues", { companyId: "../x" })).isError).toBe(true);
  });

  it("a Read only app's Proxmox client cannot write, whatever the tools do", async () => {
    const ro = await h.connect({ scope: "paperclip:read" });
    const before = h.pve.calls.length;
    // Even a tool that tried would fail: the transport refuses anything but GET.
    const grant = await j(await h.call("GET", "/api/connect/apps", { cookie: h.sam }));
    expect(grant.apps[0].scope).toBe("paperclip:read");
    const { connectOf } = await import("../src/features/connect-oauth.ts");
    const svc = connectOf(h.state)!;
    const principal = await svc.authenticate({ headers: { authorization: `Bearer ${ro.access}` }, socket: { remoteAddress: "127.0.0.1" } } as any);
    const pve = svc.clientFor(principal);
    await expect(pve.call("POST", "/nodes/pve/lxc/101/status/stop")).rejects.toThrow(/read-only/);
    await expect(pve.call("DELETE", "/nodes/pve/lxc/101")).rejects.toThrow(/read-only/);
    await expect(pve.version()).resolves.toBeTruthy();
    expect(h.pve.calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("limits tool calls per minute for each connection", async () => {
    const t = await h.connect({ scope: "paperclip:read" });
    let last = "";
    for (let i = 0; i < 95; i++) last = (await h.tool(t.access, "current_time")).text;
    expect(last).toContain("Too many tool calls");
  });
});

describe("what Full control may do", () => {
  it("turns host changes into plans the person approves, and nothing runs", async () => {
    const t = await h.connect({ scope: "paperclip:control" });
    const before = h.pve.calls.filter((c) => c.method !== "GET").length;
    const r = await h.tool(t.access, "power_machine", { vmid: 101, action: "shutdown" });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ status: "proposed", summary: expect.stringContaining("Shut down machine 101") });
    expect(r.data.note).toContain("NOTHING has run");
    expect(h.pve.guests.get(101)!.status).toBe("running");
    expect(h.pve.calls.filter((c) => c.method !== "GET" && !/\/access\//.test(c.path)).length).toBe(before);
    const plans = await j(await h.call("GET", "/api/pin/plans", { cookie: h.sam }));
    expect(plans.plans).toHaveLength(1);
    expect(plans.plans[0]).toMatchObject({ createdBy: "app", title: expect.stringContaining("Claude"), status: "pending" });
    expect(plans.plans[0].steps[0]).toMatchObject({ destructive: true, confirmPhrase: "shutdown 101", state: "pending" });
    // The person approves it in the console with the typed phrase; that's the only way it runs.
    const step = plans.plans[0].steps[0].id;
    expect((await h.call("POST", `/api/pin/plans/${plans.plans[0].id}/steps/${step}/approve`, { cookie: h.sam }, {})).status).toBe(409);
    expect((await h.call("POST", `/api/pin/plans/${plans.plans[0].id}/steps/${step}/approve`, { cookie: h.sam }, { confirm: "shutdown 101" })).status).toBe(200);
    expect(h.pve.guests.get(101)!.status).toBe("stopped");
  });

  it("proposes multi-step plans and checks that the person can see the machines", async () => {
    const t = await h.connect({ scope: "paperclip:control" });
    const ok = await h.tool(t.access, "propose_plan", { title: "Patch night", steps: [{ kind: "snapshot", vmid: 101, name: "before-patch" }, { kind: "power", vmid: 101, action: "reboot" }] });
    expect(ok.data.steps).toHaveLength(2);
    expect((await h.tool(t.access, "propose_plan", { title: "x", steps: [{ kind: "power", vmid: 999, action: "start" }] })).isError).toBe(true);
    expect((await h.tool(t.access, "propose_plan", { title: "x", steps: [{ kind: "power", vmid: 101, action: "format" }] })).isError).toBe(true);
    expect((await h.tool(t.access, "propose_plan", { title: "x", steps: [] })).isError).toBe(true);
    expect((await h.tool(t.access, "snapshot_machine", { vmid: 101, name: "bad name!" })).isError).toBe(true);
  });

  it("with 'act without asking' on, only non-destructive changes run at once; destructive ones are always a plan, whatever phrase the app sends", async () => {
    const t = await h.connect({ scope: "paperclip:control", direct: true });
    const apps = await j(await h.call("GET", "/api/connect/apps", { cookie: h.sam }));
    expect(apps.apps[0]).toMatchObject({ direct: true, scope: "paperclip:control" });
    // A destructive step without the phrase becomes a plan, not an action or an error asking for the phrase.
    const noConfirm = await h.tool(t.access, "power_machine", { vmid: 101, action: "stop" });
    expect(noConfirm.isError).toBeFalsy();
    expect(noConfirm.data.status).toBe("proposed");
    expect(h.pve.guests.get(101)!.status).toBe("running");
    // An app that sends the exact phrase still gets a plan: it cannot confirm for the person.
    const withPhrase = await h.tool(t.access, "power_machine", { vmid: 101, action: "stop", confirm: "stop 101" });
    expect(withPhrase.data.status).toBe("proposed");
    expect(withPhrase.data.note).toContain("ignored");
    expect(h.pve.guests.get(101)!.status).toBe("running");
    for (const [tool, args] of [["power_machine", { vmid: 101, action: "shutdown", confirm: "shutdown 101" }], ["power_machine", { vmid: 101, action: "reboot", confirm: "reboot 101" }], ["delete_snapshot", { vmid: 101, name: "snap1", confirm: "delete 101" }], ["rollback_snapshot", { vmid: 101, name: "snap1", confirm: "rollback 101" }]] as const)
      expect((await h.tool(t.access, tool, args)).data.status, tool).toBe("proposed");
    expect(h.pve.guests.get(101)!.status).toBe("running");
    // The plans wait for the person; only the signed-in person's own typed phrase runs them.
    const plans = await j(await h.call("GET", "/api/pin/plans", { cookie: h.sam }));
    const stop = plans.plans.find((p: any) => p.steps[0].confirmPhrase === "stop 101");
    expect(stop.steps[0]).toMatchObject({ destructive: true, state: "pending" });
    expect((await h.call("POST", `/api/pin/plans/${stop.id}/steps/${stop.steps[0].id}/approve`, { cookie: h.sam }, {})).status).toBe(409);
    expect(h.pve.guests.get(101)!.status).toBe("running");
    expect((await h.call("POST", `/api/pin/plans/${stop.id}/steps/${stop.steps[0].id}/approve`, { cookie: h.sam }, { confirm: "stop 101" })).status).toBe(200);
    expect(h.pve.guests.get(101)!.status).toBe("stopped");
    // A protected machine is refused outright, with or without the phrase.
    const prot = await h.tool(t.access, "power_machine", { vmid: 102, action: "stop", confirm: "stop 102" });
    expect(prot.isError).toBe(true);
    expect(prot.text).toContain("protected");
    expect(h.pve.guests.get(102)!.status).toBe("running");
    // Starting and snapshots still run at once, as sam.
    expect((await h.tool(t.access, "power_machine", { vmid: 200, action: "start" })).data.status).toBe("started");
    expect((await h.tool(t.access, "snapshot_machine", { vmid: 200, name: "snap1" })).data.status).toBe("started");
    // Proxmox still decides: lee can't manage machine 200.
    const lee = await h.connect({ cookie: h.lee, scope: "paperclip:control", direct: true });
    expect((await h.tool(lee.access, "power_machine", { vmid: 200, action: "start" })).isError).toBe(true);
    // The audit trail names the app and the tool.
    const audit = await j(await h.call("GET", "/api/access/audit", { cookie: h.sam }));
    expect(JSON.stringify(audit)).toContain("Claude: power_machine");
  });

  it("acts in the engine as the person, within the organizations they shared", async () => {
    const t = await h.connect({ scope: "paperclip:control", orgs: ["co_1"] });
    const created = await h.tool(t.access, "create_issue", { companyId: "co_1", title: "Check backups", description: "Nightly", priority: "high" });
    expect(created.data.created).toBe(true);
    expect(h.overlay.seen.at(-1)).toMatchObject({ method: "POST", url: "/api/companies/co_1/issues", body: { title: "Check backups", description: "Nightly", priority: "high" } });
    expect((await h.tool(t.access, "comment_issue", { issueId: "i1", body: "On it" })).data.commented).toBe(true);
    expect((await h.tool(t.access, "update_issue", { issueId: "i1", status: "in_progress" })).data.changed).toEqual(["status"]);
    expect((await h.tool(t.access, "update_issue", { issueId: "i1" })).isError).toBe(true);
    expect((await h.tool(t.access, "update_issue", { issueId: "i1", status: "weird" })).isError).toBe(true);
    expect((await h.tool(t.access, "wake_agent", { agentId: "ag1", reason: "Please look" })).data.woken).toBe(true);
    expect(h.overlay.seen.at(-1)!.body).toMatchObject({ source: "on_demand", forceFreshSession: false, reason: "Please look" });
    expect((await h.tool(t.access, "pause_agent", { agentId: "ag1" })).data.paused).toBe(true);
    expect(h.overlay.agents.get("ag1")!.status).toBe("paused");
    expect((await h.tool(t.access, "resume_agent", { agentId: "ag1" })).data.resumed).toBe(true);
    expect((await h.tool(t.access, "decide_approval", { approvalId: "ap1", decision: "approve", note: "ok" })).data.decided).toBe("approve");
    expect(h.overlay.approvals.get("ap1")!.status).toBe("approved");
    expect((await h.tool(t.access, "create_goal", { companyId: "co_1", title: "Grow", level: "team" })).data.created).toBe(true);
    // The other organization is out of bounds, whether asked for by organization or by item id.
    for (const [name, args] of [["create_issue", { companyId: "co_2", title: "x" }], ["list_issues", { companyId: "co_2" }], ["get_issue", { issueId: "i9" }], ["comment_issue", { issueId: "i9", body: "x" }], ["wake_agent", { agentId: "ag9" }], ["decide_approval", { approvalId: "ap9", decision: "approve" }], ["org_summary", { companyId: "co_2" }]] as const) {
      const r = await h.tool(t.access, name, args as any);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toContain("wasn't given access");
    }
    expect(h.overlay.approvals.get("ap9")!.status).toBe("pending");
    expect((await h.tool(t.access, "list_organizations")).data.organizations.map((o: any) => o.id)).toEqual(["co_1"]);
  });

  it("keeps web fetching off until an administrator turns it on", async () => {
    const t = await h.connect({ scope: "paperclip:control" });
    const names = async () => (await j(await h.mcp(t.access, { jsonrpc: "2.0", id: 1, method: "tools/list" }))).result.tools.map((x: any) => x.name) as string[];
    expect(await names()).not.toContain("fetch_url");
    expect((await h.call("PUT", "/api/connect/settings", { cookie: h.lee }, { fetchUrl: true })).status).toBe(403);
    expect((await h.call("PUT", "/api/connect/settings", { cookie: h.sam }, { fetchUrl: true })).status).toBe(200);
    expect(await names()).toContain("fetch_url");
    const r = await h.tool(t.access, "fetch_url", { url: "http://127.0.0.1/" });
    expect(r.isError).toBe(true); // https and public addresses only
    expect((await h.tool(t.access, "fetch_url", { url: "https://localhost/" })).isError).toBe(true);
  });
});

describe("connected apps in the console", () => {
  it("lists, narrows, revokes, and ends access at once", async () => {
    const a = await h.connect({ scope: "paperclip:control", name: "Claude" });
    const b = await h.connect({ scope: "paperclip:read", name: "ChatGPT", redirect: "https://chatgpt.com/connector_platform_oauth_redirect" });
    const apps = (await j(await h.call("GET", "/api/connect/apps", { cookie: h.sam }))).apps as any[];
    expect(apps.map((x) => x.clientName).sort()).toEqual(["ChatGPT", "Claude"]);
    expect(JSON.stringify(apps)).not.toMatch(/hash|salt|epo_|epr_/);
    const claude = apps.find((x) => x.clientName === "Claude");
    expect(claude).toMatchObject({ clientHost: "claude.ai", userid: "sam@pve" });
    // Narrow to read only: the tools shrink straight away.
    const patched = await h.call("PATCH", `/api/connect/apps/${claude.id}`, { cookie: h.sam }, { scope: "paperclip:read", orgs: ["co_1"] });
    expect(patched.status).toBe(200);
    expect((await h.tool(a.access, "create_issue", { companyId: "co_1", title: "x" })).text).toContain("Read only");
    expect((await h.call("PATCH", `/api/connect/apps/${claude.id}`, { cookie: h.sam }, { admin: true })).status).toBe(400);
    expect((await h.call("PATCH", `/api/connect/apps/${claude.id}`, { cookie: h.sam }, { scope: "paperclip:root" })).status).toBe(400);
    // lee can neither see nor change sam's apps; an administrator can see all.
    expect((await j(await h.call("GET", "/api/connect/apps", { cookie: h.lee }))).apps).toEqual([]);
    expect((await h.call("DELETE", `/api/connect/apps/${claude.id}`, { cookie: h.lee })).status).toBe(403);
    expect((await j(await h.call("GET", "/api/connect/apps?all=1", { cookie: h.sam }))).apps).toHaveLength(2);
    expect((await j(await h.call("GET", "/api/connect/apps?all=1", { cookie: h.lee }))).apps).toEqual([]);
    // Revoke: the Proxmox token goes with it.
    const del = await h.call("DELETE", `/api/connect/apps/${claude.id}`, { cookie: h.sam });
    expect(del.status).toBe(200);
    expect((await j(del)).warnings).toEqual([]);
    expect((await h.mcp(a.access, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    expect((await fetch(`${h.base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: a.refresh, client_id: a.clientId }))).status).toBe(400);
    expect([...(h.pve.tokens.get("sam@pve") ?? [])]).toHaveLength(1);
    expect((await h.mcp(b.access, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
    expect((await h.call("DELETE", `/api/connect/apps/${claude.id}`, { cookie: h.sam })).status).toBe(404);
  });

  it("ends when the token is revoked in the Access screen, when the person is removed, or when it expires", async () => {
    const a = await h.connect({ scope: "paperclip:read" });
    const ping = (t: string) => h.mcp(t, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect((await ping(a.access)).status).toBe(200);
    const list = (await j(await h.call("GET", "/api/access/epc-tokens", { cookie: h.sam }))).tokens;
    expect((await h.call("DELETE", `/api/access/epc-tokens/${list[0].id}`, { cookie: h.sam })).status).toBe(200);
    expect((await ping(a.access)).status).toBe(401);

    const b = await h.connect({ scope: "paperclip:read" });
    expect((await ping(b.access)).status).toBe(200);
    h.clock.t += 61 * 60_000; // access tokens last an hour
    const expired = await ping(b.access);
    expect(expired.status).toBe(401);
    expect(expired.headers.get("www-authenticate")).toContain("invalid_token");
    const fresh = await j(await fetch(`${h.base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: b.refresh, client_id: b.clientId })));
    expect((await ping(fresh.access_token)).status).toBe(200);

    // Proxmox refuses the token (its user was removed): the app is out within the minute.
    h.pve.users.delete("sam@pve");
    h.clock.t += 61_000;
    expect((await ping(fresh.access_token)).status).toBe(401);
  });

  it("keeps a log of what apps did, and no secrets in it", async () => {
    const t = await h.connect({ scope: "paperclip:control" });
    await h.tool(t.access, "host_status");
    await h.tool(t.access, "create_issue", { companyId: "co_1", title: "Secret-ish title" });
    const act = await j(await h.call("GET", "/api/connect/activity", { cookie: h.sam }));
    expect(act.calls.map((c: any) => c.tool)).toEqual(["create_issue", "host_status"]);
    expect(act.calls[0]).toMatchObject({ client: "Claude", user: "sam@pve", control: true, ok: true });
    expect(act.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(["oauth.consent", "app.tool", "oauth.token"]));
    const text = JSON.stringify(act);
    expect(text).not.toContain(t.access.split("_")[2]);
    expect(text).not.toContain(t.refresh.split("_")[2]);
    expect(text).not.toContain("Secret-ish title");
    expect((await j(await h.call("GET", "/api/connect/activity", { cookie: h.lee }))).calls).toEqual([]);
  });

  it("describes the bridge for the connect screen", async () => {
    const o = await j(await h.call("GET", "/api/connect/overview", { cookie: h.sam }));
    expect(o).toMatchObject({ mcpUrl: `${h.base}/mcp`, issuer: h.base, canManageAll: true, fetchUrl: false });
    expect(o.scopes.map((s: any) => s.id)).toEqual(["paperclip:read", "paperclip:control"]);
    expect(o.tools.find((t: any) => t.name === "power_machine")).toMatchObject({ access: "control", destructive: true });
    expect((await j(await h.call("GET", "/api/connect/overview", { cookie: h.lee }))).canManageAll).toBe(false);
  });

  it("cannot be managed with an API token or cross-site", async () => {
    const t = await h.connect();
    const minted = await j(await h.call("POST", "/api/access/epc-tokens", { cookie: h.sam }, { name: "script" }));
    expect((await h.call("GET", "/api/connect/apps", { bearer: minted.token })).status).toBe(403);
    expect((await h.call("DELETE", `/api/connect/apps/${t.grantId}`, { bearer: minted.token })).status).toBe(403);
    const cross = await fetch(`${h.base}/api/connect/oauth/consent`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: h.sam, Origin: "https://evil.example", "X-EPC-Request": "1" }, body: "{}" });
    expect(cross.status).toBe(403);
    const noHeader = await fetch(`${h.base}/api/connect/oauth/consent`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: h.sam }, body: "{}" });
    expect(noHeader.status).toBe(403);
  });
});

describe("small pieces", () => {
  it("calculates arithmetic and nothing else", () => {
    expect(calculate("1 + 2 * 3")).toBe(7);
    expect(calculate("(1+2)*3")).toBe(9);
    expect(calculate("2^3^2")).toBe(512);
    expect(calculate("-4 + 10 % 3")).toBe(-3);
    expect(calculate("1.5e2 / 3")).toBe(50);
    for (const bad of ["", "1 +", "process.exit()", "1/0", "alert(1)", "1; 2", "(1", "0x10", "Infinity"]) expect(() => calculate(bad), bad).toThrow();
  });
});

describe("custom-scheme redirect addresses an administrator allows", () => {
  const cursor = "cursor://anysphere.cursor-mcp/oauth/callback";
  const register = (redirect: string, name = "Cursor") => fetch(`${h.base}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none" }) });
  const allow = (cookie: string, b: Record<string, unknown>) => h.call("POST", "/api/connect/redirect-allow", { cookie }, b);

  it("is refused until a Proxmox administrator allows it with a typed confirmation, and then the whole flow works", async () => {
    expect((await register(cursor)).status).toBe(400);
    expect((await j(await register(cursor))).error).toBe("invalid_redirect_uri");
    // Only an administrator; the list is empty by default.
    expect((await h.call("GET", "/api/connect/redirect-allow", { cookie: h.lee })).status).toBe(403);
    expect((await allow(h.lee, { uri: cursor, kind: "exact", confirm: "allow cursor" })).status).toBe(403);
    expect((await j(await h.call("GET", "/api/connect/redirect-allow", { cookie: h.sam }))).entries).toEqual([]);
    // Typed confirmation: the scheme being allowed.
    expect((await allow(h.sam, { uri: cursor, kind: "exact" })).status).toBe(409);
    expect((await allow(h.sam, { uri: cursor, kind: "exact", confirm: "allow vscode" })).status).toBe(409);
    expect((await allow(h.sam, { uri: "javascript:alert(1)", kind: "exact", confirm: "allow javascript" })).status).toBe(400);
    expect((await allow(h.sam, { uri: "file:///etc/", kind: "prefix", confirm: "allow file" })).status).toBe(400);
    expect((await allow(h.sam, { uri: "cursor://", kind: "prefix", confirm: "allow cursor" })).status).toBe(400);
    expect((await register(cursor)).status).toBe(400);
    const added = await allow(h.sam, { uri: cursor, kind: "exact", confirm: "allow cursor" });
    expect(added.status).toBe(200);
    expect((await j(added)).entries).toMatchObject([{ uri: cursor, kind: "exact", addedBy: "sam@pve" }]);
    expect((await allow(h.sam, { uri: cursor, kind: "exact", confirm: "allow cursor" })).status).toBe(409);
    // A different address on the same scheme is still refused.
    expect((await register("cursor://anysphere.cursor-mcp/oauth/other")).status).toBe(400);
    // The app registers, the consent page shows the full address and the app's name, and the code goes back to it.
    const t = await h.connect({ scope: "paperclip:read", redirect: cursor, name: "Cursor" });
    expect(t.redirect).toBe(cursor);
    const { client_id } = await h.register(cursor, "Cursor IDE");
    const { challenge } = pkce();
    const q = new URLSearchParams({ client_id, redirect_uri: cursor, response_type: "code", scope: "paperclip:read", state: "s", code_challenge: challenge, code_challenge_method: "S256" });
    const info = await j(await h.call("GET", `/api/connect/oauth/request?${q}`, { cookie: h.sam }));
    expect(info.client).toMatchObject({ name: "Cursor IDE", redirectUri: cursor, redirectHost: "anysphere.cursor-mcp", customScheme: true, loopback: false });
    const consent = await j(await h.call("POST", "/api/connect/oauth/consent", { cookie: h.sam }, { ...Object.fromEntries(q), approve: false }));
    expect(consent.redirect.startsWith("cursor://anysphere.cursor-mcp/oauth/callback?")).toBe(true);
    // Removing it closes the door again, for apps that already registered too.
    const gone = await h.call("DELETE", "/api/connect/redirect-allow", { cookie: h.sam }, { uri: cursor, kind: "exact" });
    expect(gone.status).toBe(200);
    expect((await h.call("GET", `/api/connect/oauth/request?${q}`, { cookie: h.sam })).status).toBe(400);
    expect((await register(cursor)).status).toBe(400);
    expect((await h.call("DELETE", "/api/connect/redirect-allow", { cookie: h.sam }, { uri: cursor, kind: "exact" })).status).toBe(404);
    // The audit trail records who allowed and removed it.
    const audit = JSON.stringify(await j(await h.call("GET", "/api/access/audit", { cookie: h.sam })));
    expect(audit).toContain("oauth.redirect_allow");
    expect(audit).toContain("oauth.redirect_remove");
  });

  it("allows a prefix, keeps the other web rules, and survives only for listed apps", async () => {
    expect((await allow(h.sam, { uri: "vscode://vscode.github-authentication/", kind: "prefix", confirm: "allow vscode" })).status).toBe(200);
    expect((await register("vscode://vscode.github-authentication/did-authenticate")).status).toBe(201);
    expect((await register("vscode://vscode.github-authentication-evil/x")).status).toBe(400);
    expect((await register("http://example.com/cb")).status).toBe(400);
    expect((await register("https://claude.ai/api/mcp/auth_callback")).status).toBe(201);
  });

  it("cannot be changed with an API token or from another site", async () => {
    const t = await h.connect({ scope: "paperclip:control" });
    expect((await h.call("POST", "/api/connect/redirect-allow", { bearer: t.access }, { uri: cursor, kind: "exact", confirm: "allow cursor" })).status).toBeGreaterThanOrEqual(401);
    expect((await register(cursor)).status).toBe(400);
  });
});
