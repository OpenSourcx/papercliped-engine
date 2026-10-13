import { mkdtempSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, userKey } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { startAccessApp } from "./access-harness.ts";
import { fakeAccessPve } from "./fakes-access.ts";

/**
 * Exploit-style regression tests for the findings in docs/SECURITY.md. Each one tries the attack and expects it to fail.
 */

let h: Awaited<ReturnType<typeof startAccessApp>>;
let sam: string;
beforeEach(async () => {
  h = await startAccessApp();
  sam = await h.signIn("sam");
});
afterEach(async () => {
  await h.close();
});
const j = async (r: Response) => (await r.json()) as any;
async function mint(body: Record<string, unknown> = { name: "ci" }) {
  const r = await h.call("POST", "/api/access/epc-tokens", { cookie: sam }, body);
  expect(r.status).toBe(201);
  return (await j(r)) as { token: string; record: any };
}

describe("cross-site requests (CSRF and Origin)", () => {
  // A cross-site form can send cookies but not the X-EPC-Request header, and a cross-site fetch is preflighted.
  const bare = (method: string, path: string, headers: Record<string, string> = {}) =>
    fetch(h.base + path, { method, headers: { Cookie: sam, "Content-Type": "application/json", ...headers }, body: method === "GET" ? undefined : "{}" });

  it("refuses every change that lacks our own header, on routes that exist and routes that don't", async () => {
    for (const [method, path] of [
      ["POST", "/api/machines"],
      ["POST", "/api/guests/101/power"],
      ["PUT", "/api/pin/settings"],
      ["POST", "/api/access/groups"],
      ["PUT", "/api/access/roles/Foo"],
      ["DELETE", "/api/access/groups/ops"],
      ["POST", "/api/pin/update"],
      ["POST", "/api/pin/plans/0123456789abcdef/steps/01234567/approve"],
      ["POST", "/api/iac/users"],
      ["PATCH", "/api/anything-at-all"],
      ["DELETE", "/api/definitely/not/a/route"],
    ] as const) {
      const r = await bare(method, path);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect((await j(r)).code, `${method} ${path}`).toBe("csrf");
    }
  });

  it("refuses a change whose Origin is another site, a null origin, or a look-alike host", async () => {
    for (const origin of ["https://evil.example", "null", `${h.base}.evil.example`, "http://127.0.0.1.evil.example", "not a url"]) {
      const r = await bare("POST", "/api/access/groups", { "X-EPC-Request": "1", Origin: origin });
      expect(r.status, origin).toBe(403);
    }
  });

  it("accepts the same change from our own page", async () => {
    const r = await bare("POST", "/api/access/groups", { "X-EPC-Request": "1", Origin: h.base });
    expect(r.status).not.toBe(403);
  });

  it("doesn't let a cookie stand in for a token or a token for a cookie", async () => {
    const { token } = await mint();
    // A token in the cookie slot, and a session id as a Bearer value, are both just unknown credentials.
    expect((await h.call("GET", "/api/me", { headers: { Cookie: `epc_session=${token}` } })).status).toBe(401);
    const id = sam.split("=")[1];
    expect((await h.call("GET", "/api/me", { bearer: id })).status).toBe(401);
  });

  it("refuses WebSocket upgrades from another origin or without a session", async () => {
    const hit = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const u = new URL(h.base);
        const req = request({ host: u.hostname, port: u.port, path: "/api/console/node", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
        req.on("upgrade", (res, socket) => (socket.destroy(), resolve(res.statusCode ?? 0)));
        req.on("response", (res) => resolve(res.statusCode ?? 0));
        req.on("error", () => resolve(0));
        req.end();
      });
    const u = new URL(h.base);
    expect(await hit({ Cookie: sam, Origin: "https://evil.example" })).toBe(403);
    expect(await hit({ Cookie: sam })).toBe(403); // no Origin at all
    expect(await hit({ Origin: `http://${u.host}` })).toBe(401); // our origin, but signed out
  });
});

