import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSigningKey, signIndex, trustedKey } from "@papercliped-engine/marketplace";
import { BUILTIN_ADAPTERS } from "../src/features/connect-adapters.ts";
import { startConnectApp, type ConnectApp } from "./fakes-connect.ts";

const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const OTHER = `sha512-${"B".repeat(86)}==`;
const signer = generateSigningKey();
let h: ConnectApp;
let registry: { integrity: string; status: number };
let published: { body: string; sig: string };

function publish(entries: unknown[], sequence = 1) {
  const body = JSON.stringify({ schema: 1, sequence, generatedAt: "2026-10-01T00:00:00Z", expires: "2027-12-01T00:00:00Z", entries });
  published = { body, sig: signIndex(Buffer.from(body), signer.privateKeyPem, signer.publicKeyPem) };
}
const entry = { id: "acme-agent", kind: "adapter", name: "Acme Agent", vendor: "Acme", summary: "Run agents with Acme.", version: "1.2.0", source: { type: "npm", name: "@acme/epc-acme-adapter", version: "1.2.0", integrity: INTEGRITY }, permissions: ["net.acme.test"] };

beforeEach(async () => {
  registry = { integrity: INTEGRITY, status: 200 };
  publish([entry]);
  h = await startConnectApp({
    market: { url: "https://catalog.example/index.json", keys: [trustedKey(signer.publicKeyPem)] },
    fetchText: async (u) => (u.endsWith(".sig") ? published.sig : published.body),
    providers: async (u) => (u.startsWith("https://registry.npmjs.org/") ? new Response(JSON.stringify({ dist: { integrity: registry.integrity } }), { status: registry.status }) : new Response("{}", { status: 404 })),
  });
});
afterEach(async () => {
  await h.closeAll();
});
const j = async (r: Response) => (await r.json()) as any;

describe("built-in adapters", () => {
  it("are exactly the engine's own list, so every one can be switched on", () => {
    const spec = JSON.parse(readFileSync(join(__dirname, "../../../packages/engine-client/spec/openapi.json"), "utf8"));
    const enums = JSON.stringify(spec).match(/"enum":\[("process"[^\]]*"claude_local"[^\]]*)\]/)![1].replace(/"/g, "").split(",");
    expect([...BUILTIN_ADAPTERS.map((a) => a.type)].sort()).toEqual([...enums].sort());
    for (const a of BUILTIN_ADAPTERS) expect(a.summary.length).toBeGreaterThan(10);
  });

  it("are listed with what the engine reports, all of them verified", async () => {
    const r = await j(await h.call("GET", "/api/connect/adapters", { cookie: h.lee }));
    expect(r.engine.ok).toBe(true);
    expect(r.adapters).toHaveLength(BUILTIN_ADAPTERS.length);
    expect(r.adapters.every((a: any) => a.verified && a.source === "builtin")).toBe(true);
    expect(r.adapters.find((a: any) => a.type === "claude_local")).toMatchObject({ registered: true, enabled: true });
    expect(r.adapters.find((a: any) => a.type === "pi_local")).toMatchObject({ registered: false, enabled: false });
    expect(r.available.map((a: any) => a.id)).toEqual(["acme-agent"]);
  });

  it("are switched on and off by administrators through the engine", async () => {
    expect((await h.call("PUT", "/api/connect/adapters/claude_local", { cookie: h.lee }, { enabled: false })).status).toBe(403);
    expect((await h.call("PUT", "/api/connect/adapters/claude_local", { cookie: h.sam }, { enabled: false })).status).toBe(200);
    expect(h.overlay.adapters.get("claude_local")!.disabled).toBe(true);
    expect(h.overlay.adapterCalls.at(-1)).toMatchObject({ method: "PATCH", body: { disabled: true } });
    expect((await j(await h.call("GET", "/api/connect/adapters", { cookie: h.sam }))).adapters.find((a: any) => a.type === "claude_local").enabled).toBe(false);
    expect((await h.call("PUT", "/api/connect/adapters/claude_local", { cookie: h.sam }, { enabled: true })).status).toBe(200);
    expect((await h.call("PUT", "/api/connect/adapters/pi_local", { cookie: h.sam }, { enabled: true })).status).toBe(404); // not registered in this engine
    expect((await h.call("PUT", "/api/connect/adapters/claude_local", { cookie: h.sam }, { enabled: "yes" })).status).toBe(400);
    expect((await h.call("PUT", "/api/connect/adapters/..%2Fx", { cookie: h.sam }, { enabled: true })).status).toBeGreaterThanOrEqual(400);
    expect((await h.call("DELETE", "/api/connect/adapters/claude_local", { cookie: h.sam })).status).toBe(400); // built in: off, not removed
  });
});

