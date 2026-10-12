import { describe, expect, it } from "vitest";
import { buildStoreItems, filterItems, tileHue } from "../src/pages/store/catalog.ts";
import { demoBackend } from "../src/data/backend.ts";

const base = { catalog: [], isoFiles: {}, tplFiles: {}, latest: {}, installedPlugins: new Set<string>() };
const latestDebian = { id: "debian", version: "13.7.0", filename: "debian-13.7.0-amd64-netinst.iso", url: "https://x/d.iso", checksum: "a".repeat(64), algorithm: "sha256" as const };

describe("the Store's catalog", () => {
  it("lists every system as not installed when nothing is on the drives", () => {
    const items = buildStoreItems(base);
    expect(items.find((i) => i.id === "debian")?.status).toBe("available");
    expect(items.find((i) => i.id === "windows-11")?.status).toBe("manual");
    expect(items.find((i) => i.id === "github")?.status).toBe("available");
  });

  it("recognises an installer on a drive, and an older one as an update", () => {
    const have = buildStoreItems({ ...base, isoFiles: { local: ["debian-13.7.0-amd64-netinst.iso"] }, latest: { debian: latestDebian } });
    expect(have.find((i) => i.id === "debian")).toMatchObject({ status: "installed", volid: "local:iso/debian-13.7.0-amd64-netinst.iso" });
    const old = buildStoreItems({ ...base, isoFiles: { local: ["debian-12.5.0-amd64-netinst.iso"] }, latest: { debian: latestDebian } });
    expect(old.find((i) => i.id === "debian")).toMatchObject({ status: "update", haveVersion: "12.5.0", latestVersion: "13.7.0" });
  });

  it("sorts container templates into apps and systems", () => {
    const items = buildStoreItems({ ...base, tplFiles: { local: ["debian-12-standard_12.7-1_amd64.tar.zst"] }, catalog: [
      { template: "debian-12-standard_12.7-1_amd64.tar.zst", headline: "Debian 12", description: null, os: "debian", version: "12.7-1", section: "system", infopage: null },
      { template: "debian-12-turnkey-nextcloud_18.1_amd64.tar.gz", headline: "Nextcloud", description: null, os: "debian", version: "18.1", section: "turnkeylinux", infopage: null },
    ] });
    expect(items.find((i) => i.id === "ct:debian-12-standard_12.7-1_amd64.tar.zst")).toMatchObject({ category: "os", status: "installed", volid: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst" });
    expect(items.find((i) => i.name === "Nextcloud")).toMatchObject({ category: "app", status: "available" });
  });

  it("marks installed plugins and filters by section and search", () => {
    const items = buildStoreItems({ ...base, installedPlugins: new Set(["codex_local"]) });
    expect(items.find((i) => i.id === "codex_local")?.status).toBe("installed");
    expect(filterItems(items, "plugin", "").every((i) => i.category === "plugin")).toBe(true);
    expect(filterItems(items, "home", "ALPINE").map((i) => i.id)).toEqual(["alpine"]);
    expect(filterItems(items, "os", "nothing-like-this")).toEqual([]);
  });

  it("gives a name the same colour every time", () => {
    expect(tileHue("Debian")).toBe(tileHue("Debian"));
    expect(tileHue("Debian")).toBeGreaterThanOrEqual(0);
  });
});

describe("the demo's installer lookup", () => {
  it("answers for automatic systems and refuses the rest", async () => {
    const b = demoBackend(() => []);
    expect((await b.libraryLatest("alpine")).filename).toMatch(/^alpine-virt-/);
    await expect(b.libraryLatest("windows-11")).rejects.toThrow();
  });
});
