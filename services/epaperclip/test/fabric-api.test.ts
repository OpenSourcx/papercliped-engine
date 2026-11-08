declare global {
  interface Response {
    json(): Promise<any>;
  }
}
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startAccessApp } from "./access-harness.ts";
import { fakeCaps, newWorker, until } from "./fabric-harness.ts";
import { decodePairing } from "@papercliped-engine/worker-fabric";

/** The console API (docs/WORKER-FABRIC.md section 4) on the real host app: who may use it, the pairing and approval flow, scope and revocation. */

let h: Awaited<ReturnType<typeof startAccessApp>>;
let admin: string;
let sam: string;
const workers: ReturnType<typeof newWorker>[] = [];
beforeEach(async () => {
  h = await startAccessApp({
    fabric: { port: 7843, controlUrl: "http://127.0.0.1:3130", pluginDir: "/nonexistent", heartbeatMs: 300, netInfo: () => ({ tailscaleStatus: JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.64.1.2"], DNSName: "host.ts.net." } }), tailscaleIp: "100.64.1.2", interfaces: [{ name: "eth0", address: "192.168.1.9", family: "IPv4" }], customUrl: null }) },
  });
  admin = await h.signIn("root@pam");
  sam = await h.signIn("kim");
});
afterEach(async () => {
  for (const w of workers.splice(0)) w.client.stop();
  await h.close();
});

describe("/api/fabric", () => {
  it("is for Proxmox administrators only, and needs the page header to change anything", async () => {
    expect((await h.call("GET", "/api/fabric")).status).toBe(401);
    expect((await h.call("GET", "/api/fabric", { cookie: sam })).status).toBe(403);
    expect((await h.call("POST", "/api/fabric/pairings", { cookie: sam }, {})).status).toBe(403);
    const noHeader = await fetch(`${h.base}/api/fabric/pairings`, { method: "POST", headers: { Cookie: admin, "Content-Type": "application/json" }, body: "{}" });
    expect(noHeader.status).toBe(403);
    const r = await h.call("GET", "/api/fabric", { cookie: admin });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ enabled: true, workers: [], pending: [], pairings: [] });
    expect(j.transports.map((t: { provider: string }) => t.provider)).toEqual(["tailscale", "lan", "custom"]);
    expect(j.transports[0]).toMatchObject({ available: true, recommended: true });
  });

  it("issues a pairing code once and never shows the secret again", async () => {
    const r = await h.call("POST", "/api/fabric/pairings", { cookie: admin }, { name: "orion" });
    expect(r.status).toBe(201);
    const j = await r.json();
    const p = decodePairing(j.code);
    expect(p.urls[0]).toMatchObject({ provider: "tailscale", url: "ws://100.64.1.2:7843/fabric/v1/connect" });
    expect(j.installCommand).toContain("epaperclip-worker adopt epw1.");
    const list = JSON.stringify(await (await h.call("GET", "/api/fabric", { cookie: admin })).json());
    expect(list).not.toContain(p.secret);
    expect(list).toContain(j.id);
    expect((await h.call("DELETE", `/api/fabric/pairings/${j.id}`, { cookie: admin })).status).toBe(200);
    expect((await (await h.call("GET", "/api/fabric", { cookie: admin })).json()).pairings).toMatchObject([{ id: j.id, state: "cancelled" }]);
  });

  it("walks a worker through approval, scope, drain, disable and revocation", async () => {
    // The worker talks to the app's own hub through the real listener, as in production.
    const { workerListener } = await import("../src/fabric/listener.ts");
    const hub = (await import("../src/features/fabric.ts")).__hubFor(h.state);
    const wl = workerListener(hub);
    await new Promise<void>((r) => wl.listen(0, "127.0.0.1", r));
    const port = (wl.address() as import("node:net").AddressInfo).port;
    try {
      const w = newWorker({ name: "reference" });
      workers.push(w);
      w.client.requestAdoption(hub.hostKey().publicKey, [{ provider: "custom", url: `ws://127.0.0.1:${port}/fabric/v1/connect` }]);
      await w.client.start();
      const pend = await until(async () => (await (await h.call("GET", "/api/fabric/pending", { cookie: admin })).json()).pending[0], 8000, "pending in API");
      expect(pend).toMatchObject({ name: "reference", capabilities: { arch: "arm64" } });
      expect(pend.verification).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      const ok = await h.call("POST", `/api/fabric/pending/${pend.id}/approve`, { cookie: admin }, { name: "Orion", companies: ["co1"] });
      expect(ok.status).toBe(200);
      const id = (await until(() => hub.workers().find((x) => x.online && x.name === "Orion"), 8000, "online")).id;
      const detail = await (await h.call("GET", `/api/fabric/workers/${id}`, { cookie: admin })).json();
      expect(detail.worker).toMatchObject({ name: "Orion", state: "adopted", companies: ["co1"], capabilities: { gpu: { present: true } } });
      expect(detail.audit.map((a: { action: string }) => a.action)).toContain("worker.adopt");

      const patch = await h.call("PATCH", `/api/fabric/workers/${id}`, { cookie: admin }, { shellSlots: 3, inferenceSlots: 1, drain: true });
      expect((await patch.json()).worker).toMatchObject({ shellSlots: 3, draining: true });
      expect((await h.call("PATCH", `/api/fabric/workers/${id}`, { cookie: admin }, { shellSlots: -4 })).status).toBe(400);
      expect((await h.call("PATCH", `/api/fabric/workers/${id}`, { cookie: admin }, { companies: ["bad id!"] })).status).toBe(400);
      expect((await h.call("DELETE", `/api/fabric/workers/${id}`, { cookie: admin })).status).toBe(409);

      expect((await h.call("POST", `/api/fabric/workers/${id}/revoke`, { cookie: admin })).status).toBe(200);
      await until(() => !hub.workers()[0]!.online, 5000, "offline after revoke");
      expect((await (await h.call("GET", `/api/fabric/workers/${id}`, { cookie: admin })).json()).worker.state).toBe("revoked");
      expect((await h.call("DELETE", `/api/fabric/workers/${id}`, { cookie: admin })).status).toBe(200);
      const audit = await (await h.call("GET", "/api/fabric/audit", { cookie: admin })).json();
      expect(audit.events.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["adopt.request", "worker.adopt", "worker.update", "worker.revoke", "worker.forget"]));
      expect(JSON.stringify(audit)).not.toMatch(/fct_|PRIVATE KEY/);
      expect(fakeCaps("/x").arch).toBe("arm64");
    } finally {
      wl.closeAllConnections();
      wl.close();
    }
  });

  it("answers 404 for unknown workers and denies unknown pending requests", async () => {
    expect((await h.call("GET", "/api/fabric/workers/wrk_000000000000", { cookie: admin })).status).toBe(404);
    expect((await h.call("POST", "/api/fabric/pending/000000000000/approve", { cookie: admin }, {})).status).toBe(404);
  });
});
