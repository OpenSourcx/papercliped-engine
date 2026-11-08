/**
 * LIVE: a catalog PUBLISHED by scripts/marketplace-publish.mjs with a DEV-only key (scripts/live-engine/publish-dev-catalog.sh,
 * keys outside the repository) is fetched over HTTP and verified against a pinned public key with the same code the host uses
 * (verifyIndex), then a plugin is installed from it through the real route into a real engine. Skipped without
 * EPC_LIVE_ENGINE, EPC_LIVE_REGISTRY and EPC_DEV_CATALOG_DIR. The dev key is not a production key and is never committed.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSigningKey, trustedKey, verifyIndex, type Index } from "@papercliped-engine/marketplace";
import { HttpError } from "../../src/http.ts";
import { pluginRoutes } from "../../src/features/connect-plugins.ts";
import { registerMarket } from "../../src/features/connect-adapters.ts";
import { StateStore } from "../../src/state.ts";

const ENGINE = process.env.EPC_LIVE_ENGINE ?? "", REGISTRY = process.env.EPC_LIVE_REGISTRY ?? "", DIR = process.env.EPC_DEV_CATALOG_DIR ?? "";
const suite = ENGINE && REGISTRY && DIR ? describe : describe.skip;
let jar = ""; let server: http.Server; let url = "";
async function engine(method: string, path: string, body?: unknown) {
  const r = await fetch(ENGINE + path, { method, headers: { "Content-Type": "application/json", Origin: ENGINE, ...(jar ? { Cookie: jar } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const c = r.headers.getSetCookie?.() ?? []; if (c.length) jar = c.map((x) => x.split(";")[0]).join("; ");
  const t = await r.text(); let data: any = t; try { data = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, data };
}
const gateway = { userJson: async (_s: unknown, m: string, p: string, b?: unknown) => { const r = await engine(m, p, b); if (r.status >= 200 && r.status < 300) return r.data; throw new HttpError(r.status === 404 ? 404 : 400, "engine_rejected", r.data?.error ?? `engine ${r.status}`); } };

async function installWith(keys: ReturnType<typeof trustedKey>[], tamper = false) {
  const state = new StateStore(null);
  registerMarket(state,
    async () => {
      if (!keys.length) return { enabled: false, index: null, problem: null };
      let body = Buffer.from(await (await fetch(`${url}/index.json`)).arrayBuffer());
      const sig = await (await fetch(`${url}/index.json.sig`)).text();
      if (tamper) body = Buffer.from(body.toString().replace("Live sandbox plugin", "Evil plugin"));
      try { return { enabled: true, index: verifyIndex(body, sig, { keys }) as Index, problem: null }; }
      catch (e) { return { enabled: true, index: null, problem: { code: (e as { code?: string }).code ?? "bad", message: (e as Error).message } }; }
    },
    async (u) => { const m = /registry\.npmjs\.org\/(.+)\/(\d+\.\d+\.\d+)$/.exec(u); return fetch(`${REGISTRY}/${m![1]}/${m![2]}`); });
  let status = 0; let payload: any;
  const ctx: any = { method: "POST", path: "/api/connect/plugins/install", state, gateway, HttpError, now: () => Date.now(), session: () => ({ username: "sam@pve", apiToken: false }), asUser: async (fn: any) => fn({}, {}), isNodeAdmin: async () => true, sameSite: () => {}, readJson: async () => ({ id: "epc-live-sandbox", acceptedPermissions: ["environment.drivers.register"] }), json: (s: number, b: unknown) => { status = s; payload = b; } };
  try { await pluginRoutes(ctx); } catch (e) { if (e instanceof HttpError) return { status: e.status, body: { code: e.code } }; throw e; }
  return { status, body: payload };
}
const plugins = async () => (await engine("GET", "/api/plugins")).data as { id: string }[];

suite("a published, signed dev catalog and a pinned verification key", () => {
  beforeAll(async () => {
    server = http.createServer((req, res) => { try { const f = req.url === "/index.json" ? "index.json" : req.url === "/index.json.sig" ? "index.json.sig" : null; if (!f) { res.writeHead(404); return res.end(); } res.writeHead(200); res.end(readFileSync(join(DIR, "dist", f))); } catch { res.writeHead(500); res.end(); } });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect((await engine("POST", "/api/auth/sign-in/email", { email: "admin@test.invalid", password: "Disposable-pass-12345" })).status).toBe(200);
    for (const p of await plugins()) await engine("DELETE", `/api/plugins/${p.id}`);
  }, 30_000);
  afterAll(async () => { for (const p of await plugins()) await engine("DELETE", `/api/plugins/${p.id}`); await new Promise((r) => server?.close(r)); });

  it("installs nothing with no pinned key, with the wrong key, or from a tampered catalog; installs with the pinned dev key", async () => {
    expect((await installWith([])).body).toMatchObject({ code: "no_catalog" });
    const wrong = generateSigningKey();
    expect((await installWith([trustedKey(wrong.publicKeyPem)])).status).toBe(404); // unknown_key: the catalog offers nothing
    const pinned = trustedKey(readFileSync(join(DIR, "dev-public.pem"), "utf8"));
    expect((await installWith([pinned], true)).status).toBe(404); // bad_signature
    expect(await plugins()).toEqual([]);
    expect((await installWith([pinned])).status).toBe(200);
    expect(await plugins()).toMatchObject([{ version: "0.1.0", status: "ready" }]);
  }, 90_000);
});
