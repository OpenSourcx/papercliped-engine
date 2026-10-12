import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { vmDiskChanges, mpChanges, bindPath, driveString, freeKey, readDrive, newVmDisk } from "../src/features/disksCheck.ts";
import { fakePve } from "./fakes.ts";
import { fakeDisks } from "./fakes-disks.ts";

let server: Server;
let base: string;
let pve: ReturnType<typeof fakeDisks>;

beforeEach(async () => {
  pve = fakeDisks(fakePve().transport);
  server = createServer(createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(), staticDir: null, secureCookies: false }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-EPC-Request": "1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const j = (r: Response): Promise<any> => r.json();
async function signIn(username = "sam") {
  const r = await send("POST", "/api/login", { username, password: "right", realm: "pve" });
  return r.headers.get("set-cookie")!.split(";")[0];
}
const view = async (c: string, vmid: number) => j(await fetch(`${base}/api/guests/${vmid}/disks`, { headers: { Cookie: c } }));
const post = (c: string, path: string, body: unknown) => send("POST", path, body, { Cookie: c });
const lastPut = (vmid: number) => [...pve.calls].reverse().find((x) => x.method === "PUT" && x.path.endsWith(`/${vmid}/config`))!;

describe("reading a machine's disks", () => {
  it("shows a VM's disks with options, its CD drive and detached disks, plus the digest", async () => {
    const c = await signIn();
    const v = await view(c, 200);
    expect(v.digest).toMatch(/^[0-9a-f]{40}$/);
    expect(v.disks.find((d: any) => d.key === "scsi0")).toMatchObject({ kind: "disk", bus: "scsi", storage: "local-lvm", iothread: true, sizeGb: 32, backup: true });
    expect(v.disks.find((d: any) => d.key === "ide2")).toMatchObject({ kind: "cdrom", volume: "local:iso/debian.iso" });
    expect(v.unused).toEqual([{ key: "unused0", volume: "local-lvm:vm-200-disk-9", name: "vm-200-disk-9", storage: "local-lvm" }]);
  });

  it("shows a container's root and mount points, and whether the person administers the host", async () => {
    const c = await signIn();
    const v = await view(c, 201);
    expect(v.disks.map((d: any) => [d.key, d.kind, d.mp])).toEqual([["rootfs", "rootfs", "/"], ["mp0", "mount", "/data"]]);
    expect(v.isAdmin).toBe(true);
    expect((await view(await signIn("lee"), 201)).isAdmin).toBe(false);
  });

  it("marks staged changes on a running VM", async () => {
    const c = await signIn();
    pve.guests.get(200)!.status = "running";
    pve.guests.get(200)!.pending.scsi1 = "local-lvm:16";
    const v = await view(c, 200);
    expect(v.pendingKeys).toEqual(["scsi1"]);
    expect(v.disks.find((d: any) => d.key === "scsi1").staged).toBe(true);
  });
});

describe("changing a machine's disks", () => {
  it("adds a VM disk with its options on the next free slot, passing the digest", async () => {
    const c = await signIn();
    const dg = (await view(c, 200)).digest;
    const r = await post(c, "/api/guests/200/disks/add", { digest: dg, bus: "scsi", storage: "local-lvm", sizeGb: 16, format: "qcow2", cache: "writeback", discard: true, ssd: true, iothread: true, backup: false, mbps_rd: 100, aio: "io_uring" });
    expect(await j(r)).toEqual({ key: "scsi1" });
    const put = lastPut(200);
    expect(put.params.digest).toBe(dg);
    expect(put.params.scsi1).toBe("local-lvm:16,cache=writeback,aio=io_uring,discard=on,ssd=1,iothread=1,backup=0,mbps_rd=100,format=qcow2");
  });

  it("refuses a stale page and bad input before Proxmox is asked", async () => {
    const c = await signIn();
    const stale = await post(c, "/api/guests/200/disks/add", { digest: "a".repeat(40), bus: "scsi", storage: "local-lvm", sizeGb: 4 });
    expect(stale.status).toBe(409);
    expect((await post(c, "/api/guests/200/disks/add", { bus: "scsi", storage: "local-lvm", sizeGb: 4 })).status).toBe(400);
    const dg = (await view(c, 200)).digest;
    for (const body of [{ bus: "floppy" }, { sizeGb: 0 }, { sizeGb: 1.5 }, { storage: "a b" }, { cache: "turbo" }, { format: "iso" }, { bus: "virtio", ssd: true }, { bus: "sata", iothread: true }, { mbps_rd: -5 }]) {
      const r = await post(c, "/api/guests/200/disks/add", { digest: dg, bus: "scsi", storage: "local-lvm", sizeGb: 4, ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(pve.calls.some((x) => x.method === "PUT" && x.path.endsWith("/200/config"))).toBe(false);
  });

  it("edits options while keeping everything else on the drive", async () => {
    const c = await signIn();
    const dg = (await view(c, 200)).digest;
    await post(c, "/api/guests/200/disks/scsi0/edit", { digest: dg, discard: true, cache: "none", iothread: false });
    expect(lastPut(200).params.scsi0).toBe("local-lvm:vm-200-disk-0,size=32G,cache=none,discard=on");
  });

  it("detaches into an unused disk, then reattaches it as a new disk; a stale unused entry is reported, never deleted", async () => {
    const c = await signIn();
    let dg = (await view(c, 200)).digest;
    expect((await post(c, "/api/guests/200/disks/scsi0/detach", { digest: dg })).status).toBe(200);
    expect(lastPut(200).params.delete).toBe("scsi0");
    let v = await view(c, 200);
    expect(v.unused.map((u: any) => u.key)).toContain("unused1");
    dg = v.digest;
    const r = await j(await post(c, "/api/guests/200/disks/unused0/reattach", { digest: dg, bus: "virtio", cache: "none" }));
    expect(r).toEqual({ key: "virtio0", staleUnused: false });
    expect(lastPut(200).params.delete).toBeUndefined(); // never combine attach with a delete: that would destroy the volume
    v = await view(c, 200);
    expect(v.unused.some((u: any) => u.key === "unused0")).toBe(false);
  });

  it("will not detach the root disk or destroy an attached disk", async () => {
    const c = await signIn();
    const dg = (await view(c, 201)).digest;
    expect((await post(c, "/api/guests/201/disks/rootfs/detach", { digest: dg })).status).toBe(400);
    const d2 = (await view(c, 200)).digest;
    expect((await post(c, "/api/guests/200/disks/scsi0/destroy", { digest: d2, confirm: "vm-200-disk-0" })).status).toBe(400);
  });

  it("destroys a detached disk only after its name is typed", async () => {
    const c = await signIn();
    const dg = (await view(c, 200)).digest;
    const no = await post(c, "/api/guests/200/disks/unused0/destroy", { digest: dg, confirm: "unused0" });
    expect(no.status).toBe(409);
    expect(pve.calls.some((x) => x.path.endsWith("/unlink"))).toBe(false);
    expect((await post(c, "/api/guests/200/disks/unused0/destroy", { digest: dg, confirm: "vm-200-disk-9" })).status).toBe(200);
    const unlink = pve.calls.find((x) => x.path.endsWith("/unlink"))!;
    expect(unlink.params).toMatchObject({ idlist: "unused0", force: "1" });
    expect(pve.guests.get(200)!.cfg.unused0).toBeUndefined();
  });

  it("moves a disk to another storage as a task, keeping or deleting the source", async () => {
    const c = await signIn();
    const dg = (await view(c, 200)).digest;
    const r = await j(await post(c, "/api/guests/200/disks/scsi0/move", { digest: dg, storage: "fast", format: "raw", deleteSource: true, bwlimit: 50000 }));
    expect(r.task).toMatch(/^UPID:/);
    expect(pve.calls.find((x) => x.path.endsWith("/move_disk"))!.params).toMatchObject({ disk: "scsi0", storage: "fast", format: "raw", delete: "1", bwlimit: "50000", digest: dg });
    expect(pve.guests.get(200)!.cfg.unused5).toBeUndefined();
    const dg2 = (await view(c, 200)).digest;
    await post(c, "/api/guests/200/disks/scsi0/move", { digest: dg2, storage: "slow" });
    expect(pve.guests.get(200)!.cfg.unused5).toBeDefined(); // the source stays as an unused disk by default
    expect((await post(c, "/api/guests/200/disks/scsi0/move", { digest: (await view(c, 200)).digest, storage: "bad storage" })).status).toBe(400);
  });

  it("moves a container volume with move_volume", async () => {
    const c = await signIn();
    const dg = (await view(c, 201)).digest;
    await post(c, "/api/guests/201/disks/mp0/move", { digest: dg, storage: "fast", deleteSource: false });
    expect(pve.calls.find((x) => x.path.endsWith("/201/move_volume"))!.params).toMatchObject({ volume: "mp0", storage: "fast", delete: "0" });
  });

  it("reassigns a disk to another machine of the same kind (move with a target)", async () => {
    const c = await signIn();
    const dg = (await view(c, 200)).digest;
    expect((await post(c, "/api/guests/200/disks/scsi0/reassign", { digest: dg, targetVmid: 201 })).status).toBe(400); // a container can't take a VM disk
    expect((await post(c, "/api/guests/200/disks/scsi0/reassign", { digest: dg, targetVmid: 200 })).status).toBe(400);
    const r = await post(c, "/api/guests/200/disks/scsi0/reassign", { digest: dg, targetVmid: 202, targetKey: "scsi3" });
    expect(r.status).toBe(200);
    const call = pve.calls.find((x) => x.path.endsWith("/200/move_disk"))!;
    expect(call.params).toMatchObject({ disk: "scsi0", "target-vmid": "202", "target-disk": "scsi3" });
    expect(call.params["target-digest"]).toMatch(/^[0-9a-f]{40}$/);
    expect(pve.guests.get(202)!.cfg.scsi3).toBeDefined();
  });

  it("changes and ejects the CD drive, and adds one", async () => {
    const c = await signIn();
    let dg = (await view(c, 200)).digest;
    await post(c, "/api/guests/200/disks/cdrom", { digest: dg, key: "ide2", iso: "local:iso/alpine.iso" });
    expect(lastPut(200).params.ide2).toBe("local:iso/alpine.iso,media=cdrom");
    dg = (await view(c, 200)).digest;
    await post(c, "/api/guests/200/disks/cdrom", { digest: dg, key: "ide2", iso: "none" });
    expect(lastPut(200).params.ide2).toBe("none,media=cdrom");
    dg = (await view(c, 200)).digest;
    expect((await post(c, "/api/guests/200/disks/cdrom", { digest: dg, key: "scsi0", iso: "none" })).status).toBe(400);
    expect((await post(c, "/api/guests/200/disks/cdrom", { digest: dg, key: "ide2", iso: "local:iso/../../etc/passwd" })).status).toBe(400);
    delete pve.guests.get(200)!.cfg.ide2;
    dg = (await view(c, 200)).digest;
    expect(await j(await post(c, "/api/guests/200/disks/cdrom", { digest: dg, iso: "physical" }))).toEqual({ key: "ide2" });
    expect(lastPut(200).params.ide2).toBe("cdrom,media=cdrom");
  });

  it("adds, edits and removes container mount points", async () => {
    const c = await signIn();
    let dg = (await view(c, 201)).digest;
    expect(await j(await post(c, "/api/guests/201/disks/mount", { digest: dg, storage: "local-lvm", sizeGb: 5, mp: "/srv", backup: true, acl: true, quota: true, replicate: false }))).toEqual({ key: "mp1" });
    expect(lastPut(201).params.mp1).toBe("local-lvm:5,mp=/srv,backup=1,acl=1,quota=1,replicate=0");
    dg = (await view(c, 201)).digest;
    await post(c, "/api/guests/201/disks/mp0/edit", { digest: dg, backup: false, ro: true, mountoptions: ["noatime"] });
    expect(lastPut(201).params.mp0).toBe("local-lvm:vm-201-disk-1,mp=/data,size=20G,ro=1,mountoptions=noatime");
    dg = (await view(c, 201)).digest;
    expect((await post(c, "/api/guests/201/disks/mp1/detach", { digest: dg })).status).toBe(200);
    expect(lastPut(201).params.delete).toBe("mp1");
    for (const body of [{ mp: "relative" }, { mp: "/" }, { mp: "/a/../b" }, { mountoptions: ["suid"] }]) {
      const r = await post(c, "/api/guests/201/disks/mount", { digest: (await view(c, 201)).digest, storage: "local-lvm", sizeGb: 5, mp: "/ok", ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("allows bind mounts only for administrators, with a clean host path", async () => {
    const dg = (await view(await signIn(), 201)).digest;
    const lee = await signIn("lee");
    const denied = await post(lee, "/api/guests/201/disks/mount", { digest: dg, bind: "/srv/shared", mp: "/shared" });
    expect(denied.status).toBe(403);
    const c = await signIn();
    const r = await post(c, "/api/guests/201/disks/mount", { digest: dg, bind: "/srv/shared", mp: "/shared", ro: true });
    expect(await j(r)).toEqual({ key: "mp1" });
    expect(lastPut(201).params.mp1).toBe("/srv/shared,mp=/shared,ro=1");
    for (const bind of ["/etc/pve", "/proc/1", "relative", "/a/../b", "/x,mp=/y", "/srv shared"]) {
      const bad = await post(c, "/api/guests/201/disks/mount", { digest: (await view(c, 201)).digest, bind, mp: "/s" });
      expect(bad.status, bind).toBe(400);
    }
    const v = await view(c, 201);
    expect(v.disks.find((d: any) => d.key === "mp1").kind).toBe("bind");
  });

  it("answers 403 for a person without rights, and needs the same-site header", async () => {
    const dg = (await view(await signIn(), 200)).digest;
    const lee = await signIn("lee");
    const r = await post(lee, "/api/guests/200/disks/scsi0/detach", { digest: dg });
    expect(r.status).toBe(403);
    expect((await j(r)).error).toMatch(/permission/i);
    const c = await signIn();
    const nohdr = await fetch(`${base}/api/guests/200/disks/scsi0/detach`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: c }, body: JSON.stringify({ digest: dg }) });
    expect(nohdr.status).toBe(403);
  });
});

describe("drive strings", () => {
  it("builds options and keeps unknown keys", () => {
    expect(vmDiskChanges("scsi", { discard: true, ssd: false })).toEqual({ discard: "on", ssd: null });
    expect(driveString("local-lvm:vm-1-disk-0,size=8G,serial=ABC", { cache: "none", serial: null })).toBe("local-lvm:vm-1-disk-0,size=8G,cache=none");
    expect(() => vmDiskChanges("virtio", { ssd: true })).toThrow(/SSD/);
    expect(mpChanges({ mp: "/data", backup: true }, true)).toEqual({ mp: "/data", backup: "1" });
    expect(() => bindPath("/proc/self")).toThrow();
    expect(freeKey({ scsi0: "x", scsi1: "y" }, "scsi")).toBe("scsi2");
    expect(() => freeKey({ ide0: 1, ide1: 1, ide2: 1, ide3: 1 }, "ide")).toThrow(/taken/);
    expect(readDrive("local:vm-1-disk-0,cache=none,discard=on,ssd=1,backup=0,size=4G")).toMatchObject({ cache: "none", discard: true, ssd: true, backup: false, sizeGb: 4 });
    expect(newVmDisk({ bus: "sata", storage: "s", sizeGb: 2 })).toEqual({ bus: "sata", storage: "s", sizeGb: 2, format: null });
  });
});
