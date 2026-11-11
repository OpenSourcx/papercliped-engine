import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext, PluginEnvironmentLease } from "@paperclipai/plugin-sdk";
import { createProxmoxSandboxPlugin } from "../src/plugin.js";
import { FakeProxmox } from "./fake-proxmox.js";
import { baseConfig, createLocalShell, generatePemKey, noSleep, type LocalShell } from "./helpers.js";

const base = { driverKey: "proxmox", companyId: "company-1", environmentId: "env-1" };
const MIN = 60_000;

let pve: FakeProxmox;
let key: string;
let home: string;
let shell: LocalShell;
let clock: { t: number };
let stateData: Map<string, unknown>;
let plugin: ReturnType<typeof createProxmoxSandboxPlugin>;
let hooks: ReturnType<typeof createProxmoxSandboxPlugin>["definition"];

function fakeContext(): PluginContext {
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    state: {
      get: async (k: { stateKey: string }) => stateData.get(k.stateKey) ?? null,
      set: async (k: { stateKey: string }, v: unknown) => void stateData.set(k.stateKey, v),
      delete: async (k: { stateKey: string }) => void stateData.delete(k.stateKey),
    },
  } as unknown as PluginContext;
}

const jobs = new Set<Promise<void>>();
const idle = async () => { while (jobs.size) await Promise.allSettled([...jobs]); };

async function newPlugin() {
  const p = createProxmoxSandboxPlugin({
    ssh: shell.runner, sleep: noSleep, killGraceSeconds: 0, now: () => clock.t,
    trackBackground: (job) => { jobs.add(job); void job.finally(() => jobs.delete(job)); },
  });
  await p.definition.setup(fakeContext());
  return p;
}

beforeAll(async () => {
  pve = new FakeProxmox();
  await pve.start();
  key = generatePemKey();
});
afterAll(async () => pve.stop());

beforeEach(async () => {
  pve.requests.length = 0;
  pve.containers.clear();
  pve.taskFailures.clear();
  pve.nextVmid = 101;
  pve.addTemplate(9000);
  clock = { t: Date.now() };
  stateData = new Map();
  home = mkdtempSync(path.join(tmpdir(), "pve-lease-home-"));
  shell = createLocalShell(home);
  plugin = await newPlugin();
  hooks = plugin.definition;
});
afterEach(async () => { await idle(); rmSync(home, { recursive: true, force: true }); });

const config = (o: Record<string, unknown> = {}) => baseConfig(pve, key, o);
const acquire = (o: Record<string, unknown> = {}, runId = "run-1", company = "company-1"): Promise<PluginEnvironmentLease> =>
  hooks.onEnvironmentAcquireLease!({ ...base, companyId: company, config: config(o), runId });
const clones = () => pve.find("POST", /\/lxc\/9000\/clone$/).length;
const failClone = () => pve.taskFailures.set("vzclone", { exitstatus: "clone failed: out of space", log: [] });

describe("failure breaker (ERR-CTR-001)", () => {
  it("opens after 3 failures and then clones nothing and calls nothing", async () => {
    for (let i = 0; i < 3; i++) { failClone(); await expect(acquire({}, `r${i}`)).rejects.toThrow(/out of space/); }
    expect(clones()).toBe(3);
    pve.requests.length = 0;
    await expect(acquire({}, "r3")).rejects.toThrow(/breaker is open.*retry after.*out of space/i);
    expect(pve.requests).toHaveLength(0);
  });

  it("allows a trial after the cooldown, re-opens longer on failure, and one success resets it", async () => {
    for (let i = 0; i < 3; i++) { failClone(); await acquire({}, `r${i}`).catch(() => undefined); }
    clock.t += 2 * MIN + 1_000;
    failClone();
    await expect(acquire({}, "trial")).rejects.toThrow(/out of space/);
    clock.t += 3 * MIN; // the second cooldown is 4 min
    await expect(acquire({}, "t2")).rejects.toThrow(/breaker is open/);
    clock.t += 2 * MIN;
    const lease = await acquire({}, "ok");
    expect(lease.providerLeaseId).toBeTruthy();
    // reset: two new failures do not open it
    for (let i = 0; i < 2; i++) { failClone(); await acquire({}, `f${i}`).catch(() => undefined); }
    await expect(acquire({}, "after")).resolves.toBeTruthy();
  });

  it("keeps companies and environments apart", async () => {
    for (let i = 0; i < 3; i++) { failClone(); await acquire({}, `r${i}`).catch(() => undefined); }
    await expect(acquire({}, "other", "company-2")).resolves.toBeTruthy();
    await expect(hooks.onEnvironmentAcquireLease!({ ...base, environmentId: "env-2", config: config(), runId: "e2" })).resolves.toBeTruthy();
  });

  it("stays open across a worker restart through the plugin state API", async () => {
    for (let i = 0; i < 3; i++) { failClone(); await acquire({}, `r${i}`).catch(() => undefined); }
    plugin = await newPlugin();
    hooks = plugin.definition;
    pve.requests.length = 0;
    await expect(acquire({}, "after-restart")).rejects.toThrow(/breaker is open/);
    expect(pve.requests).toHaveLength(0);
  });

  it("can be tuned or turned off in the config", async () => {
    for (let i = 0; i < 4; i++) { failClone(); await acquire({ breakerThreshold: 0 }, `r${i}`).catch(() => undefined); }
    expect(clones()).toBe(4);
    failClone();
    await acquire({ breakerThreshold: 2 }, "x").catch(() => undefined);
    await expect(acquire({ breakerThreshold: 2 }, "y")).resolves.toBeTruthy(); // 1 failure on a new key counts, still closed
  });
});

