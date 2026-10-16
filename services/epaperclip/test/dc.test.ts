import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { FEATURES } from "../src/features/index.ts";
import { createNodeFeature } from "../src/features/node.ts";
import { TlsReloader } from "../src/features/nodeTls.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { dg, fakeDcPve } from "./fakes-dc.ts";

let pve: ReturnType<typeof fakeDcPve>;
let server: Server;
let base: string;
let seen: string[];
const original = [...FEATURES];

beforeEach(async () => {
  pve = fakeDcPve();
  seen = [];
  const tls = new TlsReloader();
  tls.reloadSoon = () => {};
  FEATURES.splice(0, FEATURES.length, { name: "node", handle: createNodeFeature({ tls, pollMs: 5 }) });
  const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(), staticDir: null, secureCookies: false, state: new StateStore(mkdtempSync(join(tmpdir(), "epc-dc-"))) });
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  FEATURES.splice(0, FEATURES.length, ...original);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

async function signIn(username: string) {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username, password: "right", realm: "pve" }) });
  expect(r.status).toBe(200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
const send = async (cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = { "X-EPC-Request": "1" }) => {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  seen.push(text);
  return { status: r.status, json: (text ? JSON.parse(text) : null) as any };
};
const callsTo = (method: string, path: string) => pve.calls.filter((c) => c.method === method && c.path === path);

describe("hardware and node details", () => {
  it("needs a session and shows CPU, memory, boot mode, PCI and USB", async () => {
    expect((await send("", "GET", "/api/node/hardware")).status).toBe(401);
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/hardware");
    expect(r.status).toBe(200);
    expect(r.json.cpu).toMatchObject({ model: "AMD EPYC 7302", sockets: 1, cores: 16, threads: 32, hvm: true });
    expect(r.json.boot).toEqual({ mode: "efi", secureboot: false });
    expect(r.json.memory.total).toBe(16e9);
    expect(r.json.pci[0]).toMatchObject({ id: "0000:01:00.0", vendorName: "NVIDIA", iommuGroup: 14, mdev: true });
    expect(r.json.pci[1].iommuGroup).toBeNull();
    expect(r.json.usb[0]).toMatchObject({ vendid: "0781", product: "Ultra Fit" });
  });

  it("says when this account can't read PCI devices instead of failing the page", async () => {
    const lee = await signIn("lee");
    const r = await send(lee, "GET", "/api/node/hardware");
    expect(r.status).toBe(200);
    expect(r.json.pciDenied).toBe(true);
    expect(r.json.pci).toBeNull();
  });

  it("lists mediated device types and refuses odd device names", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "GET", "/api/node/hardware/mdev?pci=0000:01:00.0")).json.types[0]).toMatchObject({ type: "nvidia-256", available: 2 });
    expect((await send(sam, "GET", "/api/node/hardware/mdev?pci=../x")).status).toBe(400);
  });

  it("returns the support report and package versions", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "GET", "/api/node/report")).json.report).toMatch(/general system info/);
    const v = await send(sam, "GET", "/api/node/versions");
    expect(v.json.packages.map((p: any) => p.package)).toContain("proxmox-ve");
  });

  it("reads and saves node notes and options with strict checks", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "GET", "/api/node/config")).json.schema["startall-onboot-delay"].max).toBe(300);
    expect((await send(sam, "PUT", "/api/node/config", { values: { description: "rack 1", "startall-onboot-delay": 20 } })).status).toBe(200);
    expect(pve.st.nodeConfig.description).toBe("rack 1");
    for (const values of [{ "startall-onboot-delay": 301 }, { evil: 1 }, { "ballooning-target": "x" }, {}]) expect((await send(sam, "PUT", "/api/node/config", { values })).status).toBe(400);
    expect((await send(sam, "PUT", "/api/node/config", { values: { description: "x" } }, {})).status).toBe(403);
  });

  it("analyzes schedules and reads exported metrics, refusing odd input", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "GET", "/api/node/schedule?schedule=mon..fri%2002:00&count=2")).json.runs).toHaveLength(2);
    for (const q of ["schedule=a;b", "schedule=", "schedule=02:00&count=500"]) expect((await send(sam, "GET", `/api/node/schedule?${q}`)).status).toBe(400);
    const m = await send(sam, "GET", "/api/node/metrics-export?since=1700000000");
    expect(m.json.metrics[0]).toMatchObject({ metric: "cpu", value: 0.2 });
    expect((await send(sam, "GET", "/api/node/metrics-export?since=abc")).status).toBe(400);
  });
});

