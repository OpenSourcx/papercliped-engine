import { describe, expect, it } from "vitest";
import { demoBackend } from "../src/data/backend.ts";
import { demoData } from "../src/data/demo.ts";

const data = demoData(null);
const b = () => demoBackend(() => data.host.storage, () => data.guests);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ct = data.guests.find((g) => g.type === "lxc")!;
const vm = data.guests.find((g) => g.type === "qemu")!;

describe("demo network", () => {
  it("stages changes as a diff until applied, and reverts", async () => {
    const be = b();
    expect((await be.network()).changes).toBeNull();
    await be.saveIface(null, { type: "bridge", iface: "vmbr1", cidr: "10.10.0.1/24", gateway: null, autostart: true, comments: "Org network", ports: [], vlanAware: true, slaves: [], bondMode: null, vlanRaw: null, vlanId: null });
    const staged = await be.network();
    expect(staged.interfaces.map((i) => i.iface)).toContain("vmbr1");
    expect(staged.changes).toContain("+auto vmbr1");
    expect(staged.changes).toContain("+\taddress 10.10.0.1/24");
    await be.revertNetwork();
    expect((await be.network()).interfaces.map((i) => i.iface)).not.toContain("vmbr1");
    await be.saveIface(null, { type: "bridge", iface: "vmbr1", cidr: null, gateway: null, autostart: true, comments: null, ports: [], vlanAware: false, slaves: [], bondMode: null, vlanRaw: null, vlanId: null });
    const { task } = await be.applyNetwork();
    await wait(1700);
    expect((await be.task(task)).exitstatus).toBe("OK");
    const after = await be.network();
    expect(after.changes).toBeNull();
    expect(after.interfaces.find((i) => i.iface === "vmbr1")?.active).toBe(true);
  });

  it("needs the name typed to delete the gateway interface", async () => {
    const be = b();
    await expect(be.deleteIface("vmbr0")).rejects.toThrow(/gateway/);
    await be.deleteIface("vmbr0", "vmbr0");
    expect((await be.network()).changes).toContain("-auto vmbr0");
  });
});

describe("demo hardware, snapshots and clones", () => {
  it("edits CPU, memory, disks and NICs; VMs that run wait for a restart", async () => {
    const be = b();
    const h = await be.hardware(ct.vmid);
    expect(h.disks[0].key).toBe("rootfs");
    await be.setHardware(ct.vmid, { cores: h.cores + 1 });
    expect((await be.hardware(ct.vmid)).cores).toBe(h.cores + 1);
    await be.resizeDisk(ct.vmid, "rootfs", 10);
    expect((await be.hardware(ct.vmid)).disks[0].sizeGb).toBe((h.disks[0].sizeGb ?? 0) + 10);
    const mac = h.nics[0].mac;
    await be.saveNic(ct.vmid, { key: "net0", bridge: "vmbr0", firewall: false, ip: "10.0.0.9/24", gw: "10.0.0.1" });
    const n = (await be.hardware(ct.vmid)).nics[0];
    expect(n).toMatchObject({ mac, ip: "10.0.0.9/24", firewall: false });
    await expect(be.saveNic(ct.vmid, { key: null, bridge: "vmbr9", firewall: true })).rejects.toThrow(/does not exist/);
    await be.saveNic(ct.vmid, { key: null, bridge: "vmbr0", firewall: true });
    expect((await be.hardware(ct.vmid)).nics.map((x) => x.key)).toEqual(["net0", "net1"]);
    await be.deleteNic(ct.vmid, "net1");
    if (vm.status === "running") {
      await be.setHardware(vm.vmid, { memoryMb: 16384 });
      expect((await be.hardware(vm.vmid)).pending).toContain("memory");
    }
  });

  it("takes, lists and deletes snapshots through tasks", async () => {
    const be = b();
    const before = (await be.snapshots(ct.vmid)).snapshots.length;
    const { task } = await be.takeSnapshot(ct.vmid, "pre-test", "x", false);
    await wait(1300);
    expect((await be.task(task)).exitstatus).toBe("OK");
    const after = await be.snapshots(ct.vmid);
    expect(after.snapshots.length).toBe(before + 1);
    expect(after.current).toBe("pre-test");
    await expect(be.takeSnapshot(ct.vmid, "pre-test", "", false)).rejects.toThrow(/already/);
    await be.deleteSnapshot(ct.vmid, "pre-test");
    await wait(1100);
    expect((await be.snapshots(ct.vmid)).snapshots.length).toBe(before);
  }, 6000);

  it("clones to the next free id", async () => {
    const r = await b().clone(ct.vmid, "copy", null, false);
    expect(r.vmid).toBe(Math.max(...data.guests.map((g) => g.vmid)) + 1);
    expect(r.full).toBe(true);
  });
});

describe("demo machine actions, options and history", () => {
  const stopped = data.guests.find((g) => g.status === "stopped" && !g.protected)!;

  it("deletes only a stopped, unprotected machine whose name was typed", async () => {
    const be = b();
    await expect(be.destroyMachine(stopped.vmid, "nope")).rejects.toMatchObject({ code: "confirm" });
    const running = data.guests.find((g) => g.status === "running")!;
    await expect(be.destroyMachine(running.vmid, running.name)).rejects.toMatchObject({ code: "running" });
    await be.setHardware(stopped.vmid, { protection: true });
    await expect(be.destroyMachine(stopped.vmid, stopped.name)).rejects.toMatchObject({ code: "protected" });
    await be.setHardware(stopped.vmid, { protection: false });
    const r = await be.destroyMachine(stopped.vmid, stopped.name);
    expect(r.task).toMatch(/^UPID:demo:/);
  });

  it("converts to a template with the same guards", async () => {
    const be = b();
    await expect(be.convertToTemplate(stopped.vmid, "wrong")).rejects.toMatchObject({ code: "confirm" });
    expect((await be.convertToTemplate(stopped.vmid, stopped.name)).task).toBeTruthy();
  });

  it("stores startup, boot order, agent and OS type", async () => {
    const be = b();
    await be.setHardware(vm.vmid, { startup: { order: 1, up: 30, down: null }, boot: ["net0", "scsi0"], agent: false, ostype: "win11" });
    const h = await be.hardware(vm.vmid);
    expect(h).toMatchObject({ startup: { order: 1, up: 30, down: null }, boot: ["net0", "scsi0"], agent: false, ostype: "win11" });
  });

  it("filters task history to one machine", async () => {
    const be = b();
    await be.takeSnapshot(ct.vmid, "hist-a", "", false);
    await be.takeSnapshot(vm.vmid, "hist-b", "", false);
    expect((await be.tasks(50, ct.vmid)).every((t) => t.id === String(ct.vmid))).toBe(true);
    expect((await be.tasks(50, ct.vmid)).length).toBe(1);
    expect((await be.tasks(50)).length).toBe(2);
  });
});