describe("single flight", () => {
  it("shares one failed attempt between simultaneous acquires: one clone, same error for both", async () => {
    failClone();
    const results = await Promise.allSettled([acquire({}, "a"), acquire({}, "b"), acquire({}, "c")]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(clones()).toBe(1);
  });

  it("does not hand one container to two runs when leases are not reused", async () => {
    const [a, b] = await Promise.all([acquire({}, "a"), acquire({}, "b")]);
    expect(a.providerLeaseId).not.toBe(b.providerLeaseId);
  });

  it("with reuseLease, simultaneous acquires end up on one container", async () => {
    const [a, b] = await Promise.all([acquire({ reuseLease: true }, "a"), acquire({ reuseLease: true }, "b")]);
    expect(a.providerLeaseId).toBe(b.providerLeaseId);
    expect(clones()).toBe(1);
  });
});

describe("reuse", () => {
  it("reuses this company's running container instead of cloning", async () => {
    const first = await acquire({ reuseLease: true }, "run-1");
    const second = await acquire({ reuseLease: true }, "run-2");
    expect(second.providerLeaseId).toBe(first.providerLeaseId);
    expect(clones()).toBe(1);
    expect(pve.containers.get(101)!.config.tags).toContain("run-run-2");
  });

  it("starts and reuses a stopped owned container", async () => {
    const first = await acquire({ reuseLease: true }, "run-1");
    await hooks.onEnvironmentStopLease!({ ...base, config: config(), providerLeaseId: first.providerLeaseId });
    expect(pve.containers.get(101)!.status).toBe("stopped");
    const second = await acquire({ reuseLease: true }, "run-2");
    expect(second.providerLeaseId).toBe("pve/101");
    expect(pve.containers.get(101)!.status).toBe("running");
    expect(clones()).toBe(1);
  });

  it("never reuses another company's container, or one without our tag, or another environment's", async () => {
    pve.addContainer(300, { pool: "epaperclip", config: { tags: "epaperclip;company-company-2;run-x", description: "Paperclip sandbox. Company company-2, environment env-1, run x." } });
    pve.addContainer(301, { pool: "epaperclip", config: { tags: "production", description: "Company company-1, environment env-1" } });
    pve.addContainer(302, { pool: "epaperclip", config: { tags: "epaperclip;company-company-1;run-x", description: "Paperclip sandbox. Company company-1, environment env-9, run x." } });
    const lease = await acquire({ reuseLease: true });
    expect(lease.providerLeaseId).toBe("pve/101");
    for (const id of [300, 301, 302]) expect(pve.containers.get(id)!.status).toBe("running"); // untouched
    expect(clones()).toBe(1);
  });

  it("does not reuse when reuseLease is off", async () => {
    await acquire({}, "run-1");
    const second = await acquire({}, "run-2");
    expect(second.providerLeaseId).toBe("pve/102");
  });
});

describe("orphan cleanup", () => {
  const old = new Date(Date.now() - 30 * MIN).toISOString();
  const young = new Date(Date.now() - 2 * MIN).toISOString();
  const desc = (company: string, at: string) => `Paperclip sandbox. Company ${company}, environment env-1, run x. Created ${at}.`;

  it("destroys this company's old failed creates before cloning, and nothing else", async () => {
    pve.addContainer(200, { status: "stopped", pool: "epaperclip", config: { tags: "epaperclip;company-company-1;run-a;provisioning", description: desc("company-1", old) } }); // orphan
    pve.addContainer(201, { status: "stopped", pool: "epaperclip", config: { tags: "epaperclip;company-company-1;run-a;provisioning", description: desc("company-1", young) } }); // too young
    pve.addContainer(202, { status: "stopped", pool: "epaperclip", config: { tags: "epaperclip;company-company-2;run-a;provisioning", description: desc("company-2", old) } }); // other company
    pve.addContainer(203, { status: "stopped", pool: "epaperclip", config: { tags: "provisioning", description: desc("company-1", old) } }); // no ownership tag
    pve.addContainer(204, { status: "stopped", pool: "epaperclip", config: { tags: "epaperclip;company-company-1;run-a", description: desc("company-1", old) } }); // retained lease, finished
    pve.addTemplate(205, { tags: "epaperclip;company-company-1;provisioning", description: desc("company-1", old) });
    pve.containers.get(205)!.pool = "epaperclip";
    await acquire();
    expect(pve.containers.has(200)).toBe(false);
    for (const id of [201, 202, 203, 204, 205, 9000]) expect(pve.containers.has(id), `CT ${id}`).toBe(true);
  });

  it("runs before the clone, so a failing clone still frees the disk of earlier leaks", async () => {
    pve.addContainer(200, { status: "stopped", pool: "epaperclip", config: { tags: "epaperclip;company-company-1;run-a;provisioning", description: desc("company-1", old) } });
    failClone();
    await expect(acquire()).rejects.toThrow(/out of space/);
    expect(pve.containers.has(200)).toBe(false);
  });

  it("marks a new container as provisioning until it is ready, and a finished lease is never swept", async () => {
    const lease = await acquire();
    const vmid = Number(lease.providerLeaseId!.split("/")[1]);
    expect(String(pve.containers.get(vmid)!.config.tags)).not.toContain("provisioning");
    await hooks.onEnvironmentStopLease!({ ...base, config: config(), providerLeaseId: lease.providerLeaseId });
    clock.t += 60 * MIN;
    await acquire({}, "run-2");
    expect(pve.containers.has(vmid)).toBe(true);
  });
});

describe("spare container", () => {
  it("keeps no spare by default", async () => {
    await acquire();
    await idle();
    expect(pve.containers.size).toBe(2); // template + lease
  });

  it("keeps one stopped pre-clone and uses it for the next acquire without cloning", async () => {
    await acquire({ spareContainers: 1 }, "run-1");
    await idle();
    expect([...pve.containers.values()].filter((c) => String(c.config.tags ?? "").includes("spare"))).toHaveLength(1);
    const spare = [...pve.containers.values()].find((c) => String(c.config.tags ?? "").includes("spare"))!;
    expect(spare.status).toBe("stopped");
    const before = clones();
    const lease = await acquire({ spareContainers: 1 }, "run-2");
    expect(lease.providerLeaseId).toBe(`pve/${spare.vmid}`);
    expect(String(spare.config.tags)).not.toContain("spare");
    expect(pve.containers.get(spare.vmid)!.status).toBe("running");
    expect(clones()).toBe(before);
    await idle();
    expect(clones()).toBe(before + 1); // and a new spare is made behind it
  });

  it("the orphan sweep leaves an old spare alone", async () => {
    await acquire({ spareContainers: 1 }, "run-1");
    await idle();
    const spare = [...pve.containers.values()].find((c) => String(c.config.tags ?? "").includes("spare"))!;
    clock.t += 60 * MIN;
    await acquire({ spareContainers: 1 }, "run-2"); // sweeps first: the spare is old but not provisioning, so it survives and is adopted
    expect(pve.containers.has(spare.vmid)).toBe(true);
    await idle();
  });
});

describe("engine-style flow", () => {
  it("acquire, realize workspace, execute, then release deletes the container; a second run starts clean", async () => {
    const lease = await acquire({}, "run-flow");
    const ws = await hooks.onEnvironmentRealizeWorkspace!({ ...base, config: config(), lease, workspace: { remotePath: path.join(home, "ws") } } as never);
    expect(ws.cwd).toBeTruthy();
    const out = await hooks.onEnvironmentExecute!({ ...base, config: config(), lease, command: "sh", args: ["-c", "echo hi && pwd"], cwd: ws.cwd });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("hi");
    const resumed = await hooks.onEnvironmentResumeLease!({ ...base, config: config(), providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata });
    expect(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    const receipt = await hooks.onEnvironmentReleaseLease!({ ...base, config: config(), providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata });
    expect(receipt).toMatchObject({ state: "destroyed" });
    expect(pve.containers.has(101)).toBe(false);
    const next = await acquire({}, "run-next");
    expect(next.providerLeaseId).toBe("pve/101");
  });

  it("a verification loop that keeps failing costs at most 3 clones, then none", async () => {
    let attempts = 0;
    for (; attempts < 10; attempts++) {
      failClone();
      await acquire({}, `verify-${attempts}`).catch(() => undefined);
    }
    expect(clones()).toBe(3);
    expect(pve.containers.size).toBe(1); // only the template: nothing leaked
  });
});

describe("config", () => {
  it("has safe breaker defaults and rejects nonsense", async () => {
    const ok = await hooks.onEnvironmentValidateConfig!({ driverKey: "proxmox", config: config() });
    expect(ok.normalizedConfig).toMatchObject({ breakerThreshold: 3, breakerWindowMs: 15 * MIN, breakerCooldownMs: 2 * MIN, breakerMaxCooldownMs: 30 * MIN, spareContainers: 0 });
    const bad = await hooks.onEnvironmentValidateConfig!({ driverKey: "proxmox", config: config({ spareContainers: 2, breakerThreshold: -1, breakerWindowMs: 5 }) });
    expect(bad.ok).toBe(false);
    for (const re of [/spareContainers/, /breakerThreshold/, /breakerWindowMs/]) expect(bad.errors!.join(" ")).toMatch(re);
  });
});