describe("resource totals and tree", () => {
  it("adds up CPU, memory, storage (shared counted once) and machines", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/resources");
    expect(r.json.totals).toMatchObject({ nodes: { online: 1, total: 1 }, cpu: { used: 1, total: 4 }, memory: { used: 2e9, total: 8e9 }, storage: { used: 30e9, total: 300e9 }, guests: { running: 1, stopped: 1, templates: 1, vms: 1, containers: 1 } });
    expect(r.json.rows.find((x: any) => x.vmid === 100)).toMatchObject({ pool: "prod", tags: ["prod", "web"] });
    expect(r.json.pools).toEqual([{ pool: "prod", comment: "production" }]);
  });
});

describe("bulk guest actions", () => {
  it("starts all without a confirmation, and passes only valid options", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/bulk/startall", { vms: [100, 101], maxWorkers: 2 })).status).toBe(202);
    expect(pve.dc.bulk[0].body).toContain("vms=100%2C101");
    expect(pve.dc.bulk[0].body).toContain("max-workers=2");
    for (const body of [{ vms: "abc" }, { maxWorkers: 0 }, { maxWorkers: 99 }, { evil: 1 }]) expect((await send(sam, "POST", "/api/node/bulk/startall", body)).status).toBe(400);
  });

  it("makes you type the node name before stopping, suspending or moving", async () => {
    const sam = await signIn("sam");
    for (const a of ["stopall", "suspendall", "migrateall"]) {
      const no = await send(sam, "POST", `/api/node/bulk/${a}`, a === "migrateall" ? { target: "pve2" } : {});
      expect(no.status).toBe(400);
      expect(no.json.error).toMatch(/pve/);
    }
    expect(pve.dc.bulk).toHaveLength(0);
    expect((await send(sam, "POST", "/api/node/bulk/stopall", { confirm: "pve", timeout: 60 })).status).toBe(202);
    expect((await send(sam, "POST", "/api/node/bulk/suspendall", { confirm: "pve" })).status).toBe(202);
  });

  it("only moves to a different node that is online", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/bulk/migrateall", { confirm: "pve", target: "pve" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/bulk/migrateall", { confirm: "pve", target: "pve2" })).json.error).toMatch(/offline/);
    expect((await send(sam, "POST", "/api/node/bulk/migrateall", { confirm: "pve", target: "ghost" })).status).toBe(400);
    expect(pve.dc.bulk).toHaveLength(0);
  });

  it("is refused for an account without permission", async () => {
    const lee = await signIn("lee");
    expect((await send(lee, "POST", "/api/node/bulk/startall", {})).status).toBe(403);
  });
});

