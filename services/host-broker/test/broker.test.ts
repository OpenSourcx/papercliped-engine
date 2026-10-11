import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ClusterResource, RrdCf, RrdTimeframe } from "@papercliped-engine/proxmox-client";
import { Broker, BrokerError, decodeMarker } from "../src/broker.ts";
import { parseBrokerConfig, type Principal } from "../src/config.ts";
import { authenticate, startServer } from "../src/server.ts";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const PIN_TOKEN = "pin-token-0123456789abcdef";
const ACME_TOKEN = "acme-token-0123456789abcdef";
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq6b0Ytx1o3a0XrJr0b0n1Gf5Q9m6f4b9X0kq1y2z3a paperclip";
const MiB = 1024 * 1024;

const rawConfig = (over: Record<string, unknown> = {}) => ({
  proxmox: { url: "https://pve.test:8006", node: "pve", tokenId: "broker@pve!engine" },
  protectedVmids: [106],
  profiles: {
    small: { ostemplate: "local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst", storage: "drive2", bridge: "vmbr0", cores: 2, memoryMb: 1024, diskGb: 8 },
  },
  groups: {
    acme: { pool: "co-acme", tag: "co-acme", vmidRange: [9000, 9009], profiles: ["small"], limits: { maxLeases: 2, maxCores: 4, maxMemoryMb: 4096 } },
    beta: { pool: "co-beta", tag: "co-beta", vmidRange: [9100, 9109], profiles: ["small"] },
  },
  principals: [
    { name: "pin", scope: "system", tokenSha256: sha(PIN_TOKEN) },
    { name: "acme-agents", scope: "group", group: "acme", tokenSha256: sha(ACME_TOKEN) },
  ],
  ...over,
});

const config = (over: Record<string, unknown> = {}) => parseBrokerConfig(rawConfig(over), { PROXMOX_TOKEN_SECRET: "s3cret" });

/** An in-memory Proxmox: enough of the API for the broker, recording every write. */
function fakePve(initial: (ClusterResource & { description?: string })[] = []) {
  const guests = new Map<number, ClusterResource & { description?: string; hostname?: string }>(initial.map((g) => [g.vmid!, { ...g }]));
  const calls: { op: string; args: unknown[] }[] = [];
  let upid = 0;
  const task = () => `UPID:pve:${++upid}`;
  const pve = {
    calls,
    guests,
    failStart: false,
    version: async () => ({ version: "9.2.3", release: "9.2" }),
    nodeStatus: async () => ({ cpu: 0.1, cpuinfo: { cpus: 8 }, memory: { total: 32 * 1024 * MiB, used: 8 * 1024 * MiB, free: 24 * 1024 * MiB } }),
    clusterResources: async () => [...guests.values()].map(({ description: _d, hostname: _h, ...r }) => r),
    checkVmidFree: async (vmid: number) => {
      if (guests.has(vmid)) throw new Error("exists");
      return vmid;
    },
    createLxc: async (node: string, p: Record<string, any>) => {
      calls.push({ op: "createLxc", args: [node, p] });
      guests.set(p.vmid, { vmid: p.vmid, type: "lxc", node, pool: p.pool, tags: p.tags, status: "stopped", maxcpu: p.cores, maxmem: p.memory * MiB, description: p.description, hostname: p.hostname });
      return task();
    },
    cloneLxc: async () => task(),
    setLxcConfig: async () => null,
    lxcConfig: async (_n: string, vmid: number) => ({ description: guests.get(vmid)?.description, hostname: guests.get(vmid)?.hostname }),
    lxcInterfaces: async (_n: string, vmid: number) => [{ name: "lo", inet: "127.0.0.1/8" }, { name: "eth0", inet: `10.0.0.${vmid % 256}/24` }],
    startLxc: async (_n: string, vmid: number) => {
      calls.push({ op: "startLxc", args: [vmid] });
      if (pve.failStart) throw new Error("start failed");
      guests.get(vmid)!.status = "running";
      return task();
    },
    destroyLxc: async (_n: string, vmid: number) => {
      calls.push({ op: "destroyLxc", args: [vmid] });
      guests.delete(vmid);
      return task();
    },
    guestPower: async (_n: string, type: string, vmid: number, action: string) => {
      calls.push({ op: "guestPower", args: [type, vmid, action] });
      return task();
    },
    guestSnapshot: async (_n: string, type: string, vmid: number, name: string) => {
      calls.push({ op: "guestSnapshot", args: [type, vmid, name] });
      return task();
    },
    waitTask: async () => undefined,
    guestRrd: async (_n: string, type: string, vmid: number, timeframe: RrdTimeframe, cf?: RrdCf) => {
      calls.push({ op: "guestRrd", args: [type, vmid, timeframe, cf] });
      return [{ time: 1, cpu: 0.1, maxcpu: 2, mem: 1, maxmem: 2 }];
    },
    nodeRrd: async (_n: string, timeframe: RrdTimeframe, cf?: RrdCf) => {
      calls.push({ op: "nodeRrd", args: [timeframe, cf] });
      return [{ time: 1, cpu: 0.05, loadavg: 0.3 }];
    },
  };
  return pve;
}

