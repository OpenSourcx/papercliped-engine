/**
 * LIVE: the host's plugin install/upgrade/revoke route (src/features/connect-plugins.ts) against a real Paperclip engine
 * (2026.1023.0) and a local npm registry serving a real plugin package at two versions. Skipped unless EPC_LIVE_ENGINE and
 * EPC_LIVE_REGISTRY are set (docs/PLUGIN-CATALOG.md, "Live check"). The route runs unmodified; only the request plumbing
 * (session, Proxmox admin check) is stubbed, and the catalog is signed and verified with the real marketplace code.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSigningKey, signIndex, trustedKey, verifyIndex, type Index } from "@papercliped-engine/marketplace";
import { HttpError } from "../../src/http.ts";
import { pluginRoutes } from "../../src/features/connect-plugins.ts";
import { registerMarket } from "../../src/features/connect-adapters.ts";
import { StateStore } from "../../src/state.ts";

const ENGINE = process.env.EPC_LIVE_ENGINE ?? "";
const REGISTRY = process.env.EPC_LIVE_REGISTRY ?? "";
const suite = ENGINE && REGISTRY ? describe : describe.skip;
const NAME = "@epc-live/plugin-proxmox-sandbox";

let jar = "";
async function engine(method: string, path: string, body?: unknown) {
  const r = await fetch(ENGINE + path, { method, headers: { "Content-Type": "application/json", Origin: ENGINE, ...(jar ? { Cookie: jar } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) jar = sc.map((c) => c.split(";")[0]).join("; ");
  const t = await r.text(); let data: any = t; try { data = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, data };
}
const gateway = { userJson: async (_s: unknown, method: string, path: string, body?: unknown) => {
  const r = await engine(method, path, body);
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new HttpError(r.status === 404 ? 404 : r.status === 403 ? 403 : 400, "engine_rejected", r.data?.error ?? `engine ${r.status}`);
} };

const state = new StateStore(null);
const signer = generateSigningKey();
let sequence = 0;
let entries: unknown[] = [];
let pinned = true;
let clock = Date.now();
const integrityOf = async (v: string) => { const m = await (await fetch(`${REGISTRY}/${encodeURIComponent(NAME)}`)).json() as any; return m.versions[v].dist.integrity as string; };
const entry = async (version: string, over: Record<string, unknown> = {}) => ({ id: "epc-live-sandbox", kind: "plugin", name: "Live sandbox plugin", vendor: "ePaperclip tests", summary: "A real plugin package served by a local registry.", version, source: { type: "npm", name: NAME, version, integrity: await integrityOf(version) }, permissions: ["environment.drivers.register"], ...over });
// A loader like app.ts's loadMarket: the index is signed and verified with the real marketplace code every time.
registerMarket(state,
  async () => {
    if (!pinned) return { enabled: false, index: null, problem: null };
    const body = Buffer.from(JSON.stringify({ schema: 1, sequence: ++sequence, generatedAt: new Date(clock).toISOString(), expires: new Date(clock + 86_400_000).toISOString(), entries }));
    const index: Index = verifyIndex(body, signIndex(body, signer.privateKeyPem, signer.publicKeyPem), { keys: [trustedKey(signer.publicKeyPem)], now: clock });
    return { enabled: true, index, problem: null };
  },
  // The route checks https://registry.npmjs.org/<name>/<version>; this serves the same document from the local registry.
  async (url) => { const m = /registry\.npmjs\.org\/(.+)\/(\d+\.\d+\.\d+)$/.exec(url); if (!m) return new Response("{}", { status: 404 }); const meta = await (await fetch(`${REGISTRY}/${m[1]!.replace("%2F", "%2f")}`)).json() as any; return new Response(JSON.stringify(meta.versions[m[2]!] ?? {}), { status: meta.versions[m[2]!] ? 200 : 404 }); },
);

/** One request through the real route. */
async function route(method: string, path: string, body?: Record<string, unknown>) {
  let status = 0; let payload: any;
  const ctx: any = {
    method, path, state, gateway, HttpError, now: () => clock,
    session: () => ({ username: "sam@pve", apiToken: false }),
    asUser: async (fn: (pve: unknown, s: unknown) => Promise<unknown>) => fn({}, {}),
    isNodeAdmin: async () => true,
    sameSite: () => {},
    readJson: async () => body ?? {},
    json: (s: number, b: unknown) => { status = s; payload = b; },
  };
  try { const handled = await pluginRoutes(ctx); expect(handled).toBe(true); }
  catch (e) { if (e instanceof HttpError) return { status: e.status, body: { code: e.code, error: e.message } }; throw e; }
  return { status, body: payload };
}
const enginePlugins = async () => (await engine("GET", "/api/plugins")).data as { id: string; version: string; status: string; packageName: string }[];

