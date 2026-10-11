import { describe, expect, it } from "vitest";
import { liveGuests, liveHostMetrics, liveStorage, normalizeRrd } from "../src/data/live.ts";
import { demoHost, newOrg } from "../src/data/demo.ts";

const host = {
  node: "pve",
  version: "9.0.3",
  status: { cpu: 0.25, cpuinfo: { cpus: 8, model: "Xeon" }, memory: { total: 32, used: 8, free: 24 }, rootfs: { total: 100, used: 40 }, uptime: 3600 },
  resources: [
    { type: "lxc", vmid: 105, name: "web", status: "running", cpu: 0.5, maxcpu: 2, mem: 1, maxmem: 4, maxdisk: 8, pool: "co-northwind", tags: "web;prod" },
    { type: "qemu", vmid: 101, status: "stopped", maxcpu: 4, maxmem: 8 },
    { type: "qemu", vmid: 9000, template: 1, name: "tpl" },
  ],
  storage: [
    { storage: "local", plugintype: "dir", content: "iso,vztmpl,backup", status: "available", used: 40, total: 100, shared: false },
    { storage: "drive2", plugintype: "dir", content: "images,rootdir", status: "available", used: 5, total: 2000, shared: false },
  ],
};

describe("live data mapping", () => {
  it("fills host metrics from the node status", () => {
    const m = liveHostMetrics(host, demoHost("x"));
    expect(m).toMatchObject({ hostname: "pve", version: "9.0.3", cpus: 8, cpuModel: "Xeon", cpuPct: 25, memUsed: 8, memTotal: 32, diskUsed: 40, uptimeSec: 3600 });
  });

  it("shows zeros, not demo numbers, when the user can't read the node", () => {
    const m = liveHostMetrics({ ...host, status: null }, demoHost("x"));
    expect(m.memTotal).toBe(0);
    expect(m.cpuPct).toBe(0);
  });

  it("maps guests, keeps templates flagged, and assigns organizations by pool", () => {
    const g = liveGuests(host, [newOrg("Northwind")], []);
    expect(g.map((x) => x.vmid)).toEqual([101, 105, 9000]);
    expect(g.find((x) => x.vmid === 9000)?.template).toBe(true);
    expect(g.find((x) => x.vmid === 105)?.template).toBe(false);
    g.splice(2, 1);
    expect(g[1]).toMatchObject({ name: "web", type: "lxc", status: "running", cpuPct: 50, cores: 2, org: "northwind", tags: ["web", "prod"] });
    expect(g[0]).toMatchObject({ name: "VM 101", org: null, status: "stopped" });
  });

  it("keeps the console's task log across refreshes", () => {
    const first = liveGuests(host, [], []);
    first[0].tasks = [{ id: "t", what: "Start", at: "now", ok: true }];
    expect(liveGuests(host, [], first)[0].tasks).toHaveLength(1);
  });

  it("lists every storage with readable content", () => {
    expect(liveStorage(host)).toEqual([
      { id: "drive2", type: "dir", used: 5, total: 2000, content: ["Containers", "Disk images"], active: true, shared: false },
      { id: "local", type: "dir", used: 40, total: 100, content: ["Backups", "ISO images", "Templates"], active: true, shared: false },
    ]);
  });

  it("reads the node's memory series like a guest's", () => {
    expect(normalizeRrd([{ time: 1, memused: 2, memtotal: 4 }])[0]).toMatchObject({ mem: 2, maxmem: 4 });
  });
});
