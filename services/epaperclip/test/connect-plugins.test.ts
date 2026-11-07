import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSigningKey, signIndex, trustedKey } from "@papercliped-engine/marketplace";
import { startConnectApp, type ConnectApp } from "./fakes-connect.ts";

const I1 = `sha512-${"A".repeat(86)}==`;
const I2 = `sha512-${"C".repeat(86)}==`;
const signer = generateSigningKey();
let h: ConnectApp;
let registry: Record<string, string>;
let published: { body: string; sig: string };
const plugin = (over: Record<string, unknown> = {}) => ({ id: "acme-tools", kind: "plugin", name: "Acme Tools", vendor: "Acme", summary: "Adds Acme tools to the engine.", version: "1.0.0", source: { type: "npm", name: "@acme/epc-tools", version: "1.0.0", integrity: I1 }, permissions: ["net.acme.test", "secrets.read"], ...over });
function publish(entries: unknown[], sequence = 1) {
  const body = JSON.stringify({ schema: 1, sequence, generatedAt: "2026-10-01T00:00:00Z", expires: "2027-12-01T00:00:00Z", entries });
  published = { body, sig: signIndex(Buffer.from(body), signer.privateKeyPem, signer.publicKeyPem) };
}
const start = (keys = [trustedKey(signer.publicKeyPem)]) => startConnectApp({
  market: { url: "https://catalog.example/index.json", keys },
  fetchText: async (u) => (u.endsWith(".sig") ? published.sig : published.body),
  providers: async (u) => { const m = /registry\.npmjs\.org\/.+\/(\d+\.\d+\.\d+)$/.exec(u); return m ? new Response(JSON.stringify({ dist: { integrity: registry[m[1]!] } })) : new Response("{}", { status: 404 }); },
});
beforeEach(async () => { registry = { "1.0.0": I1, "1.1.0": I2, "2.0.0": I2 }; publish([plugin()]); h = await start(); });
afterEach(async () => { await h.closeAll(); });
const j = async (r: Response) => (await r.json()) as any;
const post = (path: string, body: unknown, cookie = h.sam) => h.call("POST", path, { cookie }, body);
const PERMS = ["net.acme.test", "secrets.read"];

