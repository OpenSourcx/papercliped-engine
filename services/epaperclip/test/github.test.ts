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
  const installDir = mkdtempSync(join(tmpdir(), "epc-gh-inst-"));
  const app = createApp({
    pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: fakePve().transport, caPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----" },
    sessions: new SessionStore(),
    staticDir: null,
    secureCookies: false,
    state: new StateStore(mkdtempSync(join(tmpdir(), "epc-gh-"))),
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

const real = globalThis.fetch;
let seen: string[] = [];
const stub = (routes: Record<string, (url: string) => Response>) => {
  seen = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = String(input);
    if (!u.startsWith("https://api.github.com")) return real(input, init);
    seen.push(`${u.replace("https://api.github.com", "")} auth=${init?.headers?.Authorization ?? ""}`);
    const key = Object.keys(routes).find((k) => u.includes(k));
    return key ? routes[key]!(u) : new Response("{}", { status: 404 });
  }) as typeof fetch;
};
afterEach(() => { globalThis.fetch = real; });
const j = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const SHA = "a".repeat(40);

describe("GitHub pull-request tracking", () => {
  it("connects with a checked token, keeps it sealed, and lists pull requests with their checks", async () => {
    stub({
      "/user": () => j({ login: "octo" }),
      "/repos/acme/app/pulls": () => j([
        { number: 7, title: "Add backups", state: "open", draft: false, merged_at: null, user: { login: "octo" }, head: { ref: "backups", sha: SHA }, updated_at: "2026-10-25T10:00:00Z", html_url: "https://github.com/acme/app/pull/7" },
        { number: 5, title: "Fix", state: "closed", merged_at: "2026-10-24T10:00:00Z", user: { login: "sam" }, head: { ref: "fix", sha: SHA }, updated_at: "2026-10-24T10:00:00Z", html_url: "https://github.com/acme/app/pull/5" },
        { number: 4, title: "Sneaky", state: "open", user: { login: "x" }, head: { ref: "x", sha: SHA }, updated_at: "2026-10-23T10:00:00Z", html_url: "javascript:alert(1)" },
      ]),
      "/check-runs": () => j({ check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }] }),
    });
    const sam = await signIn("sam");
    const put = await send("PUT", "/api/github", sam, { token: TOKEN, repos: ["acme/app"] });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ connected: true, login: "octo", last4: "6789", repos: ["acme/app"], canManage: true });
    expect(JSON.stringify(put.json)).not.toContain(TOKEN);
    expect(seen[0]).toBe(`/user auth=Bearer ${TOKEN}`);

    const prs = await send("GET", "/api/github/prs", sam);
    expect(prs.json.errors).toEqual([]);
    expect(prs.json.prs.map((p: any) => [p.number, p.state, p.checks])).toEqual([[7, "open", "failure"], [5, "merged", null]]);
    expect(JSON.stringify(prs.json)).not.toContain("javascript:");
    expect(JSON.stringify(seenBodies)).not.toContain(TOKEN);
  });

  it("refuses a token GitHub rejects, a malformed repository, and non-administrators", async () => {
    stub({ "/user": () => j({ message: "Bad credentials" }, 401) });
    const sam = await signIn("sam");
    const bad = await send("PUT", "/api/github", sam, { token: TOKEN });
    expect(bad.status).toBe(400);
    expect(bad.json.message ?? bad.json.error).toMatch(/refused the token/);
    expect((await send("GET", "/api/github", sam)).json.connected).toBe(false);
    stub({ "/user": () => j({ login: "octo" }) });
    expect((await send("PUT", "/api/github", sam, { token: TOKEN, repos: ["not a repo"] })).status).toBe(400);
    expect((await send("PUT", "/api/github", sam, { token: "short" })).status).toBe(400);
  });

  it("disconnects, and reports a repository GitHub can't see without failing the others", async () => {
    stub({ "/user": () => j({ login: "octo" }), "/repos/acme/app/pulls": () => j([]), "/repos/acme/gone/pulls": () => j({}, 404) });
    const sam = await signIn("sam");
    await send("PUT", "/api/github", sam, { token: TOKEN, repos: ["acme/app", "acme/gone"] });
    const prs = await send("GET", "/api/github/prs", sam);
    expect(prs.json.errors).toEqual([{ repo: "acme/gone", message: expect.stringMatching(/doesn't know this repository/) }]);
    const gone = await send("DELETE", "/api/github", sam);
    expect(gone.json.connected).toBe(false);
    expect((await send("GET", "/api/github/prs", sam)).json).toMatchObject({ connected: false, prs: [] });
  });
});

describe("GitHub sign-in (OAuth device flow)", () => {
  const oauth = (answers: unknown[]) => {
    const real2 = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const u = String(input);
      if (u.startsWith("https://github.com/login/device/code")) { calls.push("code " + init.body); return j({ device_code: "DEV123", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }); }
      if (u.startsWith("https://github.com/login/oauth/access_token")) { calls.push("token"); return j(answers.shift() ?? { error: "authorization_pending" }); }
      if (u === "https://api.github.com/user") return j({ login: "octo" });
      return real2(input, init);
    }) as typeof fetch;
    return calls;
  };
  afterEach(() => { delete process.env.EPC_GITHUB_CLIENT_ID; });

  it("says it isn't set up until the device has an OAuth app, and never shows the device code", async () => {
    const sam = await signIn("sam");
    expect((await send("GET", "/api/github", sam)).json.oauth).toBe(false);
    const r = await send("POST", "/api/github/device/start", sam, {});
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("oauth_not_configured");
  });

  it("starts, waits while GitHub says pending, then saves the token sealed and reports done", async () => {
    process.env.EPC_GITHUB_CLIENT_ID = "Iv1.testclient";
    const sam = await signIn("sam");
    expect((await send("GET", "/api/github", sam)).json.oauth).toBe(true);
    const calls = oauth([{ error: "authorization_pending" }, { access_token: "gho_abcdefghijklmnopqrstuvwxyz0123456789" }]);
    const start = await send("POST", "/api/github/device/start", sam, {});
    expect(start.status).toBe(200);
    expect(start.json).toMatchObject({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
    expect(JSON.stringify(start.json)).not.toContain("DEV123");
    expect(calls[0]).toContain("client_id=Iv1.testclient");
    expect((await send("POST", "/api/github/device/poll", sam, { id: start.json.id })).json.status).toBe("pending");
    // GitHub asks to wait between polls; the host holds the second poll back instead of hammering GitHub.
    expect((await send("POST", "/api/github/device/poll", sam, { id: start.json.id })).json.status).toBe("pending");
    expect(calls.filter((c) => c === "token")).toHaveLength(1);
  });

  it("saves the token sealed when GitHub approves, shows only its last four, and survives a denial", async () => {
    process.env.EPC_GITHUB_CLIENT_ID = "Iv1.testclient";
    const sam = await signIn("sam");
    oauth([{ access_token: "gho_abcdefghijklmnopqrstuvwxyz0123456789" }]);
    const start = await send("POST", "/api/github/device/start", sam, {});
    const done = await send("POST", "/api/github/device/poll", sam, { id: start.json.id });
    expect(done.json).toMatchObject({ status: "done", login: "octo" });
    const st = (await send("GET", "/api/github", sam)).json;
    expect(st).toMatchObject({ connected: true, login: "octo", last4: "6789" });
    expect(JSON.stringify(st)).not.toContain("gho_abcdefghij");
    oauth([{ error: "access_denied" }]);
    const again = await send("POST", "/api/github/device/start", sam, {});
    expect((await send("POST", "/api/github/device/poll", sam, { id: again.json.id })).json.status).toBe("denied");
  });

  it("refuses a stranger's sign-in id and a non-administrator", async () => {
    process.env.EPC_GITHUB_CLIENT_ID = "Iv1.testclient";
    const sam = await signIn("sam");
    const lee = await signIn("lee");
    oauth([]);
    const start = await send("POST", "/api/github/device/start", sam, {});
    expect((await send("POST", "/api/github/device/poll", lee, { id: start.json.id })).status).toBe(403);
    expect((await send("POST", "/api/github/device/poll", sam, { id: "dv_nope" })).status).toBe(404);
  });
});

describe("Pin's list_pull_requests", () => {
  it("says GitHub isn't connected, and filters by repository and open state once it is", async () => {
    const { pullRequestsTool } = await import("../src/features/github.ts");
    const st = new StateStore(mkdtempSync(join(tmpdir(), "epc-gh-tool-")));
    expect(await pullRequestsTool(st, {})).toMatchObject({ connected: false });
    st.setSecret("github.token", TOKEN);
    st.setSetting("github", { login: "octo", last4: "6789", repos: ["acme/app"], updatedAt: 42, updatedBy: "sam" });
    stub({ "/repos/acme/app/pulls": () => j([
      { number: 2, title: "Open one", state: "open", user: { login: "a" }, head: { ref: "x", sha: "b".repeat(40) }, updated_at: "2026-10-25T10:00:00Z", html_url: "https://github.com/acme/app/pull/2" },
      { number: 1, title: "Merged one", state: "closed", merged_at: "2026-10-24T10:00:00Z", user: { login: "a" }, head: { ref: "y" }, updated_at: "2026-10-24T10:00:00Z", html_url: "https://github.com/acme/app/pull/1" },
    ]), "/check-runs": () => j({ check_runs: [{ status: "in_progress" }] }) });
    const out = (await pullRequestsTool(st, { open_only: true, repo: "ACME/app" }, 1_000_000)) as { prs: { number: number; checks: string }[] };
    expect(out.prs.map((p) => [p.number, p.checks])).toEqual([[2, "pending"]]);
  });
});
