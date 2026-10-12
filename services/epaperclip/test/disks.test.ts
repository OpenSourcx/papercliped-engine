import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { publicStorage } from "../src/features/disks.ts";
import { fakePve } from "./fakes.ts";
import { fakeDisks } from "./fakes-disks.ts";

let server: Server;
let base: string;
let pve: ReturnType<typeof fakeDisks>;
let logged: string[];

beforeEach(async () => {
  pve = fakeDisks(fakePve().transport);
  logged = [];
  for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
  const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(), staticDir: null, secureCookies: false });
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-EPC-Request": "1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (path: string, c: string) => fetch(base + path, { headers: { Cookie: c } });
const j = (r: Response): Promise<any> => r.json();
async function signIn(username = "sam") {
  const r = await send("POST", "/api/login", { username, password: "right", realm: "pve" });
  return r.headers.get("set-cookie")!.split(";")[0];
}
const post = (c: string, path: string, body: unknown) => send("POST", path, body, { Cookie: c });
const reached = (method: string, re: RegExp) => pve.calls.some((c) => c.method === method && re.test(c.path));

describe("physical disks", () => {
  it("lists disks with type, size, model, serial, use, wear and health", async () => {
    const c = await signIn();
    const r = await j(await get("/api/disks/list", c));
    const nvme = r.disks.find((d: any) => d.name === "nvme0n1");
    expect(nvme).toMatchObject({ type: "nvme", sizeBytes: 1e12, model: "Fast NVMe", serial: "NV1", usedBy: null, health: "PASSED", wearoutPct: 3 });
    expect(r.disks.find((d: any) => d.name === "sdd")).toMatchObject({ usedBy: "LVM", health: "FAILED" });
    expect(r.disks.find((d: any) => d.name === "sdb").wearoutPct).toBeNull();
    expect(r.disks.some((d: any) => d.name === "sda1")).toBe(false);
  });

  it("reads SMART detail and refuses a made-up device", async () => {
    const c = await signIn();
    expect((await j(await get("/api/disks/smart?disk=/dev/sdb", c))).attributes[0].name).toBe("Reallocated_Sector_Ct");
    expect((await get("/api/disks/smart?disk=/dev/../etc/passwd", c)).status).toBe(400);
    expect((await get("/api/disks/smart?disk=sda;reboot", c)).status).toBe(400);
  });

  it("wipes only after the disk's name is typed, and the check happens at the API", async () => {
    const c = await signIn();
    const no = await post(c, "/api/disks/wipe", { disk: "/dev/sdb" });
    expect(no.status).toBe(409);
    expect((await post(c, "/api/disks/wipe", { disk: "/dev/sdb", confirm: "sdc" })).status).toBe(409);
    expect(reached("PUT", /wipedisk/)).toBe(false);
    const yes = await post(c, "/api/disks/wipe", { disk: "/dev/sdb", confirm: "sdb" });
    expect(yes.status).toBe(202);
    expect((await j(yes)).task).toMatch(/^UPID:/);
    expect(reached("PUT", /wipedisk/)).toBe(true);
  });

  it("refuses disks in use by LVM, ZFS, a mount or the boot loader before Proxmox is asked", async () => {
    const c = await signIn();
    const lvm = await post(c, "/api/disks/wipe", { disk: "/dev/sdd", confirm: "sdd" });
    expect(lvm.status).toBe(409);
    expect((await j(lvm)).error).toMatch(/LVM/);
    const esp = await post(c, "/api/disks/initgpt", { disk: "/dev/sda1", confirm: "/dev/sda1" });
    expect(esp.status).toBe(409);
    expect(reached("PUT", /wipedisk/) || reached("POST", /initgpt/)).toBe(false);
  });

  it("shows Proxmox's own refusal when it says no", async () => {
    const c = await signIn();
    const r = await post(c, "/api/disks/directory", { name: "bulk", device: "/dev/sdc", filesystem: "ext4", addStorage: true });
    expect(r.status).toBe(202);
    const again = await post(c, "/api/disks/directory", { name: "bulk2", device: "/dev/sdc" });
    expect(again.status).toBe(409); // now mounted
    const refused = await post(c, "/api/disks/zfs/tank/delete", { confirm: "tank" });
    expect(refused.status).toBe(502); // Proxmox answered 500; its reason is passed on
    expect((await j(refused)).error).toMatch(/busy/);
  });

  it("initializes with GPT on typed confirmation", async () => {
    const c = await signIn();
    const r = await post(c, "/api/disks/initgpt", { disk: "/dev/nvme0n1", confirm: "nvme0n1" });
    expect(r.status).toBe(202);
    expect(reached("POST", /initgpt/)).toBe(true);
  });

  it("answers 403 with a clear message when the account lacks permission", async () => {
    const lee = await signIn("lee");
    const r = await post(lee, "/api/disks/wipe", { disk: "/dev/sdb", confirm: "sdb" });
    expect(r.status).toBe(403);
    expect((await j(r)).error).toMatch(/permission/i);
  });

  it("requires the same-site header on changes", async () => {
    const c = await signIn();
    const r = await fetch(base + "/api/disks/wipe", { method: "POST", headers: { "Content-Type": "application/json", Cookie: c }, body: JSON.stringify({ disk: "/dev/sdb", confirm: "sdb" }) });
    expect(r.status).toBe(403);
  });

  it("requires a signed-in person", async () => {
    expect((await fetch(base + "/api/disks/list")).status).toBe(401);
  });
});

