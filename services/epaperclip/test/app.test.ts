import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Transport } from "@papercliped-engine/proxmox-client";
import { createApp, parseMachineSpec, templateName } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";

/** A fake Proxmox: users, optional TFA, tickets, and permissions per ticket. */
function fakePve() {
  const users: Record<string, { password: string; totp?: string; admin: boolean }> = {
    "sam@pve": { password: "right", admin: true },
    "lee@pve": { password: "right", admin: false },
    "kai@pam": { password: "right", totp: "123456", admin: true },
  };
  const tickets = new Map<string, string>(); // ticket -> user
  const partial = new Map<string, string>();
  let n = 0;
  const seen: Parameters<Transport>[0][] = [];
  const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ data }) });
  const issue = (user: string) => {
    const t = `PVE:${user}:${++n}`;
    tickets.set(t, user);
    return ok({ username: user, ticket: t, CSRFPreventionToken: `csrf-${n}` });
  };
  const transport: Transport = async (req) => {
    seen.push(req);
    const u = new URL(req.url);
    const path = u.pathname.replace("/api2/json", "");
    if (path === "/access/domains") return ok([{ realm: "pam", type: "pam", comment: "Linux PAM" }, { realm: "pve", type: "pve", default: 1 }]);
    if (path === "/access/ticket") {
      const f = new URLSearchParams(req.body);
      const user = f.get("username")!.includes("@") ? f.get("username")! : `${f.get("username")}@${f.get("realm") ?? "pam"}`;
      const pw = f.get("password")!;
      const ch = f.get("tfa-challenge");
      if (ch) {
        if (partial.get(ch) !== user || pw !== `totp:${users[user]?.totp}`) return { status: 401, body: "" };
        partial.delete(ch);
        return issue(user);
      }
      if (tickets.get(pw) === user) return issue(user); // renewal
      if (users[user]?.password !== pw) return { status: 401, body: "" };
      if (users[user].totp) {
        const t = `PVE:${user}:!tfa!${++n}`;
        partial.set(t, user);
        return ok({ username: user, ticket: t, NeedTFA: 1 });
      }
      return issue(user);
    }
    const cookie = decodeURIComponent((req.headers.Cookie ?? "").replace("PVEAuthCookie=", ""));
    const user = tickets.get(cookie);
    if (!user) return { status: 401, body: "" };
    if (req.method === "POST" && !req.headers.CSRFPreventionToken) return { status: 401, body: "" };
    const admin = users[user].admin;
    if (path === "/version") return ok({ version: "9.0.3" });
    if (path === "/cluster/resources" && u.searchParams.get("type") === "storage") return ok([{ id: "storage/pve/local", type: "storage", node: "pve", storage: "local", plugintype: "dir", content: "iso,vztmpl,backup", status: "available", disk: 40, maxdisk: 100 }, { id: "storage/pve/drive2", type: "storage", node: "pve", storage: "drive2", plugintype: "dir", content: "images,rootdir", status: "available", disk: 5, maxdisk: 2000 }, { id: "storage/other/x", type: "storage", node: "other", storage: "x" }]);
    if (path === "/cluster/resources") return ok([{ id: "lxc/101", type: "lxc", vmid: 101, node: "pve", name: "web", status: "running" }, { id: "node/pve", type: "node", node: "pve" }]);
    if (path === "/nodes/pve/status") return admin ? ok({ cpu: 0.1, memory: { used: 1, total: 2 } }) : { status: 403, body: "" };
    if (path === "/nodes/pve/rrddata") return admin ? ok([{ time: 1, cpu: 0.2 }]) : { status: 403, body: "" };
    if (path === "/nodes/pve/lxc/101/rrddata") return ok([{ time: 1, cpu: 0.5, q: u.search }]);
    if (path === "/cluster/nextid") return ok("106");
    if (path === "/nodes/pve/storage") return ok(u.searchParams.get("content") === "vztmpl" ? [{ storage: "local", type: "dir", active: 1 }] : [{ storage: "local-lvm", type: "lvmthin", avail: 5e10, active: 1 }]);
    if (path === "/nodes/pve/storage/local/content") return ok([{ volid: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst", size: 1 }]);
    if (path === "/pools") return ok([{ poolid: "co-northwind" }]);
    if (path === "/nodes/pve/lxc" && req.method === "POST") return admin ? ok("UPID:pve:create") : { status: 403, body: "" };
    if (path === "/nodes/pve/lxc/101/status/shutdown") return admin ? ok("UPID:pve:1") : { status: 403, body: "" };
    return { status: 404, body: "" };
  };
  return { transport, seen, tickets };
}

let server: Server;
let base: string;
let pve: ReturnType<typeof fakePve>;
let clock: number;
let staticDir: string;

beforeEach(async () => {
  pve = fakePve();
  clock = 1_000_000;
  staticDir = mkdtempSync(join(tmpdir(), "epc-"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>ePaperclip</title>");
  mkdirSync(join(staticDir, "assets"));
  writeFileSync(join(staticDir, "assets", "app-abc.js"), "console.log(1)");
  writeFileSync(join(staticDir, "..", "secret.txt"), "nope");
  const now = () => clock;
  const handle = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(now), staticDir, secureCookies: true, now });
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => {
  server.close(() => r());
  server.closeAllConnections();
}));

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1", ...headers }, body: JSON.stringify(body) });
const sessionCookie = (r: Response) => r.headers.get("set-cookie")!.split(";")[0];
async function signIn(username = "sam", realm = "pve") {
  const r = await post("/api/login", { username, password: "right", realm });
  expect(r.status).toBe(200);
  return sessionCookie(r);
}

describe("sign-in through Proxmox", () => {
  it("lists realms for the login screen", async () => {
    const r = await fetch(base + "/api/realms");
    expect(await r.json()).toEqual({ realms: [{ realm: "pam", type: "pam", comment: "Linux PAM", default: false }, { realm: "pve", type: "pve", comment: null, default: true }] });
  });

  it("signs in with a Proxmox user and sets a locked-down session cookie, never the ticket", async () => {
    const r = await post("/api/login", { username: "sam", password: "right", realm: "pve" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ user: { username: "sam@pve" } });
    const c = r.headers.get("set-cookie")!;
    expect(c).toMatch(/^epc_session=[\w-]{40,};/);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Secure");
    expect(c).not.toContain("PVE:");
    const me = await fetch(base + "/api/me", { headers: { Cookie: sessionCookie(r) } });
    expect(await me.json()).toEqual({ user: { username: "sam@pve", name: "sam", realm: "pve", node: "pve" } });
  });

  it("rejects wrong passwords without saying which part was wrong", async () => {
    const r = await post("/api/login", { username: "sam", password: "wrong", realm: "pve" });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "Wrong username or password", code: "bad_credentials" });
  });

  it("locks out after repeated failures", async () => {
    for (let i = 0; i < 8; i++) expect((await post("/api/login", { username: "sam", password: "x", realm: "pve" })).status).toBe(401);
    expect((await post("/api/login", { username: "sam", password: "right", realm: "pve" })).status).toBe(429);
    clock += 15 * 60_000;
    expect((await post("/api/login", { username: "sam", password: "right", realm: "pve" })).status).toBe(200);
  });

  it("requires the request header and a same-site origin for sign-in and changes", async () => {
    const noHeader = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "sam", password: "right", realm: "pve" }) });
    expect(noHeader.status).toBe(403);
    expect((await post("/api/login", { username: "sam", password: "right", realm: "pve" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/api/login", { username: "sam", password: "right", realm: "pve" }, { Origin: "null" })).status).toBe(403);
    const form = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-EPC-Request": "1" }, body: "username=sam" });
    expect(form.status).toBe(415);
  });

  it("completes two-factor sign-in with an authenticator code", async () => {
    const first = await post("/api/login", { username: "kai", password: "right", realm: "pam" });
    const body = (await first.json()) as { needTfa: boolean; challenge: string };
    expect(body.needTfa).toBe(true);
    expect(first.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify(body)).not.toContain("PVE:");
    expect((await post("/api/login/tfa", { challenge: body.challenge, code: "000000" })).status).toBe(401);
    const ok = await post("/api/login/tfa", { challenge: body.challenge, code: "123456" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ user: { username: "kai@pam" } });
    expect((await post("/api/login/tfa", { challenge: body.challenge, code: "123456" })).status).toBe(401);
  });

  it("gives up on a two-factor step after five wrong codes", async () => {
    const { challenge } = (await (await post("/api/login", { username: "kai", password: "right", realm: "pam" })).json()) as { challenge: string };
    for (let i = 0; i < 5; i++) await post("/api/login/tfa", { challenge, code: "000000" });
    const r = await post("/api/login/tfa", { challenge, code: "123456" });
    expect(await r.json()).toMatchObject({ code: "tfa_expired" });
  });

  it("signs out", async () => {
    const c = await signIn();
    const r = await post("/api/logout", {}, { Cookie: c });
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await fetch(base + "/api/me", { headers: { Cookie: c } })).status).toBe(401);
  });
});

