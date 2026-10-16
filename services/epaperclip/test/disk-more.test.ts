import { afterEach, describe, expect, it } from "vitest";
import { Harness } from "./diskcluster-harness.ts";

const h = new Harness();
afterEach(() => h.close());

describe("permissions", () => {
  it("needs sign-in and the same-site header; an unprivileged account can read but not change", async () => {
    await h.boot();
    expect((await h.send("", "GET", "/api/storage-tools/local/usage")).status).toBe(401);
    expect((await h.send("", "GET", "/api/disk-health")).status).toBe(401);
    expect((await h.send("", "GET", "/api/backup-tools/jobs")).status).toBe(401);
    const sam = await h.signIn();
    expect((await h.send(sam, "POST", "/api/storage-tools/local/prune", { confirm: "local" }, {})).status).toBe(403);
    const lee = await h.signIn("lee");
    const r = await h.send(lee, "POST", "/api/storage-tools/local/allocate", { vmid: 200, name: "vm-200-disk-5", sizeGiB: 1 });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/permission/);
    expect((await h.send(sam, "DELETE", "/api/storage-tools/local/usage")).status).toBe(405);
    expect((await h.send(sam, "GET", "/api/storage-tools/bad%20name/usage")).status).toBe(400);
  });
});

describe("storage usage", () => {
  it("adds up what each content type takes, by machine, with the largest files and what is left over", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/storage-tools/local/usage")).json;
    expect(r).toMatchObject({ storage: "local", type: "dir", total: 100e9, used: 60e9, percent: 60 });
    const byType = Object.fromEntries(r.byType.map((t: any) => [t.content, t]));
    expect(byType.backup).toMatchObject({ count: 4, bytes: 13e9, label: "Backups" });
    expect(byType.iso.bytes).toBe(700e6);
    expect(r.other).toBe(60e9 - r.byType.reduce((a: number, t: any) => a + t.bytes, 0));
    expect(r.largest[0].size).toBe(4e9);
    expect(r.byGuest.find((g: any) => g.vmid === 200).count).toBe(3);
  });

  it("reads the usage history for a time frame", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/storage-tools/local/rrd?timeframe=week&cf=MAX")).json;
    expect(r.points).toHaveLength(2);
    expect(r.points[1]).toMatchObject({ used: 6e10, total: 1e11 });
    expect(h.calls("GET", "/nodes/pve/storage/local/rrddata")[0].params).toMatchObject({ timeframe: "week", cf: "MAX" });
    expect((await h.send(sam, "GET", "/api/storage-tools/local/rrd?timeframe=decade")).status).toBe(400);
    expect((await h.send(sam, "GET", "/api/storage-tools/local/rrd?cf=SUM")).status).toBe(400);
  });
});

