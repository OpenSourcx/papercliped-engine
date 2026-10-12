import { describe, expect, it } from "vitest";
import { STORAGE_DEFS, STORAGE_TYPES, bwlimitPropertyString, buildStorageParams, parseBwlimit, parsePrune, planZfs, prunePropertyString, storageDef } from "../src/storage-schema.ts";

describe("storage types", () => {
  it("covers every type Proxmox's add dialog offers, each with content it can hold", () => {
    expect(STORAGE_DEFS.map((d) => d.type).sort()).toEqual([...STORAGE_TYPES].sort());
    for (const d of STORAGE_DEFS) {
      expect(d.contents.length).toBeGreaterThan(0);
      expect(d.defaultContent.every((c) => d.contents.includes(c))).toBe(true);
      expect(new Set(d.fields.map((f) => f.key)).size).toBe(d.fields.length);
    }
  });

  it("marks credentials as write-only", () => {
    const secret = (t: string) => storageDef(t)!.fields.filter((f) => f.secret).map((f) => f.key);
    expect(secret("cifs")).toEqual(["password"]);
    expect(secret("pbs").sort()).toEqual(["encryption-key", "fingerprint", "password"]);
    expect(secret("rbd")).toEqual(["keyring"]);
  });
});

describe("building parameters", () => {
  const cifs = storageDef("cifs")!;
  it("maps a CIFS storage and its retention and limits", () => {
    const r = buildStorageParams(cifs, { server: "nas", share: "pve", username: "u", password: "p", content: ["backup", "iso"], "prune-backups": { keepLast: 3, keepWeekly: 2 }, bwlimit: { default: 1024, restore: 2048 }, nodes: ["a", "b"] }, true);
    expect(r.issues).toEqual([]);
    expect(r.params).toMatchObject({ server: "nas", content: "backup,iso", "prune-backups": "keep-last=3,keep-weekly=2", bwlimit: "default=1024,restore=2048", nodes: "a,b" });
  });

  it("refuses unknown keys, content the type can't hold and conflicting retention", () => {
    expect(buildStorageParams(cifs, { server: "nas", share: "x", content: ["images", "rootdir"].concat("nope"), rogue: 1 }, true).issues.length).toBeGreaterThanOrEqual(2);
    expect(buildStorageParams(storageDef("lvm")!, { vgname: "vg", content: ["iso"] }, true).issues[0].message).toMatch(/can't hold/);
    expect(buildStorageParams(cifs, { server: "nas", share: "x", content: ["backup"], "prune-backups": { keepAll: true, keepLast: 1 } }, true).issues[0].message).toMatch(/can't be combined/);
  });

  it("on edit keeps stored secrets, refuses creation-only fields and clears emptied settings", () => {
    const r = buildStorageParams(cifs, { password: "", domain: "", content: ["backup"], "prune-backups": null }, false);
    expect(r.issues).toEqual([]);
    expect(r.params.password).toBeUndefined();
    expect(r.remove.sort()).toEqual(["domain", "prune-backups"]);
    expect(buildStorageParams(cifs, { server: "other", content: ["backup"] }, false).issues[0].message).toMatch(/can't be changed/);
  });
});

describe("retention and limits", () => {
  it("round-trips Proxmox's strings", () => {
    expect(parsePrune("keep-last=3,keep-daily=7")).toMatchObject({ keepLast: 3, keepDaily: 7, keepAll: false });
    expect(prunePropertyString(parsePrune("keep-all=1"))).toBe("keep-all=1");
    expect(prunePropertyString({})).toBeNull();
    expect(() => prunePropertyString({ keepLast: 0 })).toThrow();
    expect(bwlimitPropertyString(parseBwlimit("default=100,move=50"))).toBe("default=100,move=50");
    expect(() => bwlimitPropertyString({ default: -1 })).toThrow();
  });
});

describe("ZFS planning", () => {
  const tb = 1e12;
  it("computes usable capacity and failure tolerance per level", () => {
    expect(planZfs("mirror", [4 * tb, 4 * tb])).toEqual({ ok: true, usableBytes: 4 * tb, tolerates: 1 });
    expect(planZfs("raid10", [tb, tb, tb, tb])).toMatchObject({ ok: true, usableBytes: 2 * tb, tolerates: 1 });
    expect(planZfs("raidz", [tb, tb, 2 * tb])).toMatchObject({ ok: true, usableBytes: 2 * tb });
    expect(planZfs("raidz2", [tb, tb, tb, tb, tb])).toMatchObject({ ok: true, usableBytes: 3 * tb, tolerates: 2 });
    expect(planZfs("single", [tb])).toMatchObject({ ok: true, tolerates: 0 });
  });
  it("rejects layouts that don't fit", () => {
    expect(planZfs("mirror", [tb])).toMatchObject({ ok: false });
    expect(planZfs("raid10", [tb, tb, tb])).toMatchObject({ ok: false });
    expect(planZfs("single", [tb, tb])).toMatchObject({ ok: false });
    expect(planZfs("draid", [tb, tb, tb, tb, tb], null)).toMatchObject({ ok: false });
    expect(planZfs("draid", [tb, tb, tb, tb, tb, tb], "data=3,spares=1")).toMatchObject({ ok: true });
    expect(planZfs("draid", [tb, tb, tb], "data=4,spares=1")).toMatchObject({ ok: false });
  });
});