describe("acting as the signed-in user", () => {
  it("needs a session", async () => {
    expect((await fetch(base + "/api/host")).status).toBe(401);
    expect((await fetch(base + "/api/host", { headers: { Cookie: "epc_session=made-up" } })).status).toBe(401);
  });

  it("reads the host with the user's own ticket", async () => {
    const c = await signIn();
    const r = await fetch(base + "/api/host", { headers: { Cookie: c } });
    const body = (await r.json()) as { version: string; status: unknown; resources: { vmid: number }[] };
    expect(body.version).toBe("9.0.3");
    expect(body.status).not.toBeNull();
    expect(body.resources.map((g) => g.vmid)).toEqual([101]);
    expect((body as unknown as { storage: { storage: string; used: number; total: number }[] }).storage).toEqual([
      { storage: "local", plugintype: "dir", content: "iso,vztmpl,backup", status: "available", used: 40, total: 100, shared: false },
      { storage: "drive2", plugintype: "dir", content: "images,rootdir", status: "available", used: 5, total: 2000, shared: false },
    ]);
    const last = pve.seen.find((x) => x.url.endsWith("/version"))!;
    expect(last.headers.Cookie).toMatch(/^PVEAuthCookie=PVE%3Asam%40pve/);
    expect(last.headers.Authorization).toBeUndefined();
  });

  it("lets Proxmox's permissions decide: no Sys.Audit means no node status, and power is forbidden", async () => {
    const c = await signIn("lee");
    const host = (await (await fetch(base + "/api/host", { headers: { Cookie: c } })).json()) as { status: unknown; resources: unknown[] };
    expect(host.status).toBeNull();
    expect(host.resources).toHaveLength(1);
    expect((await fetch(base + "/api/stats/node", { headers: { Cookie: c } })).status).toBe(403);
    const p = await post("/api/guests/101/power", { action: "shutdown" }, { Cookie: c });
    expect(p.status).toBe(403);
    expect(await p.json()).toMatchObject({ code: "forbidden" });
  });

  it("powers guests and serves usage history", async () => {
    const c = await signIn();
    const p = await post("/api/guests/101/power", { action: "shutdown" }, { Cookie: c });
    expect(p.status).toBe(202);
    expect(await p.json()).toEqual({ task: "UPID:pve:1" });
    expect(pve.seen.at(-1)!.headers.CSRFPreventionToken).toMatch(/^csrf-/);
    expect((await post("/api/guests/101/power", { action: "destroy" }, { Cookie: c })).status).toBe(400);
    expect((await post("/api/guests/999/power", { action: "start" }, { Cookie: c })).status).toBe(404);
    const s = await fetch(base + "/api/stats/guests/101?timeframe=day&cf=MAX", { headers: { Cookie: c } });
    expect(await s.json()).toEqual({ points: [{ time: 1, cpu: 0.5, q: "?timeframe=day&cf=MAX" }] });
    expect((await fetch(base + "/api/stats/node?timeframe=decade", { headers: { Cookie: c } })).status).toBe(400);
  });

  it("refuses power changes without the request header", async () => {
    const c = await signIn();
    const r = await fetch(base + "/api/guests/101/power", { method: "POST", headers: { Cookie: c, "Content-Type": "application/json" }, body: '{"action":"shutdown"}' });
    expect(r.status).toBe(403);
  });

  it("renews the Proxmox ticket while the session is in use", async () => {
    const c = await signIn();
    clock += 20 * 60_000;
    await fetch(base + "/api/host", { headers: { Cookie: c } });
    const renewals = pve.seen.filter((s) => s.url.endsWith("/access/ticket"));
    expect(renewals).toHaveLength(2);
    expect(new URLSearchParams(renewals[1].body).get("password")).toMatch(/^PVE:sam@pve:/);
    expect(pve.seen.at(-1)!.headers.Cookie).toContain(encodeURIComponent("PVE:sam@pve:2"));
  });

  it("signs the user out when Proxmox stops accepting their ticket", async () => {
    const c = await signIn();
    pve.tickets.clear();
    const r = await fetch(base + "/api/host", { headers: { Cookie: c } });
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await fetch(base + "/api/me", { headers: { Cookie: c } })).status).toBe(401);
  });

  it("ends idle sessions after two hours", async () => {
    const c = await signIn();
    clock += 2 * 3600_000 + 1;
    expect((await fetch(base + "/api/me", { headers: { Cookie: c } })).status).toBe(401);
  });
});