describe("API token scope", () => {
  it("a token can't mint, regenerate or loosen Proxmox API tokens (they would outlive its expiry and limits)", async () => {
    const { token } = await mint();
    const mintReq = await h.call("POST", "/api/access/users/sam@pve/tokens", { bearer: token }, { tokenid: "forever", expire: 0, privsep: false });
    expect(mintReq.status).toBe(403);
    expect((await j(mintReq)).code).toBe("ticket_only");
    expect(h.pve.tokens.get("sam@pve")?.has("forever") ?? false).toBe(false);
    // The same request from a signed-in browser session works, so the refusal is about the token.
    const viaCookie = await h.call("POST", "/api/access/users/sam@pve/tokens", { cookie: sam }, { tokenid: "forever", expire: 0, privsep: false });
    expect(viaCookie.status).toBe(201);
    const loosen = await h.call("PUT", "/api/access/users/sam@pve/tokens/forever", { bearer: token }, { privsep: false, regenerate: true });
    expect(loosen.status).toBe(403);
  });

  it("a read-only token can't change anything, wherever the route is", async () => {
    const { token } = await mint({ name: "ro", readOnly: true });
    for (const [method, path] of [
      ["POST", "/api/access/groups"],
      ["POST", "/api/guests/101/power"],
      ["PUT", "/api/pin/settings"],
      ["DELETE", "/api/definitely/not/a/route"],
    ] as const) {
      const r = await h.call(method, path, { bearer: token }, {});
      expect(r.status, `${method} ${path}`).toBe(403);
      expect((await j(r)).code).toBe("read_only_token");
    }
    expect((await h.call("GET", "/api/me", { bearer: token })).status).toBe(200);
  });

  it("a privilege-separated token never gets the person's engine access", async () => {
    const eng = await import("./fakes.ts").then((m) => m.fakeEngine());
    const h2 = await startAccessApp({ engine: { url: eng.url, sleep: async () => {} } });
    try {
      const cookie = await h2.signIn("sam");
      const r = await h2.call("POST", "/api/access/epc-tokens", { cookie }, { name: "sep", privsep: true });
      const { token } = (await j(r)) as { token: string };
      const hit = await h2.call("GET", "/engine/api/companies", { bearer: token });
      expect(hit.status).toBe(403);
      expect((await j(hit)).code).toBe("token_scope");
      expect(eng.seen.filter((s) => s.url.startsWith("/api/companies")).length).toBe(0);
    } finally {
      await h2.close();
      await eng.close();
    }
  });
});

describe("sign-in limits", () => {
  it("counts one person once however the name is typed", () => {
    expect(userKey("sam", "pve")).toBe(userKey("sam@pve"));
    expect(userKey("SAM@PVE")).toBe(userKey("sam", "pve"));
    expect(userKey("sam@pve", "pam")).toBe(userKey("sam@pve"));
    expect(userKey("a@b@pve")).toBe("user:a@b@pve");
  });

  it("locks a person out after 8 wrong passwords even when each try is spelled differently", async () => {
    const tries = [
      { username: "sam", realm: "pve" },
      { username: "sam@pve" },
      { username: "SAM@pve" },
      { username: "sam", realm: "PVE" },
    ];
    let last = 0;
    for (let i = 0; i < 9; i++) {
      const r = await fetch(h.base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ ...tries[i % tries.length], password: "wrong" }) });
      last = r.status;
    }
    expect(last).toBe(429);
  });

  it("counts wrong second-factor codes across fresh password sign-ins", async () => {
    h.pve.needTfa.set("lee@pve", "totp");
    const login = (body: unknown) => fetch(h.base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify(body) });
    const tfa = (challenge: string, code: string) => fetch(h.base + "/api/login/tfa", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ challenge, code }) });
    let blocked = false;
    // Each round starts over with the right password (which used to reset the counter) and guesses a few codes.
    for (let round = 0; round < 4 && !blocked; round++) {
      const first = await login({ username: "lee", realm: "pve", password: "right" });
      if (first.status === 429) {
        blocked = true;
        break;
      }
      const { challenge } = await j(first);
      for (let i = 0; i < 3; i++) {
        const r = await tfa(challenge, "000000");
        if (r.status === 429) blocked = true;
      }
    }
    expect(blocked).toBe(true);
    // And the right code no longer works while the lock holds.
    h.pve.st.totpCode = "123456";
    const again = await login({ username: "lee", realm: "pve", password: "right" });
    expect(again.status).toBe(429);
  });
});

describe("session cookie", () => {
  it("is host-only (__Host- prefix) over HTTPS, so a sibling site or plain HTTP can't plant one", async () => {
    const pve = fakeAccessPve();
    const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(), staticDir: null, secureCookies: true, state: new StateStore(mkdtempSync(join(tmpdir(), "epc-sec-"))) });
    const server: Server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username: "sam", realm: "pve", password: "right" }) });
      const c = r.headers.get("set-cookie")!;
      expect(c).toMatch(/^__Host-epc_session=/);
      expect(c).toMatch(/; Path=\/(;|$)/);
      expect(c).toContain("Secure");
      expect(c).toContain("HttpOnly");
      expect(c).toContain("SameSite=Strict");
      expect(c).not.toMatch(/Domain=/i);
      // A cookie under the unprefixed name (planted by a sibling domain) is not a session.
      const id = c.split("=")[1].split(";")[0];
      expect((await fetch(base + "/api/me", { headers: { Cookie: `epc_session=${id}` } })).status).toBe(401);
      expect((await fetch(base + "/api/me", { headers: { Cookie: `__Host-epc_session=${id}` } })).status).toBe(200);
      // Responses carry the cross-origin isolation headers.
      const me = await fetch(base + "/api/health");
      expect(me.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(me.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(me.headers.get("content-security-policy")).toContain("script-src 'self'; style-src 'self'");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a new sign-in never reuses a session id a client brought along", async () => {
    const planted = "A".repeat(43);
    const r = await fetch(h.base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1", Cookie: `epc_session=${planted}` }, body: JSON.stringify({ username: "sam", realm: "pve", password: "right" }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).not.toContain(planted);
    expect((await h.call("GET", "/api/me", { cookie: `epc_session=${planted}` })).status).toBe(401);
  });
});