const NOW = Date.parse("2026-10-11T12:00:00Z");
function setup(initial: Parameters<typeof fakePve>[0] = [], over: Record<string, unknown> = {}) {
  const cfg = config(over);
  const pve = fakePve(initial);
  const audit: Record<string, unknown>[] = [];
  const broker = new Broker({ config: cfg, pve, audit: (e) => audit.push(e), now: () => NOW, sleep: async () => undefined });
  const pin = cfg.principals.find((p) => p.name === "pin")!;
  const acme = cfg.principals.find((p) => p.name === "acme-agents")!;
  return { cfg, pve, audit, broker, pin, acme };
}

const expectBrokerError = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toBeInstanceOf(BrokerError);
  await expect(p).rejects.toMatchObject({ code });
};

describe("config", () => {
  it("rejects overlapping resource groups, so one company cannot reach another's guests", () => {
    expect(() => config({ groups: { a: { pool: "a", vmidRange: [9000, 9010], profiles: ["small"] }, b: { pool: "b", vmidRange: [9005, 9020], profiles: ["small"] } } })).toThrow(/overlapping/);
  });
  it("rejects a protected guest inside a group's range", () => {
    expect(() => config({ protectedVmids: [9001] })).toThrow(/protected guest 9001/);
  });
  it("needs the Proxmox secret from the environment", () => {
    expect(() => parseBrokerConfig(rawConfig(), {})).toThrow(/PROXMOX_TOKEN_SECRET/);
  });
});

describe("scopes", () => {
  it("keeps a company inside its own resource group", async () => {
    const { broker, acme } = setup();
    await expectBrokerError(broker.listLeases(acme, "beta"), "forbidden");
    await expectBrokerError(broker.hostStatus(acme), "forbidden");
    await expectBrokerError(broker.listGuests(acme), "forbidden");
    await expectBrokerError(broker.guestAction(acme, 105, "shutdown"), "forbidden");
  });
  it("lets Pin read the host and any group", async () => {
    const { broker, pin } = setup();
    const host = await broker.hostStatus(pin);
    expect(host.groups.map((g) => g.name)).toEqual(["acme", "beta"]);
    expect(await broker.listLeases(pin, "beta")).toEqual([]);
  });
});