describe("backup jobs", () => {
  it("lists jobs with every option, machines no job covers, storages and pools", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/backup/jobs");
    expect(r.json.jobs[0]).toMatchObject({ id: "daily", nextRun: 1_800_000_000, values: { schedule: "02:00", storage: "pbs", all: true, mode: "snapshot", compress: "zstd", "prune-backups": { "keep-last": 3 } } });
    expect(r.json.uncovered).toEqual([{ vmid: 102, name: "db", type: "qemu" }]);
    expect(r.json.storages).toEqual(["pbs", "local"]);
    expect(r.json.pools).toEqual(["prod"]);
    expect(r.json.schema.fleecing.props.enabled).toBeTruthy();
  });

  it("creates a job with notes template, fleecing, bandwidth, zstd threads and repeat-missed", async () => {
    const sam = await signIn("sam");
    const values = { schedule: "mon..fri 03:00", storage: "pbs", pool: "prod", mode: "snapshot", compress: "zstd", zstd: 4, bwlimit: 50000, ionice: 7, "notes-template": "{{guestname}}", fleecing: { enabled: true, storage: "local" }, "repeat-missed": true, "prune-backups": { "keep-last": 5, "keep-weekly": 4 }, performance: { "max-workers": 8 }, "notification-mode": "notification-system" };
    expect((await send(sam, "POST", "/api/node/backup/jobs", { id: "weekly", values })).status).toBe(201);
    const body = new URLSearchParams(callsTo("POST", "/cluster/backup")[0].body);
    expect(body.get("pool")).toBe("prod");
    expect(body.get("fleecing")).toBe("enabled=1,storage=local");
    expect(body.get("repeat-missed")).toBe("1");
    expect(body.get("prune-backups")).toBe("keep-last=5,keep-weekly=4");
    expect(body.get("id")).toBe("weekly");
    expect(callsTo("POST", "/cluster/backup")[0].user).toBe("sam@pve");
  });

  it("refuses jobs that select nothing, select two ways, or carry odd values", async () => {
    const sam = await signIn("sam");
    const ok = { schedule: "02:00", storage: "pbs" };
    const cases: Record<string, unknown>[] = [
      { ...ok },
      { ...ok, all: true, vmid: "100" },
      { ...ok, vmid: "abc" },
      { ...ok, vmid: "100,101", exclude: "101" },
      { ...ok, all: true, mode: "dangerous" },
      { ...ok, all: true, ionice: 99 },
      { ...ok, all: true, script: "/tmp/x.sh" },
      { ...ok, all: true, tmpdir: "/etc" },
      { schedule: "02:00;rm", storage: "pbs", all: true },
      { schedule: "02:00", storage: "../etc", all: true },
      { storage: "pbs", all: true },
    ];
    for (const values of cases) expect((await send(sam, "POST", "/api/node/backup/jobs", { values })).status, JSON.stringify(values)).toBe(400);
    expect((await send(sam, "POST", "/api/node/backup/jobs", { id: "bad id", values: { ...ok, all: true } })).status).toBe(400);
    expect(callsTo("POST", "/cluster/backup")).toHaveLength(0);
  });

  it("refuses a retention that keeps everything and also limits", async () => {
    const sam = await signIn("sam");
    const bad = await send(sam, "POST", "/api/node/backup/jobs", { values: { schedule: "02:00", storage: "pbs", all: true, "prune-backups": { "keep-all": true, "keep-last": 3 } } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/keep everything/i);
  });

  it("edits with the digest, switching how machines are selected, and refuses stale edits", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "PUT", "/api/node/backup/jobs/daily", { values: { vmid: "100,101" }, digest: dg("j1") })).status).toBe(200);
    const body = new URLSearchParams(callsTo("PUT", "/cluster/backup/daily")[0].body);
    expect(body.get("vmid")).toBe("100,101");
    expect(body.get("delete")?.split(",")).toContain("all");
    expect(body.get("digest")).toBe(dg("j1"));
    expect((await send(sam, "PUT", "/api/node/backup/jobs/daily", { values: { comment: "x" }, digest: dg("stale") })).status).toBe(502);
    expect((await send(sam, "PUT", "/api/node/backup/jobs/daily", { values: {} })).status).toBe(400);
  });

  it("deletes only after the job name is typed", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "DELETE", "/api/node/backup/jobs/daily", {})).status).toBe(400);
    expect(pve.dc.jobs.has("daily")).toBe(true);
    expect((await send(sam, "DELETE", "/api/node/backup/jobs/daily", { confirm: "daily" })).status).toBe(200);
    expect(pve.dc.jobs.has("daily")).toBe(false);
  });

  it("shows which volumes a job includes", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/backup/jobs/daily/volumes");
    expect(r.json.guests[0].volumes.map((v: any) => [v.id, v.included, v.reason])).toEqual([["vm-100-disk-0", true, null], ["vm-100-disk-1", false, "backup=0"]]);
  });
});

