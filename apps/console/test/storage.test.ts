import { describe, expect, it } from "vitest";
import { demoBackend } from "../src/data/backend.ts";
import { demoData } from "../src/data/demo.ts";
import { fileNameError, nameFromUrl, tabsFor, volName } from "../src/pages/storage/content.ts";

const storages = demoData(null).host.storage;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("storage content helpers", () => {
  it("shows tabs for what each storage holds, in Proxmox's order", () => {
    const drive2 = storages.find((s) => s.id === "drive2");
    expect(tabsFor(drive2).map((t) => t.kind)).toEqual(["iso", "vztmpl", "backup", "images", "rootdir", "snippets"]);
    expect(tabsFor(undefined)).toEqual([]);
  });

  it("names volumes and checks file names like Proxmox does", () => {
    expect(volName("local:iso/debian.iso")).toBe("debian.iso");
    expect(volName("drive2:109/vm-109-disk-0.qcow2")).toBe("vm-109-disk-0.qcow2");
    expect(fileNameError("debian-13.iso", "iso")).toBeNull();
    expect(fileNameError("a.exe", "iso")).not.toBeNull();
    expect(fileNameError("debian.tar.zst", "vztmpl")).toBeNull();
    expect(fileNameError("../x.iso", "iso")).not.toBeNull();
    expect(nameFromUrl("https://cdimage.debian.org/a/debian-13.1.0-amd64-netinst.iso?x=1")).toBe("debian-13.1.0-amd64-netinst.iso");
    expect(nameFromUrl("not a url")).toBe("");
  });
});

describe("demo storage backend", () => {
  it("lists, downloads and deletes, with tasks that finish", async () => {
    const b = demoBackend(() => storages);
    const before = await b.content("drive2", "vztmpl");
    const { task } = await b.downloadTemplate("drive2", "alpine-3.22-default_20250617_amd64.tar.xz");
    expect((await b.task(task)).status).toBe("running");
    await expect(b.downloadTemplate("drive2", before.map((i) => volName(i.volid))[0])).rejects.toThrow(/exists/);
    const del = await b.deleteVolume("drive2", before[0].volid);
    expect(del.task).toMatch(/^UPID:demo:/);
    expect((await b.content("drive2", "vztmpl")).length).toBe(before.length - 1);
    expect((await b.tasks()).map((t) => t.type)).toEqual(["imgdel", "download"]);
  });

  it("finishes uploads and adds the file", async () => {
    const b = demoBackend(() => storages);
    const file = new File(["iso"], "tiny.iso");
    const seen: number[] = [];
    const { task } = await b.upload("local", "iso", file, (f) => seen.push(f));
    expect(seen.at(-1)).toBe(1);
    await wait(900);
    expect((await b.task(task)).exitstatus).toBe("OK");
    expect((await b.content("local", "iso")).some((i) => i.volid === "local:iso/tiny.iso")).toBe(true);
  }, 5000);
});

describe("task ids", () => {
  it("reads ids that contain colons", async () => {
    const { parseUpid } = await import("../src/data/backend.ts");
    expect(parseUpid("UPID:pve:00000004:00000000:6ACBAE9F:imgdel:local:iso/a.iso:root@pam:")).toEqual({ node: "pve", type: "imgdel", id: "local:iso/a.iso", user: "root@pam" });
    expect(parseUpid("UPID:pve:1:2:3:qmstart:109:root@pam:")?.id).toBe("109");
    expect(parseUpid("nope")).toBeNull();
  });
});