describe("leases", () => {
  it("creates an unprivileged container in the group's pool, range and tag", async () => {
    const { broker, acme, pve, audit } = setup([{ vmid: 9000, type: "lxc", pool: "someone-else" }]);
    const lease = await broker.createLease(acme, "acme", { profile: "small", sshPublicKey: KEY, runId: "run-1" });
    expect(lease).toMatchObject({ id: "9001", group: "acme", status: "running", ip: "10.0.0.41", profile: "small", runId: "run-1" });
    const [, params] = pve.calls.find((c) => c.op === "createLxc")!.args as [string, Record<string, any>];
    expect(params).toMatchObject({ vmid: 9001, pool: "co-acme", tags: "co-acme", unprivileged: true, "ssh-public-keys": KEY, rootfs: "drive2:8" });
    expect(decodeMarker(params.description).expiresAt).toBe("2026-10-11T14:00:00.000Z");
    expect(audit.at(-1)).toMatchObject({ action: "lease.create", by: "acme-agents", ok: true, vmid: 9001 });
  });

  it("enforces the group's lease and core limits", async () => {
    const { broker, acme } = setup();
    await broker.createLease(acme, "acme", { profile: "small", sshPublicKey: KEY });
    await broker.createLease(acme, "acme", { profile: "small", sshPublicKey: KEY });
    await expectBrokerError(broker.createLease(acme, "acme", { profile: "small", sshPublicKey: KEY }), "group_limit");
  });

  it("refuses bad keys, unknown profiles and past expiry", async () => {
    const { broker, acme } = setup();
    await expectBrokerError(broker.createLease(acme, "acme", { profile: "small", sshPublicKey: "not a key" }), "bad_ssh_key");
    await expectBrokerError(broker.createLease(acme, "acme", { profile: "huge", sshPublicKey: KEY }), "unknown_profile");
    await expectBrokerError(broker.createLease(acme, "acme", { profile: "small", sshPublicKey: KEY, requestedExpiresAt: "2020-01-01T00:00:00Z" }), "bad_expiry");
  });

  it("caps expiry at the group's maximum lifetime", async () => {
    const { broker, acme } = setup();
    const lease = await broker.createLease(acme, "acme", { profile: "small", sshPublicKey: KEY, requestedExpiresAt: "2030-01-01T00:00:00Z" });
    expect(lease.expiresAt).toBe("2026-10-11T16:00:00.000Z");
  });

  it("cleans up when a container fails to start", async () => {
    const { broker, acme, pve } = setup();
    pve.failStart = true;
    await expect(broker.createLease(acme, "acme", { profile: "small", sshPublicKey: KEY })).rejects.toThrow(/start failed/);
    expect(pve.calls.some((c) => c.op === "destroyLxc")).toBe(true);
    expect(pve.guests.size).toBe(0);
  });

  it("only destroys guests that are really in the group", async () => {
    const { broker, acme, pve } = setup([
      { vmid: 9005, type: "lxc", pool: "co-acme", tags: "something-else", node: "pve" },
      { vmid: 9006, type: "lxc", pool: "other-pool", tags: "co-acme", node: "pve" },
    ]);
    await expectBrokerError(broker.destroyLease(acme, "acme", "9005"), "not_in_group");
    await expectBrokerError(broker.destroyLease(acme, "acme", "9006"), "not_in_group");
    await expectBrokerError(broker.destroyLease(acme, "acme", "105"), "lease_not_found");
    expect(pve.calls.some((c) => c.op === "destroyLxc")).toBe(false);
    expect(await broker.destroyLease(acme, "acme", "9007")).toEqual({ id: "9007", state: "destroyed", alreadyGone: true });
  });

  it("reaps expired leases and leases with no expiry, and keeps live ones", async () => {
    const tag = { type: "lxc", pool: "co-acme", tags: "co-acme", node: "pve", status: "running" };
    const { broker, pve } = setup([
      { vmid: 9001, ...tag, description: "papercliped-lease profile=small expires=2026-10-11T11:00:00.000Z" },
      { vmid: 9002, ...tag, description: "papercliped-lease profile=small expires=2026-10-11T13:00:00.000Z" },
      { vmid: 9003, ...tag, description: "hand-made" },
    ]);
    expect(await broker.reapExpired()).toEqual(["acme/9001", "acme/9003"]);
    expect([...pve.guests.keys()]).toEqual([9002]);
  });
});

describe("guest actions (Pin)", () => {
  const guests = [
    { vmid: 105, type: "lxc", node: "pve", status: "running" },
    { vmid: 106, type: "lxc", node: "pve", status: "running" },
    { vmid: 109, type: "qemu", node: "pve", status: "running" },
    { vmid: 9500, type: "lxc", node: "pve", template: 1 },
  ];
  it("powers guests and snapshots them", async () => {
    const { broker, pin, pve, audit } = setup(guests);
    await broker.guestAction(pin, 109, "shutdown", "automation");
    await broker.guestAction(pin, 105, "snapshot");
    expect(pve.calls.map((c) => c.op)).toEqual(["guestPower", "guestSnapshot"]);
    expect(pve.calls[0].args).toEqual(["qemu", 109, "shutdown"]);
    expect(audit[0]).toMatchObject({ action: "guest.action", op: "shutdown", by: "pin", source: "automation", ok: true });
  });
  it("refuses protected guests, templates and destroy", async () => {
    const { broker, pin, pve } = setup(guests);
    await expectBrokerError(broker.guestAction(pin, 106, "stop"), "protected");
    await expectBrokerError(broker.guestAction(pin, 9500, "start"), "template");
    await expectBrokerError(broker.guestAction(pin, 105, "destroy" as never), "bad_action");
    expect(pve.calls).toEqual([]);
  });
});