describe("backups on a storage", () => {
  it("lists backups with notes, protection and verification", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/backup/archives?storage=pbs");
    expect(r.json.archives[0]).toMatchObject({ vmid: 100, type: "qemu", notes: "before upgrade", protected: false, verified: "ok" });
    expect((await send(sam, "GET", "/api/node/backup/archives?storage=local")).json.archives[0]).toMatchObject({ type: "lxc", protected: true });
    expect((await send(sam, "GET", "/api/node/backup/archives?storage=../x")).status).toBe(400);
    expect((await send(sam, "GET", "/api/node/backup/archives?storage=pbs&vmid=x")).status).toBe(400);
  });

  it("protects a backup and edits its notes", async () => {
    const sam = await signIn("sam");
    const volid = "pbs:backup/vm/100/2026-01-02T01:00:00Z";
    expect((await send(sam, "PUT", "/api/node/backup/archives", { storage: "pbs", volid, protected: true, notes: "keep this" })).status).toBe(200);
    expect(pve.dc.backups[0]).toMatchObject({ protected: 1, notes: "keep this" });
    expect((await send(sam, "PUT", "/api/node/backup/archives", { storage: "pbs", volid })).status).toBe(400);
    expect((await send(sam, "PUT", "/api/node/backup/archives", { storage: "pbs", volid: "pbs:iso/x.iso", protected: true })).status).toBe(400);
    expect((await send(sam, "PUT", "/api/node/backup/archives", { storage: "local", volid, protected: true })).status).toBe(400);
  });

  it("shows the guest configuration stored in a backup", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", `/api/node/backup/archives/config?storage=pbs&volid=${encodeURIComponent("pbs:backup/vm/100/2026-01-02T01:00:00Z")}`);
    expect(r.json.config).toMatch(/cores: 2/);
  });

  it("deletes a backup only after typing its name, and Proxmox refuses protected ones", async () => {
    const sam = await signIn("sam");
    const volid = "local:backup/vzdump-lxc-101-2026_01_01-02_00_00.tar.zst";
    expect((await send(sam, "DELETE", "/api/node/backup/archives", { storage: "local", volid })).status).toBe(400);
    const r = await send(sam, "DELETE", "/api/node/backup/archives", { storage: "local", volid, confirm: "vzdump-lxc-101-2026_01_01-02_00_00.tar.zst" });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).toMatch(/protected|Proxmox/);
  });

  it("previews a prune before it removes anything, and types the storage name for the real thing", async () => {
    const sam = await signIn("sam");
    const dry = await send(sam, "POST", "/api/node/backup/prune", { storage: "pbs", retention: { "keep-last": 1 }, vmid: 100 });
    expect(dry.status).toBe(200);
    expect(dry.json.plan[0]).toMatchObject({ mark: "remove", vmid: 100 });
    expect(callsTo("DELETE", "/nodes/pve/storage/pbs/prunebackups")).toHaveLength(0);
    expect((await send(sam, "POST", "/api/node/backup/prune", { storage: "pbs", dryRun: false })).status).toBe(400);
    const real = await send(sam, "POST", "/api/node/backup/prune", { storage: "pbs", dryRun: false, confirm: "pbs", retention: { "keep-last": 1 } });
    expect(real.status).toBe(202);
    expect(real.json.task).toMatch(/^UPID:/);
    expect((await send(sam, "POST", "/api/node/backup/prune", { storage: "pbs", retention: { "keep-banana": 1 } })).status).toBe(400);
  });
});