suite("plugin install, upgrade and revoke against a real engine", () => {
  beforeAll(async () => {
    const r = await engine("POST", "/api/auth/sign-in/email", { email: "admin@test.invalid", password: "Disposable-pass-12345" });
    expect(r.status).toBe(200);
    for (const p of await enginePlugins()) await engine("DELETE", `/api/plugins/${p.id}`);
  }, 30_000);
  afterAll(async () => { for (const p of await enginePlugins()) await engine("DELETE", `/api/plugins/${p.id}`); });

  it("is fail-closed with no pinned key, then installs nothing without exactly the declared permissions", async () => {
    entries = [await entry("0.1.0")];
    pinned = false;
    expect((await route("POST", "/api/connect/plugins/install", { id: "epc-live-sandbox", acceptedPermissions: ["environment.drivers.register"] })).body).toMatchObject({ code: "no_catalog" });
    pinned = true;
    expect((await route("POST", "/api/connect/plugins/install", { id: "epc-live-sandbox", acceptedPermissions: [] })).body).toMatchObject({ code: "consent_required" });
    expect(await enginePlugins()).toEqual([]);
  }, 30_000);

  it("refuses a catalog entry whose hash the registry does not serve, leaving the engine untouched", async () => {
    entries = [await entry("0.1.0", { source: { type: "npm", name: NAME, version: "0.1.0", integrity: `sha512-${createHash("sha512").update("not it").digest("base64")}` } })];
    const r = await route("POST", "/api/connect/plugins/install", { id: "epc-live-sandbox", acceptedPermissions: ["environment.drivers.register"] });
    expect(r.body).toMatchObject({ code: "integrity_mismatch" });
    expect(await enginePlugins()).toEqual([]);
  }, 30_000);

  it("installs through the real engine, upgrades to a newer version, refuses to go back (the engine itself would allow it), and revokes", async () => {
    entries = [await entry("0.1.0")];
    expect((await route("POST", "/api/connect/plugins/install", { id: "epc-live-sandbox", acceptedPermissions: ["environment.drivers.register"] })).status).toBe(200);
    expect(await enginePlugins()).toMatchObject([{ packageName: NAME, version: "0.1.0", status: "ready" }]);
    let list = (await route("GET", "/api/connect/plugins")).body;
    expect(list.plugins[0]).toMatchObject({ verified: true, catalogId: "epc-live-sandbox", grantedPermissions: ["environment.drivers.register"] });

    // Nothing newer yet.
    expect((await route("POST", "/api/connect/plugins/epc-live-sandbox/upgrade", {})).body).toMatchObject({ code: "not_newer" });
    // A newer version appears in the signed catalog and the registry.
    await fetch(`${REGISTRY}/admin/show/0.2.0`);
    entries = [await entry("0.2.0")];
    list = (await route("GET", "/api/connect/plugins")).body;
    expect(list.updates).toMatchObject([{ id: "epc-live-sandbox", from: "0.1.0", to: "0.2.0", needsConsent: false }]);
    expect((await route("POST", "/api/connect/plugins/epc-live-sandbox/upgrade", {})).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await enginePlugins()).toMatchObject([{ version: "0.2.0", status: "ready" }]);
    // Going back: the catalog now offers 0.1.0 again (a rollback of the catalog); the host refuses.
    entries = [await entry("0.1.0")];
    expect((await route("POST", "/api/connect/plugins/epc-live-sandbox/upgrade", {})).body).toMatchObject({ code: "not_newer" });
    expect(await enginePlugins()).toMatchObject([{ version: "0.2.0" }]);

    // Revoke.
    expect((await route("DELETE", "/api/connect/plugins/epc-live-sandbox")).status).toBe(200);
    expect(await enginePlugins()).toEqual([]);
    expect((await route("GET", "/api/connect/plugins")).body.available.map((a: any) => a.id)).toEqual(["epc-live-sandbox"]);
    await fetch(`${REGISTRY}/admin/hide/0.2.0`);
  }, 120_000);
});