describe("adapters from the signed catalog", () => {
  it("installs through the engine once the registry confirms the signed hash, and records it as verified", async () => {
    const r = await h.call("POST", "/api/connect/adapters/install", { cookie: h.sam }, { id: "acme-agent" });
    expect(r.status).toBe(200);
    expect(h.overlay.adapterCalls.at(-1)).toMatchObject({ url: "/api/adapters/install", body: { packageName: "@acme/epc-acme-adapter", version: "1.2.0", isLocalPath: false } });
    const list = await j(await h.call("GET", "/api/connect/adapters", { cookie: h.sam }));
    expect(list.adapters.find((a: any) => a.source === "external")).toMatchObject({ verified: true, enabled: true });
    expect(list.available).toEqual([]);
    expect(JSON.stringify(await j(await h.call("GET", "/api/access/audit", { cookie: h.sam })))).toContain("adapter.install");
  });

  it("refuses a package the registry serves differently from what the catalog signed", async () => {
    registry.integrity = OTHER;
    const r = await h.call("POST", "/api/connect/adapters/install", { cookie: h.sam }, { id: "acme-agent" });
    expect(r.status).toBe(409);
    expect((await j(r)).code).toBe("integrity_mismatch");
    expect(h.overlay.adapterCalls).toEqual([]);
    registry.status = 500;
    expect((await h.call("POST", "/api/connect/adapters/install", { cookie: h.sam }, { id: "acme-agent" })).status).toBe(502);
  });

  it("installs only entries of the signed catalog, only by administrators", async () => {
    expect((await h.call("POST", "/api/connect/adapters/install", { cookie: h.sam }, { id: "evil-agent" })).status).toBe(404);
    expect((await h.call("POST", "/api/connect/adapters/install", { cookie: h.sam }, { id: "acme-agent", packageName: "evil" })).status).toBe(400);
    expect((await h.call("POST", "/api/connect/adapters/install", { cookie: h.lee }, { id: "acme-agent" })).status).toBe(403);
  });

  it("never enables an adapter that is neither built in nor from the catalog", async () => {
    h.overlay.adapters.set("sneaky", { type: "sneaky", disabled: true, packageName: "sneaky-adapter", version: "9.9.9" });
    const list = await j(await h.call("GET", "/api/connect/adapters", { cookie: h.sam }));
    expect(list.adapters.find((a: any) => a.type === "sneaky")).toMatchObject({ verified: false, source: "external", enabled: false });
    const r = await h.call("PUT", "/api/connect/adapters/sneaky", { cookie: h.sam }, { enabled: true });
    expect(r.status).toBe(403);
    expect((await j(r)).code).toBe("unverified");
    expect((await h.call("DELETE", "/api/connect/adapters/sneaky", { cookie: h.sam })).status).toBe(200); // it can be removed
  });

  it("doesn't offer anything when the catalog has a bad signature", async () => {
    publish([entry], 5);
    published.sig = signIndex(Buffer.from("tampered"), signer.privateKeyPem, signer.publicKeyPem);
    const list = await j(await h.call("GET", "/api/connect/adapters", { cookie: h.sam }));
    expect(list.available).toEqual([]);
    expect(list.marketProblem?.code).toBe("bad_signature");
    expect((await h.call("POST", "/api/connect/adapters/install", { cookie: h.sam }, { id: "acme-agent" })).status).toBe(404);
  });
});