describe("restore options", () => {
  const pbs = "pbs:backup/vm/100/2026-01-02T01:00:00Z";
  it("restores to a new machine with a unique MAC, a target storage, a bandwidth limit and start after", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "POST", "/api/node/backup/restore", { storage: "pbs", volid: pbs, target: "local-lvm", start: true, bwlimit: 80000, pool: "prod" });
    expect(r.status).toBe(202);
    const body = new URLSearchParams(pve.dc.restores[0].body);
    expect(pve.dc.restores[0].path).toBe("/nodes/pve/qemu");
    expect(body.get("archive")).toBe(pbs);
    expect(body.get("storage")).toBe("local-lvm");
    expect(body.get("unique")).toBe("1");
    expect(body.get("start")).toBe("1");
    expect(body.get("bwlimit")).toBe("80000");
    expect(body.get("pool")).toBe("prod");
    expect(Number(body.get("vmid"))).toBe(r.json.vmid);
  });

  it("restores a container backup through the container endpoint", async () => {
    const sam = await signIn("sam");
    await send(sam, "POST", "/api/node/backup/restore", { storage: "local", volid: "local:backup/vzdump-lxc-101-2026_01_01-02_00_00.tar.zst", unique: false });
    expect(pve.dc.restores[0].path).toBe("/nodes/pve/lxc");
    const body = new URLSearchParams(pve.dc.restores[0].body);
    expect(body.get("restore")).toBe("1");
    expect(body.get("unique")).toBe("0");
  });

  it("restores over the original only under its own number, and live restore is for VMs", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/backup/restore", { storage: "pbs", volid: pbs, replace: true, vmid: 555 })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/backup/restore", { storage: "local", volid: "local:backup/vzdump-lxc-101-2026_01_01-02_00_00.tar.zst", liveRestore: true })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/backup/restore", { storage: "pbs", volid: pbs, liveRestore: true })).status).toBe(202);
    expect(new URLSearchParams(pve.dc.restores[0].body).get("live-restore")).toBe("1");
  });

  it("refuses things that aren't machine backups and unknown options", async () => {
    const sam = await signIn("sam");
    for (const body of [{ storage: "pbs", volid: "pbs:iso/a.iso" }, { storage: "pbs", volid: "pbs:backup/../../etc/passwd" }, { storage: "pbs", volid: pbs, bwlimit: -1 }, { storage: "pbs", volid: pbs, pool: "a b" }, { storage: "pbs", volid: pbs, evil: 1 }, { storage: "pbs", volid: pbs, vmid: 5 }]) {
      expect((await send(sam, "POST", "/api/node/backup/restore", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(pve.dc.restores).toHaveLength(0);
  });
});

describe("backup file browser", () => {
  it("lists a directory inside a backup, folders first, with decoded paths", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", `/api/node/backup/files?storage=pbs&volid=${encodeURIComponent("pbs:backup/vm/100/2026-01-02T01:00:00Z")}&path=/`);
    expect(r.json.entries.map((e: any) => [e.name, e.type, e.path])).toEqual([["etc", "directory", "/etc"], ["hosts", "file", "/hosts"]]);
    expect((await send(sam, "GET", `/api/node/backup/files?storage=pbs&volid=${encodeURIComponent("pbs:backup/vm/100/2026-01-02T01:00:00Z")}&path=relative`)).status).toBe(400);
  });
});

describe("SDN", () => {
  it("reads zones, VNets with subnets, plugins and how many changes are staged", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/sdn");
    expect(r.json.zones[0]).toMatchObject({ id: "lab", type: "vlan", state: "new", values: { bridge: "vmbr0" } });
    expect(r.json.vnets[0]).toMatchObject({ vnet: "web", zone: "lab", tag: 100 });
    expect(r.json.vnets[0].subnets[0]).toMatchObject({ cidr: "10.0.0.0/24", gateway: "10.0.0.1", snat: true, dhcpRange: ["start-address=10.0.0.10,end-address=10.0.0.50"] });
    expect(r.json.pending).toBe(1);
    expect(Object.keys(r.json.types.zones)).toEqual(["simple", "vlan", "qinq", "vxlan", "evpn"]);
    expect(r.json.types.zones.vlan.required).toEqual(["bridge"]);
  });

  it("never returns IPAM tokens", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/sdn");
    expect(JSON.stringify(r.json)).not.toContain("NETBOXSECRETTOKEN");
    expect(r.json.ipams.find((i: any) => i.id === "nb")).toMatchObject({ type: "netbox", values: { url: "https://nb.lan" }, secretsSet: ["token"] });
  });

  it("creates each zone type with its own required settings", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/sdn/zones", { id: "s1", type: "simple", values: { dhcp: "dnsmasq" } })).status).toBe(201);
    expect((await send(sam, "POST", "/api/node/sdn/zones", { id: "v1", type: "vlan", values: { bridge: "vmbr0", mtu: 1500 } })).status).toBe(201);
    expect((await send(sam, "POST", "/api/node/sdn/zones", { id: "q1", type: "qinq", values: { bridge: "vmbr0", tag: 200, "vlan-protocol": "802.1ad" } })).status).toBe(201);
    expect((await send(sam, "POST", "/api/node/sdn/zones", { id: "x1", type: "vxlan", values: { peers: "10.0.0.2,10.0.0.3", "vxlan-port": 4789 } })).status).toBe(201);
    expect((await send(sam, "POST", "/api/node/sdn/zones", { id: "e1", type: "evpn", values: { controller: "ctl", "vrf-vxlan": 4000, exitnodes: "pve" } })).status).toBe(201);
    expect(callsTo("POST", "/cluster/sdn/zones").map((c) => new URLSearchParams(c.body).get("type"))).toEqual(["simple", "vlan", "qinq", "vxlan", "evpn"]);
  });

  it("refuses zones missing what their type needs, with odd names or settings of another type", async () => {
    const sam = await signIn("sam");
    const cases: [string, string, Record<string, unknown>][] = [
      ["v2", "vlan", {}],
      ["q2", "qinq", { bridge: "vmbr0" }],
      ["x2", "vxlan", {}],
      ["e2", "evpn", { controller: "ctl" }],
      ["Bad", "simple", {}],
      ["toolongname", "simple", {}],
      ["s2", "simple", { bridge: "vmbr0" }],
      ["s3", "banana", {}],
      ["x3", "vxlan", { peers: "not-an-ip" }],
      ["e3", "evpn", { controller: "ctl", "vrf-vxlan": 0 }],
    ];
    for (const [id, type, values] of cases) expect((await send(sam, "POST", "/api/node/sdn/zones", { id, type, values })).status, `${id} ${type}`).toBe(400);
    expect(callsTo("POST", "/cluster/sdn/zones")).toHaveLength(0);
  });

  it("edits a zone by its own type, and deletes after the name is typed", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "PUT", "/api/node/sdn/zones/lab", { values: { mtu: 1450 } })).status).toBe(200);
    expect(new URLSearchParams(callsTo("PUT", "/cluster/sdn/zones/lab")[0].body).get("mtu")).toBe("1450");
    expect((await send(sam, "PUT", "/api/node/sdn/zones/lab", { values: { peers: "10.0.0.2" } })).status).toBe(400);
    expect((await send(sam, "DELETE", "/api/node/sdn/zones/lab", {})).status).toBe(400);
    expect((await send(sam, "DELETE", "/api/node/sdn/zones/lab", { confirm: "lab" })).status).toBe(200);
    expect(pve.dc.zones.has("lab")).toBe(false);
  });

  it("creates VNets and subnets with DHCP ranges", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/sdn/vnets", { id: "app", values: { zone: "lab", tag: 200, alias: "App net", vlanaware: true, "isolate-ports": true } })).status).toBe(201);
    const body = new URLSearchParams(callsTo("POST", "/cluster/sdn/vnets")[0].body);
    expect([body.get("vnet"), body.get("zone"), body.get("tag"), body.get("vlanaware")]).toEqual(["app", "lab", "200", "1"]);
    expect((await send(sam, "POST", "/api/node/sdn/vnets", { id: "BAD", values: { zone: "lab" } })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/sdn/vnets", { id: "ok", values: { tag: 5 } })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/sdn/vnets", { id: "ok", values: { zone: "lab", tag: 99999999 } })).status).toBe(400);
    const sub = await send(sam, "POST", "/api/node/sdn/vnets/web/subnets", { cidr: "10.5.0.0/24", values: { gateway: "10.5.0.1", snat: true, "dhcp-range": ["start-address=10.5.0.10,end-address=10.5.0.20"], "dhcp-dns-server": "10.5.0.1" } });
    expect(sub.status, JSON.stringify(sub.json)).toBe(201);
    const sb = new URLSearchParams(callsTo("POST", "/cluster/sdn/vnets/web/subnets")[0].body);
    expect([sb.get("subnet"), sb.get("type"), sb.get("snat"), sb.getAll("dhcp-range").length]).toEqual(["10.5.0.0/24", "subnet", "1", 1]);
    for (const body of [{ cidr: "nonsense" }, { cidr: "10.0.0.0/33" }, { cidr: "10.5.0.0/24", values: { gateway: "x" } }]) expect((await send(sam, "POST", "/api/node/sdn/vnets/web/subnets", body)).status).toBe(400);
  });

  it("deletes VNets and subnets only after typing their names", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "DELETE", "/api/node/sdn/vnets/web/subnets/lab-10.0.0.0-24", {})).status).toBe(400);
    expect((await send(sam, "DELETE", "/api/node/sdn/vnets/web/subnets/lab-10.0.0.0-24", { confirm: "lab-10.0.0.0-24" })).status).toBe(200);
    expect((await send(sam, "DELETE", "/api/node/sdn/vnets/web", {})).status).toBe(400);
    expect((await send(sam, "DELETE", "/api/node/sdn/vnets/web", { confirm: "web" })).status).toBe(200);
    expect(pve.dc.vnets.has("web")).toBe(false);
  });

  it("previews, applies and rolls back (rollback needs the word typed)", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "GET", "/api/node/sdn/preview")).json.preview).toMatch(/\+ vnet web/);
    const a = await send(sam, "POST", "/api/node/sdn/apply", {});
    expect(a.status).toBe(202);
    expect(a.json.task).toMatch(/^UPID:/);
    expect((await send(sam, "POST", "/api/node/sdn/rollback", {})).status).toBe(400);
    expect(pve.dc.sdnRolledBack).toBe(0);
    expect((await send(sam, "POST", "/api/node/sdn/rollback", { confirm: "rollback" })).status).toBe(200);
    expect(pve.dc.sdnRolledBack).toBe(1);
  });

  it("manages IPAM and DNS plugins and controllers, keeping secrets write-only", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/sdn/ipams", { id: "phpi", type: "phpipam", values: { url: "https://ipam.lan", token: "PHPTOKEN123", section: 2 } })).status).toBe(201);
    expect((await send(sam, "POST", "/api/node/sdn/ipams", { id: "phpi2", type: "phpipam", values: { url: "https://ipam.lan" } })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/sdn/dns", { id: "pdns", type: "powerdns", values: { url: "https://dns.lan:8081", key: "DNSKEYSECRET1", ttl: 3600 } })).status).toBe(201);
    expect((await send(sam, "POST", "/api/node/sdn/controllers", { id: "ctl", type: "evpn", values: { asn: 65000, peers: "10.0.0.2,10.0.0.3" } })).status).toBe(201);
    const all = await send(sam, "GET", "/api/node/sdn");
    expect(all.json.dns[0]).toMatchObject({ id: "pdns", secretsSet: ["key"] });
    expect(JSON.stringify(all.json)).not.toMatch(/PHPTOKEN123|DNSKEYSECRET1/);
    expect((await send(sam, "DELETE", "/api/node/sdn/ipams/phpi", { confirm: "phpi" })).status).toBe(200);
  });

  it("scrubs secrets out of errors Proxmox sends back", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "POST", "/api/node/sdn/ipams", { id: "nb2", type: "netbox", values: { url: "https://nb.lan", token: "SECRETVALUE9" } });
    expect(r.status).toBe(201);
    expect(seen.join("")).not.toContain("SECRETVALUE9");
  });

  it("shows IPAM status, edits VNet IP assignments and firewall options", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "GET", "/api/node/sdn/ipams/pve/status")).json.entries[0]).toMatchObject({ ip: "10.0.0.5", vnet: "web", vmid: 101 });
    expect((await send(sam, "POST", "/api/node/sdn/vnets/web/ips", { zone: "lab", ip: "10.0.0.9", mac: "BC:24:11:00:00:09" })).status).toBe(200);
    expect((await send(sam, "POST", "/api/node/sdn/vnets/web/ips", { zone: "lab", ip: "10.0.0.9", action: "delete" })).status).toBe(200);
    for (const body of [{ zone: "lab", ip: "999" }, { zone: "lab", ip: "10.0.0.9" }, { zone: "lab", ip: "10.0.0.9", mac: "zz" }]) expect((await send(sam, "POST", "/api/node/sdn/vnets/web/ips", body)).status).toBe(400);
    const fw = await send(sam, "GET", "/api/node/sdn/vnets/web/firewall");
    expect(fw.json.rules[0]).toMatchObject({ type: "forward", action: "DROP", comment: "no lateral" });
    expect((await send(sam, "PUT", "/api/node/sdn/vnets/web/firewall", { values: { enable: true, policy_forward: "DROP" }, digest: dg("f1") })).status).toBe(200);
    expect(pve.dc.fwOptions.policy_forward).toBe("DROP");
    expect((await send(sam, "PUT", "/api/node/sdn/vnets/web/firewall", { values: { policy_forward: "MAYBE" } })).status).toBe(400);
  });

  it("shows what a node is running", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/sdn/status");
    expect(r.json.zones[0]).toMatchObject({ zone: "lab", status: "available", vnets: [{ vnet: "web", status: "pending" }] });
    expect((await send(sam, "GET", "/api/node/sdn/vnets/web/mac-vrf")).json.entries[0].mac).toBe("BC:24:11:00:00:01");
  });

  it("answers an account without SDN permission with a clear 403", async () => {
    const lee = await signIn("lee");
    expect((await send(lee, "POST", "/api/node/sdn/apply", {})).status).toBe(403);
  });
});

