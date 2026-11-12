import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
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
    containers: { pluginDir, ssh: ssh.runner, paceMs: 0, arch: "amd64" },
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


const OWNER_LOG = ["sync_wait: 34 An error occurred in another process (expected sequence number 7)", '__lxc_start: 2288 Failed to spawn container "9000"', "TASK ERROR: startup for container '9000' failed"];
const titles = (job: any) => job.log.map((l: any) => l.text).join("\n");

describe("agent containers: why a container failed to start", () => {
  it("explains the generic LXC start failure, probes nesting, cleans up, and shows the evidence without secrets", async () => {
    const sam = await admin();
    await org(sam, "Northwind");
    pve.failures.add("start");
    pve.failLogs.set("start", OWNER_LOG);
    pve.host.storage = { type: "dir", active: 1, avail: 400 * 1024 ** 3 };
    const failed = await runSetup(sam);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Starting the container failed.");
    expect(failed.error).toContain("init process died while starting");
    expect(failed.error).not.toMatch(/without saying why/);
    expect(failed.diagnosis).toMatchObject({ id: "unknown-start-failure", confidence: "generic", step: "Starting the container" });
    expect(failed.diagnosis.evidence).toEqual(OWNER_LOG);
    expect(failed.diagnosis.fix.join("\n")).toContain("lxc-start -n 9000 -F -l DEBUG");
    expect(failed.diagnosis.plain).toContain("nesting is not the cause");
    const text = titles(failed);
    expect(text).toContain("sync_wait: 34 An error occurred in another process (expected sequence number 7)");
    expect(text).toContain("Trying once without the container features");
    expect(text).toContain("Fix:");
    expect(text).toMatch(/Container 9000 config: .*features=nesting=1/);
    expect(text).toContain('Proxmox does not report which filesystem is behind "local-lvm"');
    // The half-made container is gone, and the provider step still ran although the template did not.
    expect(pve.guests.size).toBe(0);
    expect(failed.steps.find((s: any) => s.id === "template").state).toBe("failed");
    expect(failed.steps.find((s: any) => s.id === "plugin").state).toBe("done");
    expect(failed.steps.find((s: any) => s.id === "environments").state).toBe("skipped");
    expect(failed.steps.find((s: any) => s.id === "grant").state).toBe("done");
    const s = await status(sam);
    expect(s.state).toBe("error");
    expect(s.diagnosis.id).toBe("unknown-start-failure");
    for (const secret of secretsAnywhere()) for (const b of everything) expect(b).not.toContain(secret);
  });

  it("learns that the host refuses nesting by starting once without it", async () => {
    const sam = await admin();
    await org(sam, "Northwind");
    pve.host.startFailsWithFeatures = true;
    pve.failLogs.set("start", OWNER_LOG);
    const failed = await runSetup(sam);
    expect(failed.status).toBe("failed");
    expect(failed.diagnosis.id).toBe("features-blocked");
    expect(failed.error).toContain("does not allow container nesting");
    expect(titles(failed)).toContain("It starts without the features: the host refuses them.");
    expect(pve.guests.size).toBe(0);
  });

  it("reads the host journal and names a specific cause behind the generic failure", async () => {
    const sam = await admin();
    await org(sam, "Northwind");
    pve.failures.add("start");
    pve.failLogs.set("start", OWNER_LOG);
    pve.host.journal = ["Nov 08 pve kernel: audit: type=1400 apparmor=\"DENIED\" operation=\"mount\" profile=\"lxc-9000_</var/lib/lxc>\" name=\"/sys/\"", "Nov 08 pve sshd[7]: Accepted publickey for root"];
    const failed = await runSetup(sam);
    expect(failed.diagnosis.id).toBe("apparmor");
    expect(failed.diagnosis.confidence).toBe("matched");
    expect(failed.diagnosis.evidence.join("\n")).toContain("apparmor=\"DENIED\"");
    expect(failed.diagnosis.evidence.join("\n")).not.toContain("Accepted publickey");
  });

  it("builds from the template for this host's processor when the catalog lists both", async () => {
    const sam = await admin();
    await org(sam, "Northwind");
    // The real host's catalog had both: an older amd64 and a newer arm64. Sorting by version alone picked arm64.
    pve.host.catalog = [
      "debian-13-standard_13.1-2_amd64.tar.zst",
      "debian-13-standard_13.6-1_arm64.tar.zst",
      "ubuntu-24.04-standard_24.04-2_amd64.tar.zst",
    ];
    const done = await runSetup(sam);
    expect(done.status).toBe("done");
    const create = pve.calls.find((c) => c.method === "POST" && c.path === "/nodes/pve/lxc");
    expect(create?.body ?? "").toContain("_amd64.tar.zst");
    expect(create?.body ?? "").not.toContain("_arm64.tar.zst");
    expect(done.log.map((l: any) => l.text).join("\n")).toContain("Using amd64 template debian-13-standard_13.1-2_amd64.tar.zst");
    const s = await status(sam);
    expect(s.arch).toBe("amd64");
    expect(s.template.arch).toBe("amd64");
  });

  it("replaces a damaged base template once and carries on", async () => {    const sam = await admin();
    await org(sam, "Northwind");
    pve.host.corruptOnce = true;
    const done = await runSetup(sam);
    expect(done.status).toBe("done");
    expect(titles(done)).toContain("looks damaged; removing it and downloading it again");
    expect(pve.calls.filter((c) => c.method === "POST" && c.path === "/nodes/pve/aplinfo")).toHaveLength(2);
    expect(pve.calls.some((c) => c.method === "DELETE" && c.path.includes("/storage/local/content/"))).toBe(true);
  });

  it("relays the task log into the job log while a task runs", async () => {
    const sam = await admin();
    await org(sam, "Northwind");
    const done = await runSetup(sam);
    expect(done.status).toBe("done");
    expect(titles(done)).toContain("  TASK OK");
    expect(titles(done)).toMatch(/Downloading debian-13-standard.*Proxmox checks it against sha512|Downloading debian-13-standard/);
  });

  it("stops before building when the storage is inactive, nearly full, or Proxmox is too old", async () => {
    const sam = await admin();
    pve.host.storage = { type: "dir", active: 0, avail: 10 * 1024 ** 3 };
    expect((await runSetup(sam)).error).toContain("is not active on this node");
    pve.host.storage = { type: "lvmthin", active: 1, avail: 1024 ** 3 };
    expect((await runSetup(sam)).error).toContain("has only 1.0 GiB free");
    pve.host.storage = { type: "lvmthin", active: 1, avail: 50 * 1024 ** 3 };
    pve.host.version = "7.4-17";
    expect((await runSetup(sam)).error).toContain("need Proxmox VE 8 or later");
  });

  it("warns, before building, that directory and network storage must support ownership", async () => {
    const sam = await admin();
    pve.host.storage = { type: "cifs", active: 1, avail: 50 * 1024 ** 3 };
    const done = await runSetup(sam);
    expect(titles(done)).toContain("cifs storage");
    expect(titles(done)).toContain("no_root_squash");
  });
});