describe("storage on disks", () => {
  it("creates a directory, LVM and LVM-thin storage on unused disks", async () => {
    const c = await signIn();
    expect((await post(c, "/api/disks/directory", { name: "bulk", device: "/dev/sdb", filesystem: "xfs", addStorage: true })).status).toBe(202);
    const call = pve.calls.find((x) => x.method === "POST" && x.path.endsWith("/disks/directory"))!;
    expect(call.params).toMatchObject({ name: "bulk", device: "/dev/sdb", filesystem: "xfs", add_storage: "1" });
    expect((await post(c, "/api/disks/lvm", { name: "vgdata", device: "/dev/sdc" })).status).toBe(202);
    expect((await post(c, "/api/disks/lvmthin", { name: "thin", device: "/dev/nvme0n1" })).status).toBe(202);
  });

  it("validates names, devices and file systems", async () => {
    const c = await signIn();
    for (const body of [{ name: "Bad Name", device: "/dev/sdb" }, { name: "ok", device: "sdb" }, { name: "ok", device: "/dev/sdb; rm" }, { name: "ok", device: "/dev/sdb", filesystem: "ntfs" }]) expect((await post(c, "/api/disks/directory", body)).status).toBe(400);
    expect(reached("POST", /\/disks\/directory/)).toBe(false);
  });

  it("creates ZFS pools with a checked layout", async () => {
    const c = await signIn();
    const mirror = await post(c, "/api/disks/zfs", { name: "fast", devices: ["/dev/sdb", "/dev/sdc"], raidlevel: "mirror", ashift: 12, compression: "zstd", addStorage: true });
    expect(mirror.status).toBe(202);
    expect(pve.calls.find((x) => x.path.endsWith("/disks/zfs") && x.method === "POST")!.params).toMatchObject({ devices: "/dev/sdb,/dev/sdc", raidlevel: "mirror", ashift: "12", compression: "zstd" });
    for (const body of [
      { name: "z", devices: ["/dev/sdb"], raidlevel: "mirror" },
      { name: "z", devices: ["/dev/sdb", "/dev/sdc", "/dev/nvme0n1"], raidlevel: "raid10" },
      { name: "z", devices: ["/dev/sdb", "/dev/sdb"], raidlevel: "mirror" },
      { name: "z", devices: ["/dev/sdb", "/dev/sdc"], raidlevel: "mirror", ashift: 20 },
      { name: "z", devices: ["/dev/sdb", "/dev/sdc"], raidlevel: "mirror", compression: "evil" },
      { name: "z", devices: ["/dev/sdb", "/dev/sdc", "/dev/nvme0n1"], raidlevel: "draid" },
    ]) expect((await post(c, "/api/disks/zfs", body)).status).toBe(400);
  });

  it("lists LVM groups, thin pools, directories and the ZFS status tree", async () => {
    const c = await signIn();
    expect((await j(await get("/api/disks/lvm", c))).items[0].name).toBe("vg0");
    expect((await j(await get("/api/disks/lvmthin", c))).items[0]).toMatchObject({ lv: "data", vg: "vg0" });
    expect((await j(await get("/api/disks/zfs", c))).items[0].name).toBe("tank");
    const tree = await j(await get("/api/disks/zfs/tank", c));
    expect(tree.children[0].children[0].children.map((x: any) => x.name)).toEqual(["sdb", "sdc"]);
    expect((await get("/api/disks/zfs/..%2Fx", c)).status).toBe(400);
  });

  it("deletes only after the name is typed", async () => {
    const c = await signIn();
    expect((await post(c, "/api/disks/lvm/vg0/delete", { confirm: "other" })).status).toBe(409);
    expect(reached("DELETE", /disks\/lvm/)).toBe(false);
    const r = await post(c, "/api/disks/lvm/vg0/delete", { confirm: "vg0", cleanupConfig: true, cleanupDisks: true });
    expect(r.status).toBe(202);
    expect(pve.calls.find((x) => x.method === "DELETE")!.params).toMatchObject({ "cleanup-config": "1", "cleanup-disks": "1" });
    expect((await post(c, "/api/disks/lvmthin/data/delete", { confirm: "data" })).status).toBe(400); // needs the volume group
    expect((await post(c, "/api/disks/lvmthin/data/delete", { confirm: "data", volumeGroup: "vg0" })).status).toBe(202);
  });
});