describe("resource mappings", () => {
  it("lists PCI mappings with Proxmox's own problem checks", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/mappings");
    expect(r.json.pci[0]).toMatchObject({ id: "gpu0", map: [{ node: "pve", path: "0000:01:00", id: "10de:2204", iommugroup: 14 }], checks: [{ severity: "warning" }] });
  });

  it("creates PCI, USB and directory mappings from structured rows", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/mappings/pci", { id: "gpu1", description: "Second GPU", mdev: true, map: [{ node: "pve", path: "0000:02:00", id: "10de:2204", subsystemId: "10de:1453" }] })).status).toBe(201);
    expect(new URLSearchParams(callsTo("POST", "/cluster/mapping/pci")[0].body).get("map")!.split(",").sort()).toEqual(["id=10de:2204", "node=pve", "path=0000:02:00", "subsystem-id=10de:1453"]);
    expect((await send(sam, "POST", "/api/node/mappings/usb", { id: "key", map: [{ node: "pve", path: "1-1", id: "0781:5583" }] })).status).toBe(201);
    expect((await send(sam, "POST", "/api/node/mappings/dir", { id: "share", map: [{ node: "pve", path: "/srv/share" }] })).status).toBe(201);
    expect(new URLSearchParams(callsTo("POST", "/cluster/mapping/dir")[0].body).get("map")!.split(",").sort()).toEqual(["node=pve", "path=/srv/share"]);
  });

  it("refuses incomplete, duplicated or odd mappings", async () => {
    const sam = await signIn("sam");
    const bads: [string, Record<string, unknown>][] = [
      ["pci", { id: "aa", map: [] }],
      ["pci", { id: "aa" }],
      ["pci", { id: "a b", map: [{ node: "pve", path: "0000:02:00", id: "10de:2204" }] }],
      ["pci", { id: "aa", map: [{ node: "pve", path: "../etc", id: "10de:2204" }] }],
      ["pci", { id: "aa", map: [{ node: "pve", path: "0000:02:00" }] }],
      ["pci", { id: "aa", map: [{ node: "ghost", path: "0000:02:00", id: "10de:2204" }] }],
      ["pci", { id: "aa", map: [{ node: "pve", path: "0000:02:00", id: "10de:2204" }, { node: "pve", path: "0000:03:00", id: "10de:2204" }] }],
      ["pci", { id: "aa", evil: 1, map: [{ node: "pve", path: "0000:02:00", id: "10de:2204" }] }],
      ["usb", { id: "aa", map: [{ node: "pve", path: "1-1", id: "x,y=1" }] }],
    ];
    for (const [kind, body] of bads) expect((await send(sam, "POST", `/api/node/mappings/${kind}`, body)).status, JSON.stringify(body)).toBe(kind === "pci" && JSON.stringify(body).includes("ghost") ? 404 : 400);
    expect((await send(sam, "POST", "/api/node/mappings/gpu", { id: "aa", map: [] })).status).toBe(404);
  });

  it("edits with the digest and deletes only after the name is typed", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "PUT", "/api/node/mappings/pci/gpu0", { description: "Main GPU", map: [{ node: "pve", path: "0000:01:00", id: "10de:2204" }], digest: dg("m1") })).status).toBe(200);
    expect(pve.dc.mappings.pci.get("gpu0")?.description).toBe("Main GPU");
    expect((await send(sam, "DELETE", "/api/node/mappings/pci/gpu0", {})).status).toBe(400);
    expect((await send(sam, "DELETE", "/api/node/mappings/pci/gpu0", { confirm: "gpu0" })).status).toBe(200);
    expect(pve.dc.mappings.pci.has("gpu0")).toBe(false);
  });

  it("is refused for an account without Mapping.Modify", async () => {
    const lee = await signIn("lee");
    { const r = await send(lee, "POST", "/api/node/mappings/usb", { id: "kk", map: [{ node: "pve", path: "1-1", id: "0781:5583" }] }); expect(r.status, JSON.stringify(r.json)).toBe(403); }
  });
});