describe("stats", () => {
  const guests = [
    { vmid: 109, type: "qemu", node: "pve", status: "running" },
    { vmid: 9001, type: "lxc", pool: "co-acme", tags: "co-acme", node: "pve", status: "running" },
  ];
  it("lets Pin read any guest and the node", async () => {
    const { broker, pin, pve } = setup(guests);
    expect(await broker.stats(pin, { vmid: 109 }, "day", "MAX")).toHaveLength(1);
    expect(await broker.stats(pin, { node: true }, "hour", "AVERAGE")).toHaveLength(1);
    expect(pve.calls.map((c) => c.args)).toEqual([["qemu", 109, "day", "MAX"], ["hour", "AVERAGE"]]);
  });
  it("lets a company read only its own leases, never the node", async () => {
    const { broker, acme } = setup(guests);
    expect(await broker.stats(acme, { vmid: 9001 }, "hour", "AVERAGE")).toHaveLength(1);
    await expectBrokerError(broker.stats(acme, { vmid: 109 }, "hour", "AVERAGE"), "guest_not_found");
    await expectBrokerError(broker.stats(acme, { node: true }, "hour", "AVERAGE"), "forbidden");
  });
  it("validates timeframe and consolidation", async () => {
    const { broker, pin } = setup(guests);
    await expectBrokerError(broker.stats(pin, { vmid: 109 }, "decade", "AVERAGE"), "bad_timeframe");
    await expectBrokerError(broker.stats(pin, { vmid: 109 }, "hour", "MIN"), "bad_cf");
  });
});

describe("HTTP", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it("authenticates by token hash", () => {
    const principals: Principal[] = config().principals;
    expect(authenticate(`Bearer ${PIN_TOKEN}`, principals)?.name).toBe("pin");
    expect(authenticate(`Bearer ${ACME_TOKEN}`, principals)?.name).toBe("acme-agents");
    expect(authenticate("Bearer wrong-token-0123456789", principals)).toBeNull();
    expect(authenticate(undefined, principals)).toBeNull();
  });

  it("serves the API end to end", async () => {
    const { broker, cfg } = setup([{ vmid: 109, type: "qemu", node: "pve", status: "running" }]);
    const server = startServer(broker, cfg.principals, { host: "127.0.0.1", port: 0 });
    close = () => server.close();
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const as = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

    expect((await fetch(`${base}/v1/health`)).status).toBe(200);
    expect((await fetch(`${base}/v1/host`)).status).toBe(401);
    expect((await fetch(`${base}/v1/host`, { headers: as(ACME_TOKEN) })).status).toBe(403);
    expect((await fetch(`${base}/v1/host`, { headers: as(PIN_TOKEN) })).status).toBe(200);

    const created = await fetch(`${base}/v1/groups/acme/leases`, { method: "POST", headers: { ...as(ACME_TOKEN), "Content-Type": "application/json" }, body: JSON.stringify({ profile: "small", sshPublicKey: KEY }) });
    expect(created.status).toBe(201);
    const lease = (await created.json()) as { id: string };
    expect((await fetch(`${base}/v1/groups/beta/leases`, { headers: as(ACME_TOKEN) })).status).toBe(403);
    const del = await fetch(`${base}/v1/groups/acme/leases/${lease.id}`, { method: "DELETE", headers: as(ACME_TOKEN) });
    expect(await del.json()).toMatchObject({ state: "destroyed", alreadyGone: false });

    const act = await fetch(`${base}/v1/guests/109/actions`, { method: "POST", headers: as(PIN_TOKEN), body: JSON.stringify({ action: "shutdown" }) });
    expect(act.status).toBe(200);
  });
});
