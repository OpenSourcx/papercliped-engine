import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Transport } from "@papercliped-engine/proxmox-client";
import { backupOf, checksum, createApp, parseBackupJob, fileName, parseMachineSpec, parseVmSpec, templateName, vmParams, volumeId } from "../src/app.ts";
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
    if (path === "/nodes/pve/storage/local/content" && u.searchParams.get("content") === "vztmpl") return ok([{ volid: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst", size: 1 }]);
    if (path === "/pools") return ok([{ poolid: "co-northwind" }]);
    if (path === "/nodes/pve/lxc" && req.method === "POST") return admin ? ok("UPID:pve:create") : { status: 403, body: "" };
    if (path === "/nodes/pve/storage/local/content" && u.searchParams.get("content") === null) return ok([{ volid: "local:iso/debian.iso", content: "iso", format: "iso", size: 600, ctime: 5 }, { volid: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst", content: "vztmpl", size: 1 }]);
    if (path.startsWith("/nodes/pve/storage/local/content/") && req.method === "DELETE") return admin ? ok("UPID:pve:del") : { status: 403, body: "" };
    if (path === "/nodes/pve/aplinfo" && req.method === "GET") return ok([{ template: "alpine-3.20-default_20240908_amd64.tar.xz", headline: "Alpine Linux 3.20", os: "alpine", section: "system", package: "alpine" }]);
    if (path === "/nodes/pve/aplinfo" && req.method === "POST") return admin ? ok("UPID:pve:apl") : { status: 403, body: "" };
    if (path === "/nodes/pve/storage/local/download-url") return new URLSearchParams(req.body).get("filename") === "exists.iso" ? { status: 400, body: JSON.stringify({ errors: { filename: "refusing to override existing file" } }) } : ok("UPID:pve:dl");
    if (path === "/nodes/pve/tasks") return ok([{ upid: "UPID:pve:0001:0002:0003:download:x:sam@pve:", type: "download", user: "sam@pve", starttime: 1, status: "OK", endtime: 2 }]);
    if (path.startsWith("/nodes/pve/tasks/") && path.endsWith("/status")) return ok({ status: "stopped", exitstatus: "OK" });
    if (path.startsWith("/nodes/pve/tasks/") && path.endsWith("/log")) return ok([{ n: 1, t: "downloading" }, { n: 2, t: "TASK OK" }]);
    if (path === "/nodes/pve/qemu" && req.method === "POST") return admin ? ok("UPID:pve:qm") : { status: 403, body: "" };
    if (path === "/nodes/pve/lxc/101/termproxy" && req.method === "POST") return ok({ port: 5901, ticket: "PVEVNC:abc", user, upid: "UPID:pve:1:2:3:vncproxy:101:x:" });
    if (path === "/nodes/pve/termproxy" && req.method === "POST") return admin ? ok({ port: 5900, ticket: "PVEVNC:node", user, upid: "UPID:pve:1:2:3:vncshell::x:" }) : { status: 403, body: "" };
    if (path === "/cluster/backup" && req.method === "GET") return admin ? ok([{ id: "backup-1a2b", schedule: "21:00", storage: "drive2", all: 1, mode: "snapshot", compress: "zstd", enabled: 1, "prune-backups": "keep-last=3", "next-run": 1900000000 }]) : { status: 403, body: "" };
    if (path === "/cluster/backup" && req.method === "POST") return admin ? ok(null) : { status: 403, body: "" };
    if (path.startsWith("/cluster/backup/") && (req.method === "PUT" || req.method === "DELETE")) return admin ? ok(null) : { status: 403, body: "" };
    if (path === "/nodes/pve/vzdump" && req.method === "POST") return admin ? ok("UPID:pve:vzdump") : { status: 403, body: "" };
    if (path === "/nodes/pve/lxc" && req.method === "POST" && new URLSearchParams(req.body).get("restore") === "1") return ok("UPID:pve:restore");
    if (path === "/nodes/pve/lxc/101/status/shutdown") return admin ? ok("UPID:pve:1") : { status: 403, body: "" };
    return { status: 404, body: "" };
  };
  const uploads: { url: string; headers: Record<string, string>; body: string }[] = [];
  const streamTransport = async (req: { url: string; headers: Record<string, string>; body: AsyncIterable<Uint8Array | string> }) => {
    const parts: Buffer[] = [];
    for await (const c of req.body) parts.push(Buffer.from(c));
    const user = tickets.get(decodeURIComponent((req.headers.Cookie ?? "").replace("PVEAuthCookie=", "")));
    if (!user) return { status: 401, body: "" };
    uploads.push({ url: req.url, headers: req.headers, body: Buffer.concat(parts).toString() });
    return { status: 200, body: JSON.stringify({ data: "UPID:pve:up" }) };
  };
  return { transport, seen, tickets, streamTransport, uploads };
}

let server: Server;
let base: string;
let pve: ReturnType<typeof fakePve>;
let clock: number;
let staticDir: string;
let fakeConsole: WebSocketServer;
let consoleSeen: { url: string; cookie: string | undefined; frames: string[] }[];

beforeEach(async () => {
  pve = fakePve();
  clock = 1_000_000;
  staticDir = mkdtempSync(join(tmpdir(), "epc-"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>ePaperclip</title>");
  mkdirSync(join(staticDir, "assets"));
  writeFileSync(join(staticDir, "assets", "app-abc.js"), "console.log(1)");
  writeFileSync(join(staticDir, "..", "secret.txt"), "nope");
  // A stand-in for Proxmox's vncwebsocket: checks the handshake, then echoes input frames as output.
  consoleSeen = [];
  fakeConsole = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  fakeConsole.on("connection", (ws, req) => {
    const rec = { url: req.url ?? "", cookie: req.headers.cookie, frames: [] as string[] };
    consoleSeen.push(rec);
    ws.on("message", (m) => {
      const t = m.toString();
      rec.frames.push(t);
      if (rec.frames.length === 1) return ws.send(t === "sam@pve:PVEVNC:abc\n" || t === "sam@pve:PVEVNC:node\n" ? "OK" : "NO");
      const input = t.match(/^0:(\d+):(.*)$/s);
      if (input) ws.send(`echo:${input[2]}`);
    });
  });
  await new Promise<void>((r) => fakeConsole.on("listening", () => r()));
  const consolePort = (fakeConsole.address() as AddressInfo).port;
  const now = () => clock;
  const handle = createApp({
    connect: (t) => new WebSocket(`ws://127.0.0.1:${consolePort}${new URL(t.url).pathname}${new URL(t.url).search}`, { headers: t.headers }), pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport, streamTransport: pve.streamTransport }, maxUploadBytes: 1024, sessions: new SessionStore(now), staticDir, secureCookies: true, now });
  server = createServer(handle);
  server.on("upgrade", handle.upgrade);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => {
  for (const c of fakeConsole.clients) c.terminate();
  fakeConsole.close();
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
    expect(await r.json()).toEqual({ nextid: 106, templates: [{ volid: spec.template, name: "Debian 12 standard", size: 1 }], storages: [{ storage: "local-lvm", type: "lvmthin", avail: 5e10 }], isos: [], vmStorages: [{ storage: "local-lvm", type: "lvmthin", avail: 5e10 }], pools: ["co-northwind"] });
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

describe("storage, templates and ISOs", () => {
  it("lists what a storage holds", async () => {
    const c = await signIn();
    const r = await fetch(base + "/api/storage/local/content", { headers: { Cookie: c } });
    const { items } = (await r.json()) as { items: { volid: string; content: string }[] };
    expect(items.map((i) => i.content)).toEqual(["iso", "vztmpl"]);
    expect((await fetch(base + "/api/storage/local/content?content=evil", { headers: { Cookie: c } })).status).toBe(400);
    expect((await fetch(base + "/api/storage/..%2Fetc/content", { headers: { Cookie: c } })).status).toBe(400);
  });

  it("deletes only volumes inside the named storage, as the user", async () => {
    const c = await signIn();
    expect((await post("/api/storage/local/delete", { volid: "local:iso/debian.iso" }, { Cookie: c })).status).toBe(202);
    expect(pve.seen.at(-1)!.url).toContain("/storage/local/content/local%3Aiso%2Fdebian.iso");
    expect((await post("/api/storage/local/delete", { volid: "drive2:iso/debian.iso" }, { Cookie: c })).status).toBe(400);
    expect((await post("/api/storage/local/delete", { volid: "local:../../etc/passwd" }, { Cookie: c })).status).toBe(400);
    const lee = await signIn("lee");
    expect((await post("/api/storage/local/delete", { volid: "local:iso/debian.iso" }, { Cookie: lee })).status).toBe(403);
  });

  it("offers Proxmox's template catalog and downloads from it", async () => {
    const c = await signIn();
    const cat = (await (await fetch(base + "/api/templates/catalog", { headers: { Cookie: c } })).json()) as { templates: { template: string; headline: string }[] };
    expect(cat.templates[0]).toMatchObject({ template: "alpine-3.20-default_20240908_amd64.tar.xz", headline: "Alpine Linux 3.20" });
    const r = await post("/api/templates/download", { storage: "local", template: "alpine-3.20-default_20240908_amd64.tar.xz" }, { Cookie: c });
    expect(await r.json()).toEqual({ task: "UPID:pve:apl" });
    expect((await post("/api/templates/download", { storage: "local", template: "../x.tar.xz" }, { Cookie: c })).status).toBe(400);
  });

  it("downloads from a URL with an optional checksum, and passes Proxmox's reason through", async () => {
    const c = await signIn();
    const r = await post("/api/storage/local/download-url", { url: "https://cdimage.example/debian.iso", content: "iso", filename: "debian.iso", checksum: "AB".repeat(32), algorithm: "sha256" }, { Cookie: c });
    expect(r.status).toBe(202);
    expect(Object.fromEntries(new URLSearchParams(pve.seen.at(-1)!.body))).toMatchObject({ url: "https://cdimage.example/debian.iso", filename: "debian.iso", checksum: "ab".repeat(32), "checksum-algorithm": "sha256", "verify-certificates": "1" });
    expect((await post("/api/storage/local/download-url", { url: "file:///etc/shadow", content: "iso", filename: "a.iso" }, { Cookie: c })).status).toBe(400);
    expect((await post("/api/storage/local/download-url", { url: "https://x.example/a", content: "iso", filename: "a.exe" }, { Cookie: c })).status).toBe(400);
    const exists = await post("/api/storage/local/download-url", { url: "https://x.example/a.iso", content: "iso", filename: "exists.iso" }, { Cookie: c });
    expect(exists.status).toBe(400);
    expect(await exists.json()).toEqual({ error: "filename: refusing to override existing file", code: "proxmox_rejected" });
  });

  it("streams uploads through to Proxmox as the user", async () => {
    const c = await signIn();
    const r = await fetch(base + "/api/storage/local/upload?content=iso&filename=tiny.iso", { method: "POST", headers: { Cookie: c, "X-EPC-Request": "1", "Content-Type": "application/octet-stream" }, body: "ISODATA" });
    expect(r.status).toBe(202);
    expect(pve.uploads).toHaveLength(1);
    expect(pve.uploads[0].url).toBe("https://127.0.0.1:8006/api2/json/nodes/pve/storage/local/upload");
    expect(pve.uploads[0].body).toContain('filename="tiny.iso"');
    expect(pve.uploads[0].body).toContain("\r\n\r\nISODATA\r\n");
    expect(pve.uploads[0].headers.Cookie).toContain("PVEAuthCookie=");
  });

  it("refuses uploads that are too big, mislabeled, unnamed or cross-site", async () => {
    const c = await signIn();
    const up = (q: string, body: string, headers: Record<string, string> = {}) => fetch(base + `/api/storage/local/upload?${q}`, { method: "POST", headers: { Cookie: c, "X-EPC-Request": "1", "Content-Type": "application/octet-stream", ...headers }, body });
    expect((await up("content=iso&filename=big.iso", "x".repeat(2000))).status).toBe(413);
    expect((await up("content=iso&filename=evil.sh", "x")).status).toBe(400);
    expect((await up("content=backup&filename=a.iso", "x")).status).toBe(400);
    expect((await up("content=iso&filename=a.iso", "x", { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await up("content=iso&filename=a.iso", "x", { "X-EPC-Request": "" })).status).toBe(403);
    expect(pve.uploads).toHaveLength(0);
  });

  it("lists tasks and reads a task's log", async () => {
    const c = await signIn();
    const { tasks } = (await (await fetch(base + "/api/tasks", { headers: { Cookie: c } })).json()) as { tasks: { upid: string }[] };
    expect(tasks[0]).toMatchObject({ type: "download", status: "OK", user: "sam@pve" });
    const one = await fetch(base + `/api/tasks/${encodeURIComponent(tasks[0].upid)}`, { headers: { Cookie: c } });
    expect(await one.json()).toEqual({ status: "stopped", exitstatus: "OK", log: ["downloading", "TASK OK"] });
    expect((await fetch(base + `/api/tasks/${encodeURIComponent("UPID:othernode:01:02:03:x:y:z:")}`, { headers: { Cookie: c } })).status).toBe(400);
    expect((await fetch(base + `/api/tasks/${encodeURIComponent("UPID:pve:0A:0B:0C:imgdel:local:iso/a.iso:sam@pve:")}`, { headers: { Cookie: c } })).status).toBe(200);
    expect((await fetch(base + `/api/tasks/${encodeURIComponent("UPID:pve:zz:0B:0C:x:y:")}`, { headers: { Cookie: c } })).status).toBe(400);
  });

  it("creates VMs with the defaults Proxmox's wizard uses", async () => {
    const c = await signIn();
    const r = await post("/api/vms", { name: "win-box", iso: "local:iso/win11.iso", ostype: "win11", cores: 4, memoryMb: 8192, diskGb: 64, storage: "local-lvm" }, { Cookie: c });
    expect(r.status).toBe(202);
    const sent = Object.fromEntries(new URLSearchParams(pve.seen.at(-1)!.body));
    expect(sent).toMatchObject({ vmid: "106", name: "win-box", ostype: "win11", bios: "ovmf", machine: "q35", sata0: "local-lvm:64", ide2: "local:iso/win11.iso,media=cdrom", tpmstate0: "local-lvm:1,version=v2.0", start: "1" });
    expect(vmParams(1, parseVmSpec({ name: "lin", iso: null, ostype: "l26", cores: 2, memoryMb: 2048, diskGb: 32, storage: "local-lvm" }))).toMatchObject({ scsi0: "local-lvm:32,iothread=1", ide2: "none,media=cdrom", net0: "virtio,bridge=vmbr0,firewall=1", bios: undefined });
    const lee = await signIn("lee");
    expect((await post("/api/vms", { name: "x", iso: null, ostype: "l26", cores: 1, memoryMb: 512, diskGb: 4, storage: "local-lvm" }, { Cookie: lee })).status).toBe(403);
  });

  it("validates names, volumes and checksums tightly", () => {
    expect(() => fileName("a.iso", "iso")).not.toThrow();
    expect(() => fileName("a.tar.zst", "iso")).toThrow();
    expect(() => fileName(".hidden.iso", "iso")).toThrow();
    expect(() => volumeId("local:iso/a.iso", "local")).not.toThrow();
    expect(() => volumeId("local:iso/../a.iso", "local")).toThrow();
    expect(() => checksum("zz", "sha256")).toThrow();
    expect(() => checksum("ab".repeat(16), "crc32")).toThrow();
    expect(checksum("", undefined)).toEqual({});
    expect(() => parseVmSpec({ name: "x", iso: "local:iso/../../etc", ostype: "l26", cores: 1, memoryMb: 512, diskGb: 4, storage: "s" })).toThrow();
  });
});

describe("backups", () => {
  it("lists scheduled jobs with retention and next run", async () => {
    const c = await signIn();
    const r = await fetch(base + "/api/backups/jobs", { headers: { Cookie: c } });
    expect(await r.json()).toEqual({ jobs: [{ id: "backup-1a2b", schedule: "21:00", storage: "drive2", all: true, vmids: [], pool: null, mode: "snapshot", compress: "zstd", enabled: true, keepLast: 3, comment: null, nextRun: 1900000000 }] });
    expect((await fetch(base + "/api/backups/jobs", { headers: { Cookie: await signIn("lee") } })).status).toBe(403);
  });

  it("creates, toggles, edits and deletes jobs", async () => {
    const c = await signIn();
    expect((await post("/api/backups/jobs", { schedule: "sat 02:00", storage: "drive2", vmids: [101, 109], mode: "snapshot", keepLast: 7 }, { Cookie: c })).status).toBe(201);
    expect(Object.fromEntries(new URLSearchParams(pve.seen.at(-1)!.body))).toMatchObject({ schedule: "sat 02:00", storage: "drive2", vmid: "101,109", mode: "snapshot", compress: "zstd", enabled: "1", "prune-backups": "keep-last=7" });
    expect((await post("/api/backups/jobs/backup-1a2b", { enabled: false }, { Cookie: c })).status).toBe(200);
    expect(pve.seen.at(-1)!.method).toBe("PUT");
    expect(new URLSearchParams(pve.seen.at(-1)!.body).get("enabled")).toBe("0");
    expect((await post("/api/backups/jobs/backup-1a2b", { schedule: "21:30", storage: "drive2", all: true, mode: "stop", keepLast: 2 }, { Cookie: c })).status).toBe(200);
    expect(new URLSearchParams(pve.seen.at(-1)!.body).get("delete")).toBe("vmid");
    expect((await post("/api/backups/jobs/backup-1a2b/delete", {}, { Cookie: c })).status).toBe(200);
    expect(pve.seen.at(-1)!.method).toBe("DELETE");
    expect((await post("/api/backups/jobs/..%2Fx", {}, { Cookie: c })).status).toBe(404);
  });

  it("backs up now as the user", async () => {
    const c = await signIn();
    const r = await post("/api/backups/run", { vmids: [101], storage: "drive2", mode: "snapshot" }, { Cookie: c });
    expect(await r.json()).toEqual({ task: "UPID:pve:vzdump" });
    expect(Object.fromEntries(new URLSearchParams(pve.seen.at(-1)!.body))).toMatchObject({ vmid: "101", storage: "drive2", mode: "snapshot", compress: "zstd" });
    expect((await post("/api/backups/run", { vmids: [101], storage: "drive2", mode: "snapshot" }, { Cookie: await signIn("lee") })).status).toBe(403);
    expect((await post("/api/backups/run", { vmids: [], storage: "drive2" }, { Cookie: c })).status).toBe(400);
  });

  it("restores as a new machine by default, and refuses to overwrite a running one", async () => {
    const c = await signIn();
    const r = await post("/api/backups/restore", { from: "drive2", volid: "drive2:backup/vzdump-lxc-101-2025_10_10-21_00_02.tar.zst", storage: "local-lvm" }, { Cookie: c });
    expect(await r.json()).toMatchObject({ vmid: 106 });
    expect(Object.fromEntries(new URLSearchParams(pve.seen.at(-1)!.body))).toMatchObject({ vmid: "106", ostemplate: "drive2:backup/vzdump-lxc-101-2025_10_10-21_00_02.tar.zst", restore: "1", unique: "1", storage: "local-lvm" });
    const over = await post("/api/backups/restore", { from: "drive2", volid: "drive2:backup/vzdump-lxc-101-2025_10_10-21_00_02.tar.zst", storage: "local-lvm", replace: true }, { Cookie: c });
    expect(over.status).toBe(409);
    expect((await post("/api/backups/restore", { from: "drive2", volid: "drive2:iso/x.iso", storage: "local-lvm" }, { Cookie: c })).status).toBe(400);
    expect((await post("/api/backups/restore", { from: "local", volid: "drive2:backup/vzdump-lxc-101-x.tar.zst", storage: "local-lvm" }, { Cookie: c })).status).toBe(400);
  });

  it("parses schedules and backup names", () => {
    expect(() => parseBackupJob({ schedule: "21:00\nrm", storage: "x", all: true, mode: "snapshot", keepLast: 1 })).toThrow();
    expect(() => parseBackupJob({ schedule: "21:00", storage: "x", all: true, mode: "fast", keepLast: 1 })).toThrow();
    expect(() => parseBackupJob({ schedule: "21:00", storage: "x", vmids: [], mode: "snapshot", keepLast: 1 })).toThrow();
    expect(backupOf("drive2:backup/vzdump-qemu-109-2025_10_10-21_04_40.vma.zst")).toEqual({ type: "qemu", vmid: 109 });
    expect(backupOf("drive2:backup/random.tar")).toBeNull();
  });
});

describe("live consoles", () => {
  const open = (path: string, headers: Record<string, string>) =>
    new Promise<{ ws: WebSocket; out: string[]; closed: Promise<number> }>((resolve, reject) => {
      const ws = new WebSocket(base.replace("http", "ws") + path, { headers });
      const out: string[] = [];
      const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
      ws.on("message", (m) => out.push(m.toString()));
      ws.on("open", () => resolve({ ws, out, closed }));
      ws.on("unexpected-response", (_req, res) => reject(new Error(String(res.statusCode))));
      ws.on("error", reject);
    });
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it("relays a container console as the user, without exposing tickets", async () => {
    const c = await signIn();
    const { ws, out } = await open("/api/console/guests/101", { Cookie: c, Origin: base });
    ws.send("0:2:ls");
    await until(() => out.length > 0);
    expect(out).toEqual(["echo:ls"]);
    expect(consoleSeen[0].url).toBe("/api2/json/nodes/pve/lxc/101/vncwebsocket?port=5901&vncticket=PVEVNC%3Aabc");
    expect(consoleSeen[0].cookie).toMatch(/^PVEAuthCookie=PVE%3Asam%40pve/);
    expect(consoleSeen[0].frames[0]).toBe("sam@pve:PVEVNC:abc\n");
    expect(out.join("")).not.toContain("PVE");
    ws.close();
  });

  it("refuses cross-site and signed-out connections before upgrading", async () => {
    const c = await signIn();
    await expect(open("/api/console/guests/101", { Cookie: c, Origin: "https://evil.example" })).rejects.toThrow("403");
    await expect(open("/api/console/guests/101", { Cookie: c })).rejects.toThrow("403");
    await expect(open("/api/console/guests/101", { Origin: base })).rejects.toThrow("401");
    await expect(open("/api/console/elsewhere", { Cookie: c, Origin: base })).rejects.toThrow("404");
  });

  it("explains in the terminal when Proxmox says no", async () => {
    const c = await signIn("lee");
    const { out, closed } = await open("/api/console/node", { Cookie: c, Origin: base });
    expect(await closed).toBe(4000);
    expect(out.join("")).toContain("doesn't have console access");
    const s = await signIn();
    const stopped = await open("/api/console/guests/999", { Cookie: s, Origin: base });
    await stopped.closed;
    expect(stopped.out.join("")).toContain("Unknown machine");
  });

  it("opens the host shell for users Proxmox allows", async () => {
    const c = await signIn();
    const { ws, out } = await open("/api/console/node", { Cookie: c, Origin: base });
    ws.send("0:6:whoami");
    await until(() => out.length > 0);
    expect(out).toEqual(["echo:whoami"]);
    expect(consoleSeen[0].url).toContain("/api2/json/nodes/pve/vncwebsocket?port=5900");
    ws.close();
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