describe("creating machines", () => {
  const spec = { name: "quick-1", template: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst", storage: "local-lvm", cores: 1, memoryMb: 1024, diskGb: 8 };

  it("offers templates, disk storages, pools and the next id", async () => {
    const c = await signIn();
    const r = await fetch(base + "/api/machines/options", { headers: { Cookie: c } });
    expect(await r.json()).toEqual({ nextid: 106, templates: [{ volid: spec.template, name: "Debian 12 standard", size: 1 }], storages: [{ storage: "local-lvm", type: "lvmthin", avail: 5e10 }], pools: ["co-northwind"] });
  });

  it("creates an unprivileged container as the user and starts it", async () => {
    const c = await signIn();
    const r = await post("/api/machines", { ...spec, pool: "co-northwind", password: "long-enough" }, { Cookie: c });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ vmid: 106, task: "UPID:pve:create" });
    const sent = new URLSearchParams(pve.seen.at(-1)!.body);
    expect(Object.fromEntries(sent)).toMatchObject({ vmid: "106", hostname: "quick-1", unprivileged: "1", start: "1", rootfs: "local-lvm:8", memory: "1024", pool: "co-northwind", net0: "name=eth0,bridge=vmbr0,ip=dhcp" });
  });

  it("leaves the decision to Proxmox's permissions", async () => {
    const c = await signIn("lee");
    expect((await post("/api/machines", spec, { Cookie: c })).status).toBe(403);
  });

  it("rejects anything outside narrow patterns", () => {
    for (const bad of [{ name: "Bad Name" }, { name: "x;rm" }, { template: "local:iso/x.iso" }, { storage: "a b" }, { cores: 0 }, { memoryMb: 1e9 }, { diskGb: 1.5 }, { pool: "../x" }, { password: "short" }, { sshKey: "not a key" }, { net0: "x" }]) {
      if ("net0" in bad) expect(parseMachineSpec({ ...spec, ...bad })).not.toHaveProperty("net0");
      else expect(() => parseMachineSpec({ ...spec, ...bad })).toThrow();
    }
  });

  it("names templates readably", () => {
    expect(templateName("local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst")).toBe("Ubuntu 24.04 standard");
    expect(templateName("local:vztmpl/custom.tar.gz")).toBe("custom.tar.gz");
  });
});

describe("serving the console", () => {
  it("serves files with the strict CSP and security headers", async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("ePaperclip");
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'; style-src 'self'");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("strict-transport-security")).toBeTruthy();
    const a = await fetch(base + "/assets/app-abc.js");
    expect(a.headers.get("cache-control")).toContain("immutable");
    expect(a.headers.get("content-type")).toContain("javascript");
  });

  it("falls back to the app for client routes, but not for missing files", async () => {
    expect(await (await fetch(base + "/pve/home")).text()).toContain("ePaperclip");
    expect((await fetch(base + "/assets/missing.js")).status).toBe(404);
  });

  it("never serves files outside the console directory", async () => {
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/..%5csecret.txt"]) {
      const r = await fetch(base + p);
      expect(await r.text()).not.toContain("nope");
    }
  });

  it("doesn't accept writes outside the API", async () => {
    expect((await fetch(base + "/", { method: "POST" })).status).toBe(405);
  });
});