describe("retention", () => {
  it("previews what a prune would remove, with the space it frees, before anything is deleted", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/storage-tools/local/prune?keepLast=1")).json;
    expect(r.counts).toEqual({ keep: 0, remove: 3, protected: 1, renamed: 0 });
    expect(r.bytesToFree).toBe(12e9);
    expect(r.retention.keepLast).toBe(1);
    expect(r.items.find((i: any) => i.mark === "protected").volid).toContain("lxc-201");
    expect(h.calls("GET", "/nodes/pve/storage/local/prunebackups")[0].params["prune-backups"]).toBe("keep-last=1");
    expect(h.pve.pruned).toEqual([]);
    expect((await h.send(sam, "GET", "/api/storage-tools/local/prune?keepLast=0")).status).toBe(400);
    expect((await h.send(sam, "GET", "/api/storage-tools/local/prune?vmid=12")).status).toBe(400);
    expect((await h.send(sam, "GET", "/api/storage-tools/local/prune?type=ct")).status).toBe(400);
    expect((await h.send(sam, "GET", "/api/storage-tools/local/prune?keepAll=true&keepLast=3")).status).toBe(400);
  });

  it("prunes only with the storage's name typed, and not when nothing would go", async () => {
    await h.boot();
    const sam = await h.signIn();
    expect((await h.send(sam, "POST", "/api/storage-tools/local/prune", { keepLast: 1 })).json.code).toBe("confirm");
    expect((await h.send(sam, "POST", "/api/storage-tools/local/prune", { keepLast: 1, confirm: "local", sneaky: 1 })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/storage-tools/local/prune", { keepLast: 10, confirm: "local" })).json.code).toBe("nothing_to_prune");
    const ok = await h.send(sam, "POST", "/api/storage-tools/local/prune", { keepLast: 1, vmid: 200, confirm: "local" });
    expect(ok.status).toBe(200);
    expect(ok.json.task).toMatch(/^UPID:/);
    expect(h.pve.pruned).toHaveLength(2);
    expect(h.calls("DELETE", "/nodes/pve/storage/local/prunebackups")[0].params).toMatchObject({ "prune-backups": "keep-last=1", vmid: "200" });
  });
});

describe("volumes and files", () => {
  it("allocates a new disk image for a machine, with checks on the name and size", async () => {
    await h.boot();
    const sam = await h.signIn();
    const body = { vmid: 200, name: "vm-200-disk-7", sizeGiB: 4, format: "raw" };
    expect((await h.send(sam, "POST", "/api/storage-tools/local-lvm/allocate", { ...body, name: "vm-201-disk-1" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/storage-tools/local-lvm/allocate", { ...body, sizeGiB: 0 })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/storage-tools/local-lvm/allocate", { ...body, format: "iso" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/storage-tools/local-lvm/allocate", { ...body, vmid: 999, name: "vm-999-disk-1" })).status).toBe(404);
    const ok = await h.send(sam, "POST", "/api/storage-tools/local-lvm/allocate", body);
    expect(ok.json.volid).toBe("local-lvm:vm-200-disk-7");
    expect(h.calls("POST", "/nodes/pve/storage/local-lvm/content")[0].params).toMatchObject({ vmid: "200", filename: "vm-200-disk-7", size: "4G", format: "raw" });
  });

  it("copies a volume only when the experimental warning is accepted and the name is typed", async () => {
    await h.boot();
    const sam = await h.signIn();
    const body = { volume: "local-lvm:vm-200-disk-0", target: "zfs-tank:vm-200-disk-9" };
    expect((await h.send(sam, "POST", "/api/storage-tools/local-lvm/copy", body)).json.code).toBe("experimental");
    expect((await h.send(sam, "POST", "/api/storage-tools/local-lvm/copy", { ...body, acknowledgeExperimental: true })).json.code).toBe("confirm");
    expect((await h.send(sam, "POST", "/api/storage-tools/local-lvm/copy", { ...body, target: body.volume, acknowledgeExperimental: true, confirm: "vm-200-disk-0" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/storage-tools/local-lvm/copy", { ...body, volume: "local:iso/x.iso", acknowledgeExperimental: true, confirm: "x.iso" })).status).toBe(400);
    const ok = await h.send(sam, "POST", "/api/storage-tools/local-lvm/copy", { ...body, acknowledgeExperimental: true, confirm: "vm-200-disk-0" });
    expect(ok.status).toBe(200);
    expect(h.calls("POST", "/nodes/pve/storage/local-lvm/content/local-lvm%3Avm-200-disk-0")[0].params.target).toBe("zfs-tank:vm-200-disk-9");
  });

  it("gives checksum commands for a stored file, quoted for a shell", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/storage-tools/local/volume?volid=local:iso/debian.iso")).json;
    expect(r.path).toBe("/var/lib/vz/iso/debian.iso");
    expect(r.verify.map((v: any) => v.command)).toContain("sha256sum '/var/lib/vz/iso/debian.iso'");
    expect(r.verify.map((v: any) => v.algorithm)).not.toContain("md5");
    expect((await h.send(sam, "GET", "/api/storage-tools/local/volume?volid=other:iso/x.iso")).status).toBe(400);
    expect((await h.send(sam, "GET", "/api/storage-tools/local/volume?volid=local:iso/../../etc/passwd")).status).toBe(400);
    expect((await h.send(sam, "GET", "/api/storage-tools/local/volume?volid=local:iso/missing.iso")).status).toBeGreaterThanOrEqual(400);
    const own = (await h.send(sam, "GET", "/api/storage-tools/local/volume?volid=local:backup/vzdump-qemu-200-2025_10_01-02_00_00.vma.zst")).json;
    expect(own.owner).toEqual({ vmid: 200, type: "qemu" });
  });

  it("lists snippets and explains how to add one, since the API cannot", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/storage-tools/local/snippets")).json;
    expect(r.files.map((f: any) => f.name)).toEqual(["hook.sh"]);
    expect(r.reason).toMatch(/does not take snippet uploads/);
    expect(r.enabled).toBe(false);
  });

  it("points at the publishers' own pages for ISO images", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/storage-tools/iso-sources")).json;
    expect(r.sources.map((s: any) => s.id)).toContain("debian");
    expect(r.sources.every((s: any) => s.page.startsWith("https://"))).toBe(true);
  });

  it("looks up a file's size and name before downloading it", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/storage-tools/url-metadata?url=" + encodeURIComponent("https://example.com/debian-13.iso"))).json;
    expect(r).toMatchObject({ filename: "debian-13.iso", size: 700e6, suggestedContent: "iso" });
    expect((await h.send(sam, "GET", "/api/storage-tools/url-metadata?url=ftp://x/y")).status).toBe(400);
    expect((await h.send(sam, "GET", "/api/storage-tools/url-metadata")).status).toBe(400);
  });
});

describe("importing a disk image", () => {
  it("downloads an import file with its checksum checked, and refuses a wrong-looking one", async () => {
    await h.boot();
    const sam = await h.signIn();
    const body = { url: "https://example.com/app.qcow2", filename: "app.qcow2", checksum: "a".repeat(64), algorithm: "sha256" };
    expect((await h.send(sam, "POST", "/api/storage-tools/local/download-import", { ...body, filename: "app.exe" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/storage-tools/local/download-import", { ...body, checksum: "abc" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/storage-tools/local/download-import", { ...body, url: "file:///etc/passwd" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/storage-tools/local/download-import", { ...body, algorithm: "crc" })).status).toBe(400);
    const ok = await h.send(sam, "POST", "/api/storage-tools/local/download-import", body);
    expect(ok.status).toBe(200);
    expect(h.calls("POST", "/nodes/pve/storage/local/download-url")[0].params).toMatchObject({ content: "import", checksum: "a".repeat(64), "checksum-algorithm": "sha256", filename: "app.qcow2" });
  });

  it("reads the import metadata of a foreign appliance", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/storage-tools/local/import-metadata?volume=local:import/appliance.qcow2")).json;
    expect(r.createArgs).toEqual({ cores: 2, memory: 2048 });
    expect(r.warnings).toHaveLength(1);
  });

  it("attaches an imported image to a machine in the next free slot with the machine's digest", async () => {
    await h.boot();
    const sam = await h.signIn();
    const body = { vmid: 200, volume: "local:import/appliance.qcow2", bus: "scsi", targetStorage: "local-lvm" };
    expect((await h.send(sam, "POST", "/api/storage-tools/local/import-disk", { ...body, bus: "floppy" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/storage-tools/local/import-disk", { ...body, volume: "local:iso/debian.iso" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/storage-tools/local/import-disk", { ...body, vmid: 201 })).status).toBe(404);
    const ok = await h.send(sam, "POST", "/api/storage-tools/local/import-disk", { ...body, format: "qcow2" });
    expect(ok.status).toBe(200);
    expect(ok.json.key).toBe("scsi1");
    const put = h.calls("PUT", "/nodes/pve/qemu/200/config")[0].params;
    expect(put.scsi1).toBe("local-lvm:0,import-from=local:import/appliance.qcow2,format=qcow2");
    expect(put.digest).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("backup jobs with every option", () => {
  it("reads jobs with their selection, fleecing, speed, notes and retention", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/backup-tools/jobs")).json;
    expect(r.pools).toContain("existing");
    const pool = r.jobs.find((j: any) => j.id === "backup-pool");
    expect(pool).toMatchObject({ selection: "pool", pool: "existing", mode: "stop", fleecing: { enabled: true, storage: "local-lvm" }, performance: { maxWorkers: 4 }, notesTemplate: "{{guestname}}" });
    const nightly = r.jobs.find((j: any) => j.id === "backup-nightly");
    expect(nightly).toMatchObject({ selection: "vmids", vmids: [200, 201], prune: { keepLast: 3 } });
  });

  it("creates a job that backs up everything except some machines, with the extra options", async () => {
    await h.boot();
    const sam = await h.signIn();
    const body = { id: "all-but", schedule: "mon..fri 01:30", storage: "local", selection: "all", exclude: [9000, 202], mode: "snapshot", compress: "zstd", notesTemplate: "{{cluster}} {{guestname}}", notificationMode: "notification-system", fleecing: { enabled: true, storage: "local-lvm" }, bwlimit: 50000, performance: { maxWorkers: 2 }, zstd: 2, ionice: 5, repeatMissed: true, protected: false, excludePath: ["/tmp/*"], pbsChangeDetectionMode: "metadata", prune: { keepLast: 2, keepWeekly: 4 } };
    const ok = await h.send(sam, "POST", "/api/backup-tools/jobs", body);
    expect(ok.status).toBe(200);
    const sent = h.pve.calls.find((c) => c.method === "POST" && c.path === "/cluster/backup")!.params;
    expect(sent).toMatchObject({ id: "all-but", all: "1", exclude: "9000,202", fleecing: "enabled=1,storage=local-lvm", performance: "max-workers=2", bwlimit: "50000", zstd: "2", ionice: "5", "repeat-missed": "1", "prune-backups": "keep-last=2,keep-weekly=4", "notification-mode": "notification-system", "pbs-change-detection-mode": "metadata" });
    expect(sent.vmid).toBeUndefined();
    expect(h.pve.jobs.get("all-but")!["exclude-path"]).toEqual(["/tmp/*"]);
  });

  it("refuses anything Proxmox would not accept, before asking it", async () => {
    await h.boot();
    const sam = await h.signIn();
    const base = { id: "j1x", schedule: "21:00", storage: "local", selection: "vmids", vmids: [200] };
    const bad: Record<string, unknown>[] = [{ id: "1" }, { schedule: "" }, { storage: "bad storage" }, { selection: "everything" }, { vmids: [] }, { vmids: [5] }, { selection: "pool", pool: "bad pool" }, { selection: "all", exclude: ["x"] }, { mode: "freeze" }, { compress: "rar" }, { notificationMode: "pigeon" }, { bwlimit: -1 }, { ionice: 9 }, { zstd: "many" }, { prune: { keepLast: 0 } }, { prune: { keepAll: true, keepLast: 1 } }, { excludePath: [""] }, { performance: { maxWorkers: 0 } }, { node: "nowhere" }, { sneaky: 1 }, { fleecing: { enabled: true, storage: "x y" } }, { pbsChangeDetectionMode: "guess" }];
    for (const b of bad) {
      const r = await h.send(sam, "POST", "/api/backup-tools/jobs", { ...base, ...b });
      expect(r.status, JSON.stringify(b)).toBeGreaterThanOrEqual(400);
    }
    expect(h.pve.calls.filter((c) => c.method === "POST" && c.path === "/cluster/backup")).toHaveLength(0);
  });

  it("edits with the digest, switches selection cleanly and deletes only when typed", async () => {
    await h.boot();
    const sam = await h.signIn();
    const digest = h.pve.jobs.get("backup-nightly")!.digest as string;
    expect((await h.send(sam, "PUT", "/api/backup-tools/jobs/backup-nightly", { comment: "x" })).status).toBe(400);
    expect((await h.send(sam, "PUT", "/api/backup-tools/jobs/backup-nightly", { digest })).json.error).toMatch(/Nothing/);
    expect((await h.send(sam, "PUT", "/api/backup-tools/jobs/backup-nightly", { id: "renamed", digest })).status).toBe(400);
    const ok = await h.send(sam, "PUT", "/api/backup-tools/jobs/backup-nightly", { selection: "pool", pool: "web", prune: null, notesTemplate: "", digest });
    expect(ok.status).toBe(200);
    const sent = h.calls("PUT", "/cluster/backup/backup-nightly")[0].params;
    expect(sent.pool).toBe("web");
    expect(sent.all).toBe("0");
    expect(sent.delete.split(",").sort()).toEqual(["exclude", "notes-template", "prune-backups", "vmid"]);
    expect(h.pve.jobs.get("backup-nightly")!.vmid).toBeUndefined();
    // The digest has moved on: the old one is refused by Proxmox.
    expect((await h.send(sam, "PUT", "/api/backup-tools/jobs/backup-nightly", { comment: "again", digest })).status).toBeGreaterThanOrEqual(400);
    expect((await h.send(sam, "DELETE", "/api/backup-tools/jobs/backup-nightly", {})).json.code).toBe("confirm");
    expect((await h.send(sam, "DELETE", "/api/backup-tools/jobs/backup-nightly", { confirm: "backup-nightly" })).status).toBe(200);
    expect(h.pve.jobs.has("backup-nightly")).toBe(false);
  });

  it("shows which volumes a job includes and which guests no job covers", async () => {
    await h.boot();
    const sam = await h.signIn();
    const v = (await h.send(sam, "GET", "/api/backup-tools/jobs/backup-nightly/volumes")).json;
    expect(v.guests[0].volumes).toEqual([{ id: "scsi0", name: "scsi0", included: true, reason: null }, { id: "scsi1", name: "scsi1", included: false, reason: "backup=0" }]);
    const n = (await h.send(sam, "GET", "/api/backup-tools/not-backed-up")).json;
    expect(n.guests.map((g: any) => g.vmid)).toEqual([101, 202]);
    expect(n.guests[1]).toMatchObject({ name: "vm-other", node: "pve" });
  });
});

describe("a backup file", () => {
  it("shows the guest configuration inside it with password hashes hidden", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/backup-tools/config?storage=local&volume=local:backup/vzdump-qemu-200-2025_10_01-02_00_00.vma.zst")).json;
    expect(r.config).toContain("cores: 2");
    expect(r.config).toContain("cipassword: …");
    expect(r.config).not.toContain("$5$secret");
    expect(r.owner).toEqual({ vmid: 200, type: "qemu" });
    expect((await h.send(sam, "GET", "/api/backup-tools/config?storage=local&volume=nas:backup/x")).status).toBe(400);
  });

  it("browses a Proxmox Backup Server snapshot, decoding Proxmox's base64 paths", async () => {
    await h.boot();
    const sam = await h.signIn();
    const vol = encodeURIComponent("pbs1:backup/vm/200/2025-10-03T02:00:00Z");
    const r = (await h.send(sam, "GET", `/api/backup-tools/files?storage=pbs1&volume=${vol}`)).json;
    expect(r.entries.map((e: any) => [e.name, e.path, e.type, e.leaf])).toEqual([["etc", "/etc", "d", false], ["hello.txt", "/hello.txt", "f", true]]);
    expect(r.entries[1].size).toBe(12);
    const sub = await h.send(sam, "GET", `/api/backup-tools/files?storage=pbs1&volume=${vol}&path=${encodeURIComponent("/etc")}`);
    expect(sub.status).toBe(200);
    expect(h.calls("GET", "/nodes/pve/storage/pbs1/file-restore/list").at(-1)!.params.filepath).toBe(Buffer.from("/etc").toString("base64"));
    const notPbs = await h.send(sam, "GET", "/api/backup-tools/files?storage=local&volume=local:backup/x.vma.zst");
    expect(notPbs.status).toBeGreaterThanOrEqual(400);
  });
});

describe("restoring with options", () => {
  const vm = "local:backup/vzdump-qemu-200-2025_10_03-02_00_00.vma.zst";
  it("restores as a new machine with a chosen number, storage, unique MAC, bandwidth and live restore", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = await h.send(sam, "POST", "/api/backup-tools/restore", { from: "local", volid: vm, vmid: 300, storage: "local-lvm", start: true, bwlimit: 20000, liveRestore: true, pool: "web" });
    expect(r.status).toBe(200);
    expect(r.json.vmid).toBe(300);
    expect(h.calls("POST", "/nodes/pve/qemu")[0].params).toMatchObject({ vmid: "300", archive: vm, storage: "local-lvm", unique: "1", start: "1", bwlimit: "20000", "live-restore": "1", pool: "web" });
    expect((await h.send(sam, "POST", "/api/backup-tools/restore", { from: "local", volid: vm, vmid: 200 })).json.code).toBe("exists");
    expect((await h.send(sam, "POST", "/api/backup-tools/restore", { from: "local", volid: vm, vmid: 301, unique: false })).status).toBe(200);
    expect(h.calls("POST", "/nodes/pve/qemu")[1].params.unique).toBeUndefined();
  });

  it("restores a container, and refuses live restore for it", async () => {
    await h.boot();
    const sam = await h.signIn();
    const ct = "local:backup/vzdump-lxc-201-2025_10_03-02_00_00.tar.zst";
    expect((await h.send(sam, "POST", "/api/backup-tools/restore", { from: "local", volid: ct, liveRestore: true })).status).toBe(400);
    const r = await h.send(sam, "POST", "/api/backup-tools/restore", { from: "local", volid: ct });
    expect(r.status).toBe(200);
    expect(h.calls("POST", "/nodes/pve/lxc")[0].params).toMatchObject({ ostemplate: ct, restore: "1", vmid: "300" });
  });

  it("replaces the original only with its number typed, and not while it runs", async () => {
    await h.boot();
    const sam = await h.signIn();
    const ct = "local:backup/vzdump-lxc-201-2025_10_03-02_00_00.tar.zst";
    expect((await h.send(sam, "POST", "/api/backup-tools/restore", { from: "local", volid: ct, mode: "replace" })).json.code).toBe("confirm");
    expect((await h.send(sam, "POST", "/api/backup-tools/restore", { from: "local", volid: ct, mode: "replace", confirm: "201" })).json.code).toBe("running");
    const ok = await h.send(sam, "POST", "/api/backup-tools/restore", { from: "local", volid: vm, mode: "replace", confirm: "200" });
    expect(ok.status).toBe(200);
    expect(h.calls("POST", "/nodes/pve/qemu")[0].params).toMatchObject({ vmid: "200", force: "1" });
    expect((await h.send(sam, "POST", "/api/backup-tools/restore", { from: "local", volid: "local:iso/debian.iso" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/backup-tools/restore", { from: "local", volid: vm, mode: "replace", liveRestore: true, confirm: "200" })).status).toBe(400);
  });
});

describe("disk health", () => {
  it("raises alerts for a failed disk, low wear, remapped sectors, a degraded pool and a nearly full storage", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/disk-health")).json;
    expect(r.level).toBe("critical");
    const by = (kind: string) => r.alerts.filter((a: any) => a.kind === kind);
    expect(by("disk-health").map((a: any) => a.subject)).toEqual(["/dev/sdd"]);
    expect(by("disk-wear").map((a: any) => [a.subject, a.level])).toEqual(expect.arrayContaining([["/dev/nvme0n1", "critical"]]));
    expect(by("disk-errors")[0].message).toContain("12 reallocated");
    expect(by("pool-health")[0]).toMatchObject({ subject: "rpool", level: "warning" });
    expect(by("pool-usage").map((a: any) => a.subject)).toContain("rpool");
    expect(by("storage-usage").find((a: any) => a.subject === "nas").level).toBe("critical");
    expect(by("storage-usage").some((a: any) => a.subject === "local")).toBe(false);
    // Criticals come first.
    expect(r.alerts[0].level).toBe("critical");
    expect(r.alerts.at(-1).level).toBe("warning");
    const nvme = r.disks.find((d: any) => d.devpath === "/dev/nvme0n1");
    expect(nvme.facts).toMatchObject({ temperature: 45, powerOnHours: 12345, percentUsed: 97, spare: 8 });
    expect(r.disks.find((d: any) => d.devpath === "/dev/sda").level).toBe("ok");
    expect(r.storages.find((s: any) => s.storage === "nas").percentUsed).toBe(97);
  });

  it("lets only an administrator change the alert thresholds, and checks them", async () => {
    await h.boot();
    const sam = await h.signIn();
    const lee = await h.signIn("lee");
    expect((await h.send(sam, "GET", "/api/disk-health/settings")).json.thresholds).toEqual({ wearWarn: 25, wearCrit: 10, usageWarn: 85, usageCrit: 95 });
    expect((await h.send(lee, "PUT", "/api/disk-health/settings", { wearWarn: 30, wearCrit: 5, usageWarn: 80, usageCrit: 90 })).status).toBe(403);
    expect((await h.send(sam, "PUT", "/api/disk-health/settings", { wearWarn: 5, wearCrit: 10, usageWarn: 80, usageCrit: 90 })).status).toBe(400);
    expect((await h.send(sam, "PUT", "/api/disk-health/settings", { wearWarn: 30, wearCrit: 5, usageWarn: 95, usageCrit: 90 })).status).toBe(400);
    expect((await h.send(sam, "PUT", "/api/disk-health/settings", { wearWarn: "x" })).status).toBe(400);
    expect((await h.send(sam, "PUT", "/api/disk-health/settings", { extra: 1 })).status).toBe(400);
    expect((await h.send(sam, "PUT", "/api/disk-health/settings", { wearWarn: 30, wearCrit: 5, usageWarn: 60, usageCrit: 80 })).status).toBe(200);
    const r = (await h.send(sam, "GET", "/api/disk-health")).json;
    expect(r.thresholds.usageWarn).toBe(60);
    expect(r.alerts.find((a: any) => a.subject === "local" && a.kind === "storage-usage")).toBeTruthy();
  });

  it("keeps a sample of each disk now and then, so a trend can be shown", async () => {
    await h.boot();
    const sam = await h.signIn();
    await h.send(sam, "GET", "/api/disk-health");
    await h.send(sam, "GET", "/api/disk-health");
    const r = (await h.send(sam, "GET", "/api/disk-health/history?disk=/dev/nvme0n1")).json;
    expect(r.samples).toHaveLength(1);
    expect(r.samples[0]).toMatchObject({ wear: 3, temperature: 45, hours: 12345 });
    expect((await h.send(sam, "GET", "/api/disk-health/history?disk=/dev/nope")).status).toBe(404);
    expect((await h.send(sam, "GET", "/api/disk-health/history?disk=sda")).status).toBe(400);
  });
});

describe("ZFS pools", () => {
  it("shows a pool's state, disks and the datasets and zvols the storages on it hold", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/disk-health/zfs/tank")).json;
    expect(r).toMatchObject({ name: "tank", state: "ONLINE", disks: ["sdb", "sdc"], storages: ["zfs-tank"] });
    expect(r.volumes.map((v: any) => [v.dataset, v.kind])).toEqual([["tank/subvol-201-disk-0", "dataset"], ["tank/vm-200-disk-1", "zvol"]]);
    expect((await h.send(sam, "GET", "/api/disk-health/zfs/nope")).status).toBe(404);
    expect((await h.send(sam, "GET", "/api/disk-health/zfs/mirror-0")).status).toBe(400);
    expect((await h.send(sam, "GET", "/api/disk-health/zfs/rpool")).json.state).toBe("DEGRADED");
  });

  it("builds commands for what the API cannot do, checked against the pool's real disks", async () => {
    await h.boot();
    const sam = await h.signIn();
    const g = async (q: string) => h.send(sam, "GET", `/api/disk-health/zfs/tank/guide?${q}`);
    expect((await g("action=scrub")).json.steps[0].command).toBe("zpool scrub tank");
    expect((await g("action=trim")).json.steps[0].command).toBe("zpool trim tank");
    expect((await g("action=export")).json.steps.at(-1).command).toBe("zpool export tank");
    expect((await g("action=export")).json.steps[0].note).toContain("zfs-tank");
    expect((await g("action=import&importName=oldtank")).json.steps.at(-1).command).toBe("zpool import oldtank tank");
    const rep = (await g("action=replace&device=sdb&newDevice=/dev/sdc")).json;
    expect(rep.steps[0].command).toBe("zpool replace tank sdb /dev/sdc");
    expect(rep.steps[0].risk).toBe("high");
    expect(rep.cautions.join(" ")).toContain("erased");
    expect((await g("action=replace&device=sdz&newDevice=/dev/sdc")).status).toBe(400);
    expect((await g("action=replace&device=sdb")).status).toBe(400);
    expect((await g("action=replace&device=sdb&newDevice=sdb")).status).toBe(400);
    expect((await g("action=replace&device=sdb&newDevice=/dev/sda1")).json.code).toBe("in_use");
    expect((await g("action=replace&device=sdb&newDevice=/dev/sdd")).json.code).toBe("in_use");
    expect((await g("action=attach&device=sdb&newDevice=/dev/sdc")).json.steps[0].command).toBe("zpool attach tank sdb /dev/sdc");
    expect((await g("action=detach&device=sdc")).json.steps[0].command).toBe("zpool detach tank sdc");
    expect((await g("action=scrub;reboot")).status).toBe(400);
    expect((await g("action=offline&device=sdb;reboot")).status).toBe(400);
    expect((await g("action=explode")).status).toBe(400);
  });
});