describe("plugins from the signed catalog", () => {
  it("lists what is available with its declared permissions, and says plainly that they are declarations", async () => {
    const r = await j(await h.call("GET", "/api/connect/plugins", { cookie: h.sam }));
    expect(r.available).toMatchObject([{ id: "acme-tools", permissions: PERMS }]);
    expect(r.catalog.trusted).toBe(true);
    expect(r.note).toMatch(/declares/);
    expect(r.plugins.find((p: any) => p.id === "pl-preexisting")).toMatchObject({ verified: false });
  });

  it("will not install without exactly the declared permissions being accepted, and changes nothing", async () => {
    for (const accepted of [undefined, [], ["net.acme.test"], [...PERMS, "extra"], "all"]) {
      const r = await post("/api/connect/plugins/install", { id: "acme-tools", acceptedPermissions: accepted });
      expect(r.status).toBe(409);
      expect((await j(r)).code).toBe("consent_required");
    }
    expect(h.overlay.pluginCalls).toEqual([]);
  });

  it("installs for an administrator after consent and a matching registry hash, recording what was granted", async () => {
    expect((await post("/api/connect/plugins/install", { id: "acme-tools", acceptedPermissions: PERMS }, h.lee)).status).toBe(403);
    const r = await post("/api/connect/plugins/install", { id: "acme-tools", acceptedPermissions: [...PERMS].reverse() });
    expect(r.status).toBe(200);
    expect(h.overlay.pluginCalls.at(-1)).toMatchObject({ url: "/api/plugins/install", body: { packageName: "@acme/epc-tools", version: "1.0.0", isLocalPath: false } });
    const list = await j(await h.call("GET", "/api/connect/plugins", { cookie: h.sam }));
    expect(list.plugins.find((p: any) => p.packageName === "@acme/epc-tools")).toMatchObject({ verified: true, catalogId: "acme-tools", grantedPermissions: PERMS });
    expect(list.available).toEqual([]);
    expect((await post("/api/connect/plugins/install", { id: "acme-tools", acceptedPermissions: PERMS })).status).toBe(409);
    expect(JSON.stringify(await j(await h.call("GET", "/api/access/audit", { cookie: h.sam })))).toContain("plugin.install");
  });

  it("refuses a package the registry serves differently from what the catalog signed", async () => {
    registry["1.0.0"] = I2;
    const r = await post("/api/connect/plugins/install", { id: "acme-tools", acceptedPermissions: PERMS });
    expect(r.status).toBe(409);
    expect((await j(r)).code).toBe("integrity_mismatch");
    expect(h.overlay.pluginCalls).toEqual([]);
  });

  it("upgrades only to a newer version; asks again only when permissions grow; checks the new hash", async () => {
    await post("/api/connect/plugins/install", { id: "acme-tools", acceptedPermissions: PERMS });
    const v = (version: string, integrity: string, permissions: string[]) => plugin({ version, source: { type: "npm", name: "@acme/epc-tools", version, integrity }, permissions });
    const later = () => { h.clock.t += 2 * 3600_000; };
    expect((await post("/api/connect/plugins/acme-tools/upgrade", {})).status).toBe(409); // nothing newer
    // Fewer permissions: no new consent needed, and the recorded grant shrinks.
    publish([v("1.1.0", I2, ["net.acme.test"])], 2); later();
    const list = await j(await h.call("GET", "/api/connect/plugins", { cookie: h.sam }));
    expect(list.updates).toEqual([{ id: "acme-tools", from: "1.0.0", to: "1.1.0", permissions: ["net.acme.test"], needsConsent: false }]);
    expect((await post("/api/connect/plugins/acme-tools/upgrade", {})).status).toBe(200);
    expect(h.overlay.pluginCalls.at(-1)).toMatchObject({ method: "POST", body: { version: "1.1.0" } });
    expect([...h.overlay.plugins.values()].find((p: any) => p.packageName === "@acme/epc-tools")).toMatchObject({ version: "1.1.0" });
    expect((await j(await h.call("GET", "/api/connect/plugins", { cookie: h.sam }))).plugins.find((p: any) => p.catalogId === "acme-tools").grantedPermissions).toEqual(["net.acme.test"]);
    // A new permission needs consent to the full new list.
    publish([v("2.0.0", I2, ["net.acme.test", "fs.write"])], 3); later();
    const need = await post("/api/connect/plugins/acme-tools/upgrade", { acceptedPermissions: ["net.acme.test"] });
    expect(need.status).toBe(409);
    expect((await j(need)).code).toBe("consent_required");
    expect((await post("/api/connect/plugins/acme-tools/upgrade", { acceptedPermissions: ["fs.write", "net.acme.test"] })).status).toBe(200);
    // A hash the registry does not serve is refused.
    publish([v("2.1.0", I1, ["net.acme.test", "fs.write"])], 4); later(); registry["2.1.0"] = I2;
    const bad = await post("/api/connect/plugins/acme-tools/upgrade", { acceptedPermissions: ["fs.write", "net.acme.test"] });
    expect((await j(bad)).code).toBe("integrity_mismatch");
    expect([...h.overlay.plugins.values()].find((p: any) => p.packageName === "@acme/epc-tools")).toMatchObject({ version: "2.0.0" });
  });

  it("revokes through the engine and forgets the grant; unverified plugins can be removed but never switched on", async () => {
    await post("/api/connect/plugins/install", { id: "acme-tools", acceptedPermissions: PERMS });
    expect((await h.call("DELETE", "/api/connect/plugins/acme-tools", { cookie: h.lee })).status).toBe(403);
    expect((await h.call("DELETE", "/api/connect/plugins/acme-tools", { cookie: h.sam })).status).toBe(200);
    expect([...h.overlay.plugins.values()].some((p: any) => p.packageName === "@acme/epc-tools")).toBe(false);
    const list = await j(await h.call("GET", "/api/connect/plugins", { cookie: h.sam }));
    expect(list.available.map((a: any) => a.id)).toEqual(["acme-tools"]);
    const enable = await post("/api/connect/plugins/pl-preexisting/enable", {});
    expect(enable.status).toBe(403);
    expect((await j(enable)).code).toBe("unverified");
    expect((await post("/api/connect/plugins/pl-preexisting/disable", {})).status).toBe(200);
    expect((await h.call("DELETE", "/api/connect/plugins/pl-preexisting", { cookie: h.sam })).status).toBe(200);
  });

  it("offers nothing when the catalog has a bad signature, and nothing at all when no key is pinned", async () => {
    published.sig = signIndex(Buffer.from("tampered"), signer.privateKeyPem, signer.publicKeyPem);
    const list = await j(await h.call("GET", "/api/connect/plugins", { cookie: h.sam }));
    expect(list.available).toEqual([]);
    expect((await post("/api/connect/plugins/install", { id: "acme-tools", acceptedPermissions: PERMS })).status).toBe(404);
    await h.closeAll();
    h = await start([]);
    const none = await post("/api/connect/plugins/install", { id: "acme-tools", acceptedPermissions: PERMS });
    expect(none.status).toBe(409);
    expect((await j(none)).code).toBe("no_catalog");
    expect((await j(await h.call("GET", "/api/connect/plugins", { cookie: h.sam }))).catalog.trusted).toBe(false);
  });

  it("rejects odd ids and extra fields", async () => {
    expect((await post("/api/connect/plugins/install", { id: "../x", acceptedPermissions: [] })).status).toBe(400);
    expect((await post("/api/connect/plugins/install", { id: "acme-tools", acceptedPermissions: PERMS, packageName: "evil" })).status).toBe(400);
  });
});
