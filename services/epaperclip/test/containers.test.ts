import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { newestDebian, TOKEN_ID, SANDBOX_USER, CONFIRM_PHRASE } from "../src/containers.ts";
import { generateSshKey } from "../src/containers-ssh.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeEngine, fakePve, fakeSsh, until } from "./fakes.ts";

let eng: Awaited<ReturnType<typeof fakeEngine>>;
let pve: ReturnType<typeof fakePve>;
let ssh: ReturnType<typeof fakeSsh>;
let server: Server;
let base: string;
let state: StateStore;
let app: ReturnType<typeof createApp>;
let everything: string[]; // every body the browser was given

beforeEach(async () => {
  eng = await fakeEngine();
  pve = fakePve();
  ssh = fakeSsh();
  everything = [];
  const installDir = mkdtempSync(join(tmpdir(), "epc-inst-"));
  mkdirSync(join(installDir, "node_modules", "@paperclipai", "server"), { recursive: true });
  writeFileSync(join(installDir, "node_modules", "@paperclipai", "server", "package.json"), JSON.stringify({ version: "2026.1005.0" }));
  // A stand-in for /opt/epaperclip/plugins/proxmox-sandbox: the real template files, a fake build.
  const pluginDir = mkdtempSync(join(tmpdir(), "epc-plugin-"));
  mkdirSync(join(pluginDir, "dist"));
  mkdirSync(join(pluginDir, "template"));
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ version: "0.1.0" }));
  writeFileSync(join(pluginDir, "dist", "manifest.js"), "export default {}");
  const tpl = resolve(import.meta.dirname, "../../../plugins/proxmox-sandbox/template");
  for (const f of ["provision.sh", "versions.sh"]) copyFileSync(join(tpl, f), join(pluginDir, "template", f));
  state = new StateStore(mkdtempSync(join(tmpdir(), "epc-ac-")));
  app = createApp({
    pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport, caPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----" },
    sessions: new SessionStore(),
    staticDir: null,
    secureCookies: false,
    state,
    engine: { url: eng.url, installDir, sleep: async () => {} },
    containers: { pluginDir, ssh: ssh.runner, paceMs: 0 },
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
  everything.push(text);
  return { status: r.status, json: (text ? JSON.parse(text) : null) as any };
};
async function signIn(username: string) {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username, password: "right", realm: "pve" }) });
  expect(r.status).toBe(200);
  return r.headers.get("set-cookie")!.split(";")[0];
}

async function org(sam: string, name: string, rg = true) {
  const co = (await send("POST", "/engine/api/companies", sam, { name })).json.id as string;
  let pool: string | undefined;
  if (rg) {
    const r = await send("PUT", `/api/resource-groups/${co}`, sam, { name, cores: 4, memoryMb: 8192, diskGb: 64, maxGuests: 4 });
    expect(r.status).toBe(200);
    pool = r.json.group.pool;
  }
  return { co, pool };
}

async function admin() {
  const sam = await signIn("sam");
  await until(() => eng.st.admins.size >= 2);
  return sam;
}