describe("storage definitions", () => {
  it("lists definitions without any secret, saying only which are set", async () => {
    const c = await signIn();
    const text = await (await get("/api/storage-config", c)).text();
    expect(text).not.toContain("hunter2-secret");
    expect(text).not.toContain("pbs-secret");
    expect(text).not.toContain("AA:BB:CC");
    const r = JSON.parse(text);
    const nas = r.storages.find((s: any) => s.id === "nas");
    expect(nas).toMatchObject({ type: "cifs", content: ["backup", "iso"], shared: true, secretsSet: ["password"] });
    expect(nas.prune).toMatchObject({ keepLast: 3, keepDaily: 7 });
    expect(r.storages.find((s: any) => s.id === "pbs1").secretsSet.sort()).toEqual(["fingerprint", "password"]);
    expect(publicStorage({ storage: "x", type: "cifs", password: "p" })).not.toHaveProperty("config.password");
  });

  it("adds a CIFS storage with a write-only password that is never returned or logged", async () => {
    const c = await signIn();
    const r = await post(c, "/api/storage-config", { type: "cifs", storage: "share2", server: "10.0.0.9", share: "iso", username: "me", password: "sup3r-secret-pw", content: ["iso", "backup"], nodes: ["pve"], "prune-backups": { keepLast: 5 }, bwlimit: { default: 50000 } });
    expect(r.status).toBe(200);
    expect(pve.calls.find((x) => x.method === "POST" && x.path === "/storage")!.params).toMatchObject({ type: "cifs", server: "10.0.0.9", share: "iso", content: "iso,backup", nodes: "pve", "prune-backups": "keep-last=5", bwlimit: "default=50000", password: "sup3r-secret-pw" });
    const back = await (await get("/api/storage-config/share2", c)).text();
    expect(back).not.toContain("sup3r-secret-pw");
    expect(JSON.parse(back).secretsSet).toContain("password");
    expect(logged.join("\n")).not.toContain("sup3r-secret-pw");
  });

  it("validates per type: unknown fields, wrong content, missing required values", async () => {
    const c = await signIn();
    const cases: Record<string, unknown>[] = [
      { type: "nfs", storage: "n1", server: "10.0.0.1", content: ["images"] },
      { type: "nfs", storage: "n1", server: "10.0.0.1; reboot", export: "/e", content: ["images"] },
      { type: "pbs", storage: "p1", server: "h", datastore: "d", username: "u", password: "p", content: ["images"] },
      { type: "lvmthin", storage: "t1", vgname: "vg", thinpool: "p", content: ["iso"] },
      { type: "dir", storage: "d1", path: "relative", content: ["images"] },
      { type: "dir", storage: "d1", path: "/mnt/x", content: ["images"], rogue: 1 },
      { type: "dir", storage: "BAD ID", path: "/mnt/x", content: ["images"] },
      { type: "dir", storage: "d1", path: "/mnt/x", content: [] },
      { type: "nope", storage: "d1" },
      { type: "dir", storage: "d1", path: "/mnt/x", content: ["images"], "prune-backups": { keepAll: true, keepLast: 2 } },
      { type: "lvm", storage: "l1", vgname: "vg", content: ["images"], "prune-backups": { keepLast: 2 } },
      { type: "pbs", storage: "p1", server: "h", datastore: "d", username: "u", password: "p", fingerprint: "nope", content: ["backup"] },
    ];
    for (const body of cases) expect((await post(c, "/api/storage-config", body)).status, JSON.stringify(body)).toBe(400);
    expect(pve.calls.some((x) => x.method === "POST" && x.path === "/storage")).toBe(false);
  });

  it("edits with the digest and refuses a stale page", async () => {
    const c = await signIn();
    const cur = await j(await get("/api/storage-config/nas", c));
    const stale = await post(c, "/api/storage-config/nas", { content: ["backup"], digest: "0".repeat(40) });
    expect(stale.status).toBe(400);
    const ok = await post(c, "/api/storage-config/nas", { content: ["backup"], digest: cur.digest, "prune-backups": { keepLast: 10 }, disable: true });
    expect(ok.status).toBe(200);
    expect(pve.storages.get("nas")).toMatchObject({ content: "backup", "prune-backups": "keep-last=10", disable: "1" });
    expect(pve.storages.get("nas")!.password).toBe("hunter2-secret"); // an empty password keeps the stored one
    expect((await post(c, "/api/storage-config/nas", { content: ["backup"] })).status).toBe(400); // digest is required
  });

  it("refuses to change what Proxmox fixes at creation", async () => {
    const c = await signIn();
    const cur = await j(await get("/api/storage-config/nas", c));
    const r = await post(c, "/api/storage-config/nas", { server: "10.9.9.9", digest: cur.digest });
    expect(r.status).toBe(400);
    expect((await j(r)).error).toMatch(/can't be changed/);
  });

  it("removes after the name is typed and warns about what uses it", async () => {
    const c = await signIn();
    const use = await j(await get("/api/storage-config/local-lvm/usage", c));
    expect(use.guests.map((g: any) => g.vmid)).toEqual([200, 201]);
    const nas = await j(await get("/api/storage-config/nas/usage", c));
    expect(nas.backupJobs).toEqual(["backup-1"]);
    expect((await post(c, "/api/storage-config/nas/delete", { confirm: "wrong" })).status).toBe(409);
    expect(pve.storages.has("nas")).toBe(true);
    const inUse = await post(c, "/api/storage-config/nas/delete", { confirm: "nas" });
    expect(inUse.status).toBe(409);
    expect((await j(inUse)).code).toBe("in_use");
    expect((await post(c, "/api/storage-config/nas/delete", { confirm: "nas", acknowledgeInUse: true })).status).toBe(200);
    expect(pve.storages.has("nas")).toBe(false);
    expect((await post(c, "/api/storage-config/pbs1/delete", { confirm: "pbs1" })).status).toBe(200);
  });

  it("turns Proxmox's 403 into a clear message", async () => {
    const lee = await signIn("lee");
    const r = await post(lee, "/api/storage-config", { type: "dir", storage: "d1", path: "/mnt/x", content: ["images"] });
    expect(r.status).toBe(403);
    expect((await j(r)).error).toMatch(/permission/i);
  });

  it("scans for NFS exports, SMB shares, PBS datastores, iSCSI targets and local pools; credentials go in the body", async () => {
    const c = await signIn();
    expect((await j(await post(c, "/api/storage-config/scan/nfs", { server: "10.0.0.5" }))).items[0].path).toBe("/export/pve");
    expect((await j(await post(c, "/api/storage-config/scan/cifs", { server: "10.0.0.5", username: "u", password: "scan-secret" }))).items[0].share).toBe("pve");
    expect((await j(await post(c, "/api/storage-config/scan/pbs", { server: "10.0.0.6", username: "u@pbs", password: "p" }))).items[0].store).toBe("main");
    expect((await j(await post(c, "/api/storage-config/scan/iscsi", { portal: "10.0.0.7:3260" }))).items[0].target).toMatch(/^iqn/);
    expect((await j(await post(c, "/api/storage-config/scan/lvm", {}))).items[0].vg).toBe("vg0");
    expect((await j(await post(c, "/api/storage-config/scan/lvmthin", { vg: "vg0" }))).items[0].lv).toBe("data");
    expect((await j(await post(c, "/api/storage-config/scan/zfs", {}))).items[0].pool).toBe("tank");
    expect((await post(c, "/api/storage-config/scan/nfs", { server: "bad host!" })).status).toBe(400);
    const bad = await post(c, "/api/storage-config/scan/pbs", { server: "h", username: "u", password: "wrong" });
    expect((await j(bad)).error).toMatch(/authentication failed/);
    expect(logged.join("\n")).not.toContain("scan-secret");
  });

  it("protects backups and edits notes on a volume", async () => {
    const c = await signIn();
    expect((await post(c, "/api/storage/local/attributes", { volid: "local:backup/vzdump-qemu-200.vma.zst", protected: true, notes: "keep" })).status).toBe(200);
    expect(pve.volAttrs.get("local:backup/vzdump-qemu-200.vma.zst")).toMatchObject({ protected: "1", notes: "keep" });
    expect((await post(c, "/api/storage/local/attributes", { volid: "other:backup/x", protected: true })).status).toBe(400);
    expect((await post(c, "/api/storage/local/attributes", { volid: "local:backup/../x", protected: true })).status).toBe(400);
  });
});
