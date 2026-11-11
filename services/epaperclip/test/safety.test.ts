import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { Vault, VaultError } from "../src/vault.ts";
import { fakeEngine, fakePve, until } from "./fakes.ts";

const PASS = "correct horse battery staple";

describe("vault recovery file", () => {
  it("round-trips the key, and shows nothing without the passphrase", () => {
    const v = Vault.ephemeral();
    const file = v.exportRecovery(PASS);
    expect(file).toMatchObject({ v: 1, kind: "epaperclip-vault-key", kid: v.kid });
    const back = Vault.fromRecovery(file, PASS);
    expect(back.kid).toBe(v.kid);
    expect(back.open("n", v.seal("n", "secret value"))).toBe("secret value");
    expect(() => Vault.fromRecovery(file, "not the passphrase")).toThrow(/wrong, or the recovery file is damaged/);
    expect(JSON.stringify(file)).not.toContain(PASS);
  });

  it("refuses a short passphrase, a tampered file and settings that would burn the host's memory", () => {
    const v = Vault.ephemeral();
    expect(() => v.exportRecovery("short")).toThrow(VaultError);
    const file = v.exportRecovery(PASS);
    expect(() => Vault.fromRecovery({ ...file, kid: "0000000000000000" }, PASS)).toThrow(/wrong, or the recovery file is damaged/);
    expect(() => Vault.fromRecovery({ ...file, kdf: { ...file.kdf, N: 1 << 25 } }, PASS)).toThrow(/won't accept/);
    expect(() => Vault.fromRecovery({ ...file, kdf: { ...file.kdf, r: 64 } }, PASS)).toThrow(/won't accept/);
    expect(() => Vault.fromRecovery({ v: 2 } as never, PASS)).toThrow(/isn't an ePaperclip vault recovery file/);
  });
});

describe("restoring a lost vault key", () => {
  it("recovers secrets after vault.key is lost, and keeps the key it replaced", () => {
    const dir = mkdtempSync(join(tmpdir(), "epc-recover-"));
    const a = new StateStore(dir);
    a.setSecret("engine-password", "hunter2");
    const file = a.vaultRecoveryExport(PASS);
    // The key file is lost; the service starts again and makes a new one, so the old secret can no longer be opened.
    rmSync(join(dir, "vault.key"));
    const b = new StateStore(dir);
    expect(b.vaultKeyId()).not.toBe(file.kid);
    expect(() => b.getSecret("engine-password")).toThrow();
    const r = b.vaultRestoreFromRecovery(file, PASS, 1234);
    expect(r).toMatchObject({ same: false, restartRequired: true });
    expect(readdirSync(dir).some((f) => f.startsWith("vault.key.replaced-"))).toBe(true);
    expect(new StateStore(dir).getSecret("engine-password")).toBe("hunter2");
  });

  it("won't replace a good key with one that matches nothing, or restore a key that is already in use", () => {
    const dir = mkdtempSync(join(tmpdir(), "epc-recover-"));
    const s = new StateStore(dir);
    s.setSecret("x", "y");
    const stranger = Vault.ephemeral().exportRecovery(PASS);
    expect(() => s.vaultRestoreFromRecovery(stranger, PASS)).toThrow(/doesn't match anything sealed/);
    expect(s.vaultRestoreFromRecovery(s.vaultRecoveryExport(PASS), PASS)).toMatchObject({ same: true, restartRequired: false });
    expect(existsSync(join(dir, "vault.key"))).toBe(true);
  });
});

describe("the kill switch and the vault recovery routes", () => {
  let eng: Awaited<ReturnType<typeof fakeEngine>>;
  let server: Server;
  let base: string;
  let calls: string[];
  let dir: string;
  const resources = [
    { id: "lxc/101", type: "lxc", vmid: 101, node: "pve", name: "web", status: "running" },
    { id: "lxc/301", type: "lxc", vmid: 301, node: "pve", name: "agent-a", status: "running", tags: "epaperclip;run-x", pool: "epc-acme" },
    { id: "lxc/302", type: "lxc", vmid: 302, node: "pve", name: "agent-b", status: "stopped", tags: "epaperclip", pool: "epc-acme" },
    { id: "lxc/300", type: "lxc", vmid: 300, node: "pve", name: "template", status: "running", template: 1, tags: "epaperclip", pool: "epc-agents" },
    { id: "qemu/401", type: "qemu", vmid: 401, node: "pve", name: "pool-vm", status: "running", pool: "epc-acme" },
    { id: "node/pve", type: "node", node: "pve" },
  ];

  beforeEach(async () => {
    eng = await fakeEngine();
    calls = [];
    dir = mkdtempSync(join(tmpdir(), "epc-safety-"));
    const pve = fakePve();
    const transport: typeof pve.transport = (req) => {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/cluster/resources") && req.method === "GET" && u.searchParams.get("type") !== "storage") {
        const data = u.searchParams.get("type") === "vm" ? resources.filter((r) => r.type !== "node") : resources;
        return Promise.resolve({ status: 200, body: JSON.stringify({ data }) });
      }
      const stop = u.pathname.match(/\/nodes\/pve\/(lxc|qemu)\/(\d+)\/status\/(stop|start)$/);
      if (req.method === "POST" && stop) {
        calls.push(`${stop[3]} ${stop[1]}/${stop[2]}`);
        return Promise.resolve({ status: 200, body: JSON.stringify({ data: `UPID:pve:0:0:0:${stop[3]}:${stop[2]}:sam@pve:` }) });
      }
      return pve.transport(req);
    };
    const app = createApp({
      pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport, caPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----" },
      sessions: new SessionStore(),
      staticDir: null,
      secureCookies: false,
      state: new StateStore(dir),
      engine: { url: eng.url, installDir: mkdtempSync(join(tmpdir(), "epc-safety-inst-")), sleep: async () => {} },
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
    return { status: r.status, json: (text ? JSON.parse(text) : null) as any, headers: r.headers };
  };
  async function signIn(username: string) {
    const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username, password: "right", realm: "pve" }) });
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
    if (username === "sam") await until(() => eng.st.admins.size >= 2);
    return cookie;
  }
  const org = async (sam: string, name: string) => (await send("POST", "/engine/api/companies", sam, { name })).json.id as string;

  it("needs a typed confirmation, and only administrators may use it", async () => {
    const sam = await signIn("sam");
    const lee = await signIn("lee");
    expect((await send("POST", "/api/safety/kill-switch", sam, {})).status).toBe(400);
    expect((await send("POST", "/api/safety/kill-switch", sam, { confirm: "yes" })).status).toBe(400);
    expect((await send("POST", "/api/safety/kill-switch", lee, { confirm: "STOP EVERYTHING" })).status).toBe(403);
    expect((await send("POST", "/api/vault/recovery/export", lee, { passphrase: PASS })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("pauses every agent and stops only the guests ePaperclip owns, then says so", async () => {
    const sam = await signIn("sam");
    const a = await org(sam, "Acme");
    await org(sam, "Globex");
    const r = await send("POST", "/api/safety/kill-switch", sam, { confirm: "STOP EVERYTHING" });
    expect(r.status).toBe(200);
    // 301 (tagged) and 401 (in an epc- pool) are stopped. 101 is someone else's, 302 is already stopped, 300 is the template.
    expect(calls.sort()).toEqual(["stop lxc/301", "stop qemu/401"]);
    expect(r.json.killSwitch.stopped.map((x: any) => x.vmid).sort()).toEqual([301, 401]);
    expect(r.json.killSwitch.paused).toHaveLength(2);
    const agents = (await send("GET", `/engine/api/companies/${a}/agents`, sam)).json;
    expect(agents.every((x: any) => x.status === "paused")).toBe(true);
    const state = (await send("GET", "/api/safety", sam)).json;
    expect(state).toMatchObject({ canManage: true, killSwitch: { on: true } });
    // Everyone signed in learns it is on, but not what it did.
    const lee = await signIn("lee");
    expect((await send("GET", "/api/safety", lee)).json.killSwitch).toEqual({ on: true, at: expect.any(Number) });
    const audit = JSON.stringify((await send("GET", "/api/access/audit", sam)).json);
    expect(audit).toContain("safety.kill-switch");
  });

  it("resumes without restarting anything, and unpauses only what it paused", async () => {
    const sam = await signIn("sam");
    const a = await org(sam, "Acme");
    expect((await send("POST", "/api/safety/resume", sam, {})).status).toBe(409);
    await send("POST", "/api/safety/kill-switch", sam, { confirm: "STOP EVERYTHING" });
    const r = await send("POST", "/api/safety/resume", sam, { unpauseAgents: true });
    expect(r.status).toBe(200);
    expect(r.json.resumedAgents).toBe(1);
    expect((await send("GET", `/engine/api/companies/${a}/agents`, sam)).json[0].status).toBe("idle");
    expect(calls.some((c) => c.startsWith("start"))).toBe(false);
    expect((await send("GET", "/api/safety", sam)).json.killSwitch.on).toBe(false);
  });

  it("exports a recovery file as a download and restores it, and never accepts a wrong passphrase", async () => {
    const sam = await signIn("sam");
    expect((await send("POST", "/api/vault/recovery/export", sam, { passphrase: "short" })).status).toBe(400);
    const ex = await send("POST", "/api/vault/recovery/export", sam, { passphrase: PASS });
    expect(ex.status).toBe(200);
    expect(ex.headers.get("content-disposition")).toContain("epaperclip-vault-recovery.json");
    expect(ex.headers.get("cache-control")).toBe("no-store");
    expect(ex.json.kind).toBe("epaperclip-vault-key");
    expect((await send("POST", "/api/vault/recovery/restore", sam, { file: ex.json, passphrase: PASS })).status).toBe(400); // no typed confirmation
    expect((await send("POST", "/api/vault/recovery/restore", sam, { file: ex.json, passphrase: "wrong passphrase!!", confirm: "RESTORE VAULT KEY" })).status).toBe(400);
    const ok = await send("POST", "/api/vault/recovery/restore", sam, { file: ex.json, passphrase: PASS, confirm: "RESTORE VAULT KEY" });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ same: true, restartRequired: false });
  });
});