describe("agent containers: the token's rights", () => {
  const ready = async () => {
    const sam = await admin();
    const { pool } = await org(sam, "Northwind");
    expect((await runSetup(sam)).status).toBe("done");
    return { sam, pool: pool! };
  };

  it("grants the pool with inheritance, so containers created later are covered, and the template once it exists", async () => {
    const { sam, pool } = await ready();
    const poolAcls = pve.acl.filter((a) => a.path === `/pool/${pool}` || a.path === "/pool/epc-agents");
    expect(poolAcls.length).toBeGreaterThanOrEqual(4);
    for (const a of poolAcls) expect(a.propagate).toBe(1);
    expect(pve.acl.filter((a) => a.path === "/vms/9000").map((a) => a.type).sort()).toEqual(["token", "user"]);
    const s = await status(sam);
    expect(s.steps.find((x: any) => x.id === "grant").done).toBe(true);
    expect(s.grantMissing).toEqual([]);
  });

  it("does not ask for rights on a template that does not exist yet", async () => {
    const sam = await admin();
    pve.failures.add("start");
    pve.failLogs.set("start", OWNER_LOG);
    await runSetup(sam);
    const g = (await status(sam)).steps.find((x: any) => x.id === "grant");
    expect(g.done).toBe(false);
    expect(g.detail).not.toContain("/vms/");
    expect(g.detail).toContain("template's own right is added once it is built");
  });

  it("names exactly which grant is missing, repairs only that one as the administrator, and checks it", async () => {
    const { sam, pool } = await ready();
    const i = pve.acl.findIndex((a) => a.path === `/pool/${pool}` && a.type === "token");
    pve.acl.splice(i, 1);
    let s = await status(sam);
    const g = s.steps.find((x: any) => x.id === "grant");
    expect(g.done).toBe(false);
    expect(g.detail).toBe(`Missing: EPCSandbox on /pool/${pool} for the token`);
    expect(s.grantMissing).toEqual([{ path: `/pool/${pool}`, role: "EPCSandbox", who: "token", why: "absent" }]);
    expect(s.state).toBe("partial");

    const before = pve.calls.filter((c) => c.method === "PUT" && c.path === "/access/acl").length;
    const start = await send("POST", "/api/agent-containers/steps/grant", sam);
    expect(start.status).toBe(202);
    let job: any;
    for (let k = 0; k < 200; k++) {
      job = (await send("GET", `/api/agent-containers/jobs/${start.json.jobId}`, sam)).json;
      if (job.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(job.status).toBe("done");
    expect(job.steps.map((x: any) => x.id)).toEqual(["grant"]);
    expect(pve.calls.filter((c) => c.method === "PUT" && c.path === "/access/acl").length - before).toBe(1);
    expect(titles(job)).toContain(`Granted EPCSandbox on /pool/${pool} to the epaperclip-sandbox@pve`);
    s = await status(sam);
    expect(s.state).toBe("ready");
    expect(s.grantMissing).toEqual([]);
  });

  it("treats an entry that does not reach the pool's members as missing", async () => {
    const { sam, pool } = await ready();
    pve.acl.find((a) => a.path === `/pool/${pool}` && a.type === "user" && a.roleid === "EPCSandbox")!.propagate = 0;
    const s = await status(sam);
    expect(s.grantMissing.map((x: any) => x.why)).toContain("not-inherited");
  });

  it("verifies what Proxmox will really allow, and says which privilege is lacking", async () => {
    const { sam, pool } = await ready();
    pve.roles.set("EPCSandbox", "VM.Audit,Pool.Audit");
    const s = await status(sam);
    const gap = s.grantMissing.find((x: any) => x.path === `/pool/${pool}` && x.who === "token");
    expect(gap.why).toBe("ineffective");
    expect(gap.lacking).toContain("VM.Allocate");
    expect(s.steps.find((x: any) => x.id === "grant").detail).toContain("lacking VM.Allocate");
    const start = await send("POST", "/api/agent-containers/steps/grant", sam);
    let job: any;
    for (let k = 0; k < 200; k++) {
      job = (await send("GET", `/api/agent-containers/jobs/${start.json.jobId}`, sam)).json;
      if (job.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(job.status).toBe("failed");
    expect(job.error).toContain("Proxmox still doesn't give the token these rights");
    expect(job.error).toContain("lacking VM.Allocate");
  });

  it("runs single steps only for administrators, only the known ones, and only after a full setup", async () => {
    const sam = await admin();
    expect((await send("POST", "/api/agent-containers/steps/grant", sam)).status).toBe(409);
    expect((await send("POST", "/api/agent-containers/steps/template", sam)).status).toBe(400);
    const lee = await signIn("lee");
    expect((await send("POST", "/api/agent-containers/steps/grant", lee)).status).toBe(403);
  });
});