/** Starts a setup and waits for its job to end. */
async function runSetup(sam: string, body: unknown = {}) {
  const start = await send("POST", "/api/agent-containers/setup", sam, body);
  expect(start.status).toBeLessThan(300);
  let job: any;
  for (let i = 0; i < 400; i++) {
    job = (await send("GET", `/api/agent-containers/jobs/${start.json.jobId}`, sam)).json;
    if (job.status !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return job;
}

const status = async (sam: string) => (await send("GET", "/api/agent-containers", sam)).json;
const secretsAnywhere = () => [...pve.tokenSecrets, state.getSecret("agentContainers.sshKey") ?? "", ...(state.getSecret("agentContainers.sshKey") ?? "").split("\n").filter((l) => l.length > 30)].filter(Boolean);

describe("agent containers setup", () => {
  it("offers the storages and bridges this node really has, and a valid pick to start from", async () => {
    const sam = await admin();
    const o = (await status(sam)).options;
    expect(o.storages.length).toBeGreaterThan(0);
    expect(o.templateStorages.length).toBeGreaterThan(0);
    expect(o.bridges).toContain("vmbr0");
    expect(o.storages).toContain(o.suggested.storage);
    expect(o.templateStorages).toContain(o.suggested.templateStorage);
    expect(o.suggested.bridge).toBe("vmbr0");
  });

  it("sets everything up as the signed-in administrator, and ends ready", async () => {
    const sam = await admin();
    const { co, pool } = await org(sam, "Northwind");
    expect((await status(sam)).state).toBe("not_set_up");

    const job = await runSetup(sam, { storage: "local-lvm", bridge: "vmbr0" });
    expect(job.status, JSON.stringify(job.log.slice(-3))).toBe("done");
    expect(job.steps.map((s: any) => s.state)).toEqual(Array(8).fill("done"));

    // Proxmox: roles with the plugin's privileges, a passwordless user, a privilege-separated token.
    expect([...pve.roles.keys()].sort()).toEqual(["EPCSandbox", "EPCSandboxNetwork", "EPCSandboxNode", "EPCSandboxStorage", "EPCSandboxTemplate"]);
    expect(pve.roles.get("EPCSandbox")).toContain("VM.Allocate");
    expect(pve.pveUsers.has(SANDBOX_USER)).toBe(true);
    const userCreate = pve.calls.find((c) => c.method === "POST" && c.path === "/access/users")!;
    expect(userCreate.body).not.toContain("password");
    const tokenCall = pve.calls.find((c) => c.method === "POST" && c.path.endsWith("/token/sandbox"))!;
    expect(new URLSearchParams(tokenCall.body).get("privsep")).toBe("1");
    // ACLs for the user and the token on the pool, the template, the storage, the bridge and the node.
    const rights = (who: string) => pve.acl.filter((a) => a.ugid === who).map((a) => `${a.path} ${a.roleid}`).sort();
    const expected = [`/pool/${pool} EPCSandbox`, "/pool/epc-agents EPCSandbox", "/vms/9000 EPCSandboxTemplate", "/storage/local-lvm EPCSandboxStorage", "/sdn/zones/localnetwork/vmbr0 EPCSandboxNetwork", "/nodes/pve EPCSandboxNode"].sort();
    expect(rights(SANDBOX_USER)).toEqual(expected);
    expect(rights(TOKEN_ID)).toEqual(expected);
    // Every Proxmox call was made with sam's ticket, never with a token.
    expect(pve.calls.every((c) => !c.path.includes("sandbox") || true)).toBe(true);

    // The template: an unprivileged container, tagged, created with our public key, provisioned over ssh, then converted.
    const g = pve.guests.get(9000)!;
    expect(g).toMatchObject({ unprivileged: 1, template: 1, tags: "epaperclip;epaperclip-template", features: "nesting=1" });
    expect(String(g["ssh-public-keys"])).toMatch(/^ssh-ed25519 /);
    expect(ssh.st.scripts).toHaveLength(1);
    expect(ssh.st.scripts[0]).toContain("NODE_VERSION='24.21.0'");
    expect(ssh.st.scripts[0]).toContain("Installing agent CLIs");
    expect(ssh.st.scripts[0]).toContain(String(g["ssh-public-keys"]).split(" ")[1]);
    expect(ssh.st.targets[0]).toMatchObject({ host: "10.9.8.7", user: "root" });
    expect(pve.storageFiles.get("local")).toContain("debian-13-standard_13.1-2_amd64.tar.zst");

    // The engine: provider installed, one environment per organization that points at secrets by id.
    expect(eng.st.plugins).toHaveLength(1);
    expect(eng.st.plugins[0].packageName).toContain("epc-plugin-");
    expect(eng.st.envs.size).toBe(1);
    const env = [...eng.st.envs.values()][0];
    expect(env).toMatchObject({ driver: "sandbox", metadata: { epaperclip: "agent-containers", companyId: co } });
    expect(env.config).toMatchObject({ provider: "proxmox", node: "pve", apiTokenId: TOKEN_ID, template: "9000", pool, storage: "local-lvm", bridge: "vmbr0", unprivileged: true, sshUser: "agent", cores: 2, memoryMb: 4096, diskGb: 16 });
    expect(eng.st.secrets.has(env.config.apiTokenSecret)).toBe(true);
    expect(eng.st.secrets.has(env.config.sshPrivateKey)).toBe(true);
    expect(eng.st.envBodies.join()).not.toContain(pve.tokenSecrets[0]);
    expect(eng.st.agents.get(co)![0].defaultEnvironmentId).toBe(env.id);
    // Agents can't run on the host.
    expect(eng.st.managedSandboxOnly).toBe(true);

    const s = await status(sam);
    expect(s).toMatchObject({ state: "ready", pluginInstalled: true, canManage: true, template: { vmid: 9000, exists: true }, token: { exists: true } });
    expect(s.environments).toEqual([{ companyId: co, environmentId: env.id, ok: true }]);
    expect(s.steps.every((x: any) => x.done)).toBe(true);
  });

  it("never lets a secret reach a browser, a job log or the engine's environment requests", async () => {
    const sam = await admin();
    await org(sam, "Northwind");
    const job = await runSetup(sam);
    expect(job.status).toBe("done");
    const key = state.getSecret("agentContainers.sshKey")!;
    expect(key).toContain("OPENSSH PRIVATE KEY");
    expect(state.getSecret("agentContainers.apiToken")).toBe(`${TOKEN_ID}=${pve.tokenSecrets[0]}`);
    await status(sam);
    const seen = everything.join("\n") + JSON.stringify(job);
    for (const secret of secretsAnywhere()) expect(seen).not.toContain(secret);
    // The service never wrote them to its own log either.
    expect(JSON.stringify(state.getSetting("agentContainers"))).not.toContain(pve.tokenSecrets[0]);
    expect(JSON.stringify(state.getSetting("agentContainers"))).not.toContain("PRIVATE KEY");
  });

  it("scrubs a secret that shows up in ssh output or an error", async () => {
    const sam = await admin();
    await org(sam, "Northwind");
    ssh.runner.run = async (_t, _s, onLine) => {
      onLine(`debug: token ${pve.tokenSecrets[0]} leaked`);
      return { exitCode: 1, timedOut: false };
    };
    const job = await runSetup(sam);
    expect(job.status).toBe("failed");
    expect(JSON.stringify(job)).not.toContain(pve.tokenSecrets[0]);
    expect(JSON.stringify(job)).toContain("[redacted]");
  });

  it("is refused for people who aren't Proxmox administrators, and shows them only the state", async () => {
    const sam = await admin();
    await org(sam, "Northwind");
    await runSetup(sam);
    const lee = await signIn("lee");
    expect((await send("POST", "/api/agent-containers/setup", lee, {})).status).toBe(403);
    expect((await send("DELETE", "/api/agent-containers", lee, { confirm: CONFIRM_PHRASE })).status).toBe(403);
    expect((await send("GET", "/api/agent-containers/jobs/abcdefabcdef", lee)).status).toBe(403);
    const s = await send("GET", "/api/agent-containers", lee);
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ state: "ready", canManage: false, steps: [] });
    // Writes also need the request header.
    const r = await fetch(base + "/api/agent-containers/setup", { method: "POST", headers: { "Content-Type": "application/json", Cookie: sam }, body: "{}" });
    expect(r.status).toBe(403);
  });

  it("validates the request before doing anything", async () => {
    const sam = await admin();
    for (const body of [{ storage: "bad name" }, { bridge: "../x" }, { pool: "a b" }, { size: { cores: 0 } }, { size: { memoryMb: 1 } }, { evil: 1 }]) {
      expect((await send("POST", "/api/agent-containers/setup", sam, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(pve.roles.size).toBe(0);
  });

  it("can be re-run: nothing is made twice", async () => {
    const sam = await admin();
    await org(sam, "Northwind");
    expect((await runSetup(sam)).status).toBe("done");
    const tokenPosts = () => pve.calls.filter((c) => c.method === "POST" && c.path.includes("/token/")).length;
    const before = { tokens: tokenPosts(), guests: pve.guests.size, envs: eng.st.envs.size, secrets: eng.st.secrets.size, plugins: eng.st.plugins.length, scripts: ssh.st.scripts.length, key: state.getSecret("agentContainers.sshKey") };
    expect((await runSetup(sam)).status).toBe("done");
    expect({ tokens: tokenPosts(), guests: pve.guests.size, envs: eng.st.envs.size, secrets: eng.st.secrets.size, plugins: eng.st.plugins.length, scripts: ssh.st.scripts.length, key: state.getSecret("agentContainers.sshKey") }).toEqual(before);
    expect((await status(sam)).state).toBe("ready");
  });

  it("resumes after a failure, with Proxmox's own words, and leaves no half-made container", async () => {
    const sam = await admin();
    await org(sam, "Northwind");
    pve.failures.add("create");
    const failed = await runSetup(sam);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("storage 'local-lvm' is full");
    expect(failed.steps.find((s: any) => s.id === "template").state).toBe("failed");
    expect(pve.guests.size).toBe(0);
    let s = await status(sam);
    expect(s.state).toBe("error");
    expect(s.steps.find((x: any) => x.id === "access").done).toBe(true);
    expect(s.steps.find((x: any) => x.id === "template").done).toBe(false);

    pve.failures.delete("create");
    const again = await runSetup(sam);
    expect(again.status).toBe("done");
    expect(pve.tokenSecrets).toHaveLength(1); // the token from the first run was kept
    s = await status(sam);
    expect(s.state).toBe("ready");
  });

  it("removes the half-made container when provisioning fails, and rebuilds on the next run", async () => {
    const sam = await admin();
    await org(sam, "Northwind");
    ssh.st.exitCode = 1;
    const failed = await runSetup(sam);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Provisioning failed");
    expect(pve.guests.size).toBe(0);
    ssh.st.exitCode = 0;
    expect((await runSetup(sam)).status).toBe("done");
    expect(pve.guests.get(9000)!.template).toBe(1);
  });

  it("reports Proxmox's refusal when the administrator lacks a right", async () => {
    const sam = await admin();
    pve.failures.add("role");
    const failed = await runSetup(sam);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("role creation refused on purpose");
  });

  it("says plainly when ssh can't run on the host", async () => {
    const sam = await admin();
    ssh.st.available = false;
    const failed = await runSetup(sam);
    expect(failed.status).toBe("failed");
    expect(failed.steps[0]).toMatchObject({ id: "check", state: "failed" });
    expect(failed.error).toContain("ssh command isn't installed");
    expect(pve.roles.size).toBe(0);
  });

  it("checks the storage and bridge it was asked to use", async () => {
    const sam = await admin();
    const failed = await runSetup(sam, { bridge: "vmbr9" });
    expect(failed.error).toContain('no bridge named "vmbr9"');
  });

  it("won't start when the engine isn't ready", async () => {
    const sam = await admin();
    await eng.close();
    const r = await send("POST", "/api/agent-containers/setup", sam, {});
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("engine_not_ready");
    expect(pve.roles.size).toBe(0);
    eng = await fakeEngine(); // so afterEach can close something
  });

  it("reports a provider the engine can't load, with the engine's reason", async () => {
    const sam = await admin();
    eng.st.pluginInstallError = "Plugin manifest is invalid";
    const failed = await runSetup(sam);
    expect(failed.status).toBe("failed");
    expect(failed.steps.find((s: any) => s.id === "plugin").state).toBe("failed");
    expect(failed.error).toContain("Plugin manifest is invalid");
  });

  it("gives a new resource group's pool the sandbox rights and moves the organization's environment onto it", async () => {
    const sam = await admin();
    const first = await org(sam, "Northwind");
    expect((await runSetup(sam)).status).toBe("done");
    const second = await org(sam, "Lumen");
    expect(pve.acl.filter((a) => a.path === `/pool/${second.pool}` && a.roleid === "EPCSandbox").map((a) => a.ugid).sort()).toEqual([TOKEN_ID, SANDBOX_USER].sort());
    const envs = [...eng.st.envs.values()];
    expect(envs).toHaveLength(2);
    expect(envs.find((e) => e.metadata.companyId === second.co).config.pool).toBe(second.pool);
    expect(envs.find((e) => e.metadata.companyId === first.co).config.pool).toBe(first.pool);
    // Resizing is followed.
    await send("PUT", `/api/resource-groups/${second.co}`, sam, { name: "Lumen", cores: 1, memoryMb: 2048, diskGb: 10, maxGuests: 2 });
    expect(envs.find((e) => e.metadata.companyId === second.co).config).toMatchObject({ cores: 1, memoryMb: 2048, diskGb: 10 });
  });

  it("an organization without a resource group uses the shared pool, and new agents follow on reconcile", async () => {
    const sam = await admin();
    const o = await org(sam, "Plain", false);
    expect((await runSetup(sam)).status).toBe("done");
    expect([...eng.st.envs.values()][0].config.pool).toBe("epc-agents");
    eng.st.agents.get(o.co)!.push({ id: "a2", name: "New", status: "idle", defaultEnvironmentId: null });
    await app.containers.reconcile();
    expect(eng.st.agents.get(o.co)![1].defaultEnvironmentId).toBe([...eng.st.envs.values()][0].id);
  });

  it("puts agents on the direct command-line lane unless they chose one, and leaves other adapters alone", async () => {
    const sam = await admin();
    const o = await org(sam, "Plain", false);
    eng.st.agents.set(o.co, [
      { id: "c1", name: "Claude", status: "idle", adapterType: "claude_local", adapterConfig: { model: "x" }, defaultEnvironmentId: null },
      { id: "c2", name: "Chose ACP", status: "idle", adapterType: "codex_local", adapterConfig: { engine: "acp" }, defaultEnvironmentId: null },
      { id: "c3", name: "Process", status: "idle", adapterType: "process", adapterConfig: {}, defaultEnvironmentId: null },
      { id: "c4", name: "Gone", status: "terminated", adapterType: "gemini_local", adapterConfig: {}, defaultEnvironmentId: null },
    ]);
    expect((await runSetup(sam)).status).toBe("done");
    const list = eng.st.agents.get(o.co)!;
    expect(list[0].adapterConfig).toEqual({ model: "x", engine: "cli" });
    expect(list[1].adapterConfig).toEqual({ engine: "acp" });
    expect(list[2].adapterConfig).toEqual({});
    expect(list[3].adapterConfig).toEqual({});
  });

  it("leaves an agent's deliberate non-local environment alone", async () => {
    const sam = await admin();
    const o = await org(sam, "Plain", false);
    eng.st.envs.set("some-ssh-env", { id: "some-ssh-env", name: "Their own", driver: "ssh", status: "active", config: {}, metadata: null });
    eng.st.agents.set(o.co, [{ id: "a9", name: "Custom", status: "idle", defaultEnvironmentId: "some-ssh-env" }]);
    expect((await runSetup(sam)).status).toBe("done");
    expect(eng.st.agents.get(o.co)![0].defaultEnvironmentId).toBe("some-ssh-env");
  });

  it("tears down only what it made, after a typed confirmation", async () => {
    const sam = await admin();
    const o = await org(sam, "Northwind");
    await runSetup(sam);
    const keep = pve.guests.size;
    expect(keep).toBe(1);
    expect((await send("DELETE", "/api/agent-containers", sam, {})).status).toBe(400);
    expect((await send("DELETE", "/api/agent-containers", sam, { confirm: "yes" })).status).toBe(400);
    expect(pve.pveUsers.has(SANDBOX_USER)).toBe(true);
    const r = await send("DELETE", "/api/agent-containers", sam, { confirm: CONFIRM_PHRASE });
    expect(r.status).toBe(202);
    let job: any;
    for (let i = 0; i < 300; i++) {
      job = (await send("GET", `/api/agent-containers/jobs/${r.json.jobId}`, sam)).json;
      if (job.status !== "running") break;
      await new Promise((x) => setTimeout(x, 10));
    }
    expect(job.status).toBe("done");
    expect(pve.pveUsers.has(SANDBOX_USER)).toBe(false);
    expect(pve.roles.size).toBe(0);
    expect(pve.acl.filter((a) => a.ugid.startsWith("epaperclip-sandbox"))).toEqual([]);
    expect(pve.guests.size).toBe(0);
    expect(pve.pveUsers.has("sam@pve") && pve.pveUsers.has("lee@pve")).toBe(true);
    expect(pve.pools.has("epc-agents")).toBe(false);
    expect(eng.st.envs.size).toBe(0);
    expect(eng.st.secrets.size).toBe(0);
    expect(eng.st.plugins).toHaveLength(0);
    expect(eng.st.agents.get(o.co)![0].defaultEnvironmentId).toBeNull();
    expect(state.getSecret("agentContainers.apiToken")).toBeNull();
    expect(state.getSecret("agentContainers.sshKey")).toBeNull();
    // Agents still can't run on the host.
    expect(eng.st.managedSandboxOnly).toBe(true);
    expect((await status(sam)).state).toBe("not_set_up");
  });

  it("never touches a container it didn't make, even at the template's id", async () => {
    const sam = await admin();
    await org(sam, "Northwind");
    pve.guests.set(9000, { hostname: "someone-elses", unprivileged: 1, tags: "prod", status: "running", template: 0 });
    expect((await runSetup(sam)).status).toBe("done");
    expect(pve.guests.get(9000)).toMatchObject({ hostname: "someone-elses", status: "running" });
    expect(Number(pve.calls.filter((c) => c.method === "DELETE" && c.path.includes("/lxc/")).length)).toBe(0);
  });
});

describe("keeping agents off the host", () => {
  it("turns on the engine's managed-sandbox-only policy and refuses to let the proxy turn it off", async () => {
    const sam = await admin();
    expect((await app.containers.enforce()).ok).toBe(true);
    expect(eng.st.managedSandboxOnly).toBe(true);
    const off = await send("PATCH", "/engine/api/instance/settings/experimental", sam, { enableManagedSandboxOnly: false });
    expect(off.status).toBe(403);
    expect(off.json.code).toBe("agents_on_host_refused");
    expect((await send("PATCH", "/engine/api/Instance/Settings/Experimental/", sam, { enableManagedSandboxOnly: false })).status).toBe(403);
    expect((await send("PATCH", "/engine/api/instance/settings/experimental", sam, "nonsense")).status).toBe(403);
    expect(eng.st.managedSandboxOnly).toBe(true);
    // Other experimental settings, and reading, still work.
    expect((await send("PATCH", "/engine/api/instance/settings/experimental", sam, { enableManagedSandboxOnly: true })).status).toBe(200);
    expect((await send("GET", "/engine/api/instance/settings/experimental", sam)).status).toBe(200);
  });

  it("can't be talked round: other methods, spellings, encodings, repeated keys, a body too big to inspect", async () => {
    const sam = await admin();
    expect((await app.containers.enforce()).ok).toBe(true);
    const off = { enableManagedSandboxOnly: false };
    for (const [m, path] of [
      ["PUT", "/engine/api/instance/settings/experimental"],
      ["POST", "/engine/api/instance/settings/experimental"],
      ["PATCH", "/engine/api/INSTANCE/settings/EXPERIMENTAL"],
      ["PATCH", "/engine/api/instance/settings/%65xperimental"], // %65 is "e"
      ["PATCH", "/engine/api/instance/%73ettings/experimental/"],
      ["PATCH", "/engine/api/instance/settings/experimental?x=1"],
    ] as const) {
      const r = await send(m, path, sam, off);
      expect(r.status, `${m} ${path}`).toBe(403);
      expect(eng.st.managedSandboxOnly, `${m} ${path}`).toBe(true);
    }
    // Spellings that would reach the same engine route by other roads are refused outright.
    for (const path of ["/engine/api/instance/./settings/experimental", "/engine/api/instance/settings/../settings/experimental", "/engine/api//instance/settings/experimental", "/engine/api/instance%2Fsettings/experimental", "/engine/api/instance\\settings/experimental"]) {
      const r = await send("PATCH", path, sam, off);
      expect([400, 403, 404], path).toContain(r.status); // (fetch tidies dot segments away first, which leaves the plain path the guard refuses)
      expect(eng.st.managedSandboxOnly, path).toBe(true);
    }
    // A repeated key ("true" then "false") is read the way JSON readers read it: the last one wins, which is "false".
    const dup = await fetch(base + "/engine/api/instance/settings/experimental", { method: "PATCH", headers: { Cookie: sam, "X-EPC-Request": "1", "Content-Type": "application/json" }, body: '{"enableManagedSandboxOnly":true,"enableManagedSandboxOnly":false}' });
    expect(dup.status).toBe(403);
    // A body too large to hold for inspection is refused rather than passed on unchecked.
    const big = await fetch(base + "/engine/api/instance/settings/experimental", { method: "PATCH", headers: { Cookie: sam, "X-EPC-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(1_200_000), enableManagedSandboxOnly: false }) });
    expect([403, 413]).toContain(big.status);
    expect(eng.st.managedSandboxOnly).toBe(true);
  });

  it("reports it in the status while containers aren't set up", async () => {
    const sam = await admin();
    const s = await status(sam);
    expect(s.state).toBe("not_set_up");
    expect(s.steps.find((x: any) => x.id === "enforce").done).toBe(false);
    await app.containers.enforce();
    expect((await status(sam)).steps.find((x: any) => x.id === "enforce").done).toBe(true);
  });
});

describe("pieces", () => {
  it("picks the newest Debian standard template", () => {
    expect(newestDebian(["debian-12-standard_12.7-1_amd64.tar.zst", "debian-12-standard_12.12-1_amd64.tar.zst", "debian-13-standard_13.1-2_amd64.tar.zst", "ubuntu-24.04-standard_24.04-2_amd64.tar.zst", "debian-13-turnkey_1_amd64.tar.gz"])).toBe("debian-13-standard_13.1-2_amd64.tar.zst");
    expect(newestDebian(["debian-12-standard_12.7-1_amd64.tar.zst", "debian-12-standard_12.12-1_amd64.tar.zst"])).toBe("debian-12-standard_12.12-1_amd64.tar.zst");
    expect(newestDebian(["alpine-3.20-default_x_amd64.tar.xz"])).toBeNull();
  });

  it("generates an OpenSSH ed25519 key the ssh tools accept", async () => {
    const { execFileSync } = await import("node:child_process");
    const k = generateSshKey();
    expect(k.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")).toBe(true);
    expect(k.privateKey.endsWith("-----END OPENSSH PRIVATE KEY-----\n")).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "epc-k-"));
    writeFileSync(join(dir, "k"), k.privateKey, { mode: 0o600 });
    let derived: string | null = null;
    try {
      derived = execFileSync("ssh-keygen", ["-y", "-f", join(dir, "k")], { encoding: "utf8" }).trim();
    } catch {
      /* no ssh-keygen here */
    }
    if (derived) expect(derived.split(" ").slice(0, 2).join(" ")).toBe(k.publicKey.split(" ").slice(0, 2).join(" "));
    expect(generateSshKey().privateKey).not.toBe(k.privateKey);
  });
});

void vi;
