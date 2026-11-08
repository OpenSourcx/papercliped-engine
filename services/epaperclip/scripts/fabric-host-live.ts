// LIVE-check Worker Fabric host: the real hub, worker listener and control listener, with the state in a disposable folder, in front of a
// disposable real engine (2026.1023.0). Not a service. A loopback-only admin socket stands in for the console, for scripts.
//   EPC_LIVE_ENGINE=http://127.0.0.1:3198 EPC_FABRIC_STATE=/project/.work/wf-live/host-state \
//   node --experimental-strip-types scripts/fabric-host-live.ts
// Env: EPC_FABRIC_LISTEN (default 0.0.0.0:7843), EPC_FABRIC_CONTROL (default 127.0.0.1:3130), EPC_FABRIC_ADMIN (default 127.0.0.1:3131),
//      EPC_LIVE_ADMIN_EMAIL / EPC_LIVE_ADMIN_PASSWORD (the disposable engine's throwaway admin).
import { createServer } from "node:http";
import { FabricHub } from "../src/fabric/hub.ts";
import { FabricEnvironments } from "../src/fabric/engine.ts";
import { controlListener, workerListener } from "../src/fabric/listener.ts";
import { realNetInfo } from "../src/fabric/net.ts";
import { StateStore } from "../src/state.ts";
import { detectTransports } from "@papercliped-engine/worker-fabric";

const engine = process.env.EPC_LIVE_ENGINE ?? "http://127.0.0.1:3198";
const email = process.env.EPC_LIVE_ADMIN_EMAIL ?? "admin@test.invalid";
const password = process.env.EPC_LIVE_ADMIN_PASSWORD ?? "Disposable-pass-12345";
const hp = (v: string) => { const i = v.lastIndexOf(":"); return { host: v.slice(0, i), port: Number(v.slice(i + 1)) }; };
const listen = hp(process.env.EPC_FABRIC_LISTEN ?? "0.0.0.0:7843");
const control = hp(process.env.EPC_FABRIC_CONTROL ?? "127.0.0.1:3130");
const admin = hp(process.env.EPC_FABRIC_ADMIN ?? "127.0.0.1:3131");

let jar = "";
async function eng(method: string, path: string, body?: unknown) {
  const r = await fetch(engine + path, { method, headers: { "Content-Type": "application/json", Origin: engine, ...(jar ? { Cookie: jar } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie(); if (sc.length) jar = sc.map((c) => c.split(";")[0]).join("; ");
  const t = await r.text(); let j: unknown = t; try { j = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, body: j };
}
await eng("POST", "/api/auth/sign-in/email", { email, password });
// The same shape the host service's engine gateway has.
const gateway = { async serviceJson(method: string, path: string, body?: unknown) { const r = await eng(method, path, body); if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body; } };

const state = new StateStore(process.env.EPC_FABRIC_STATE ?? "/project/.work/wf-live/host-state");
const net = () => realNetInfo(process.env.EPC_FABRIC_PUBLIC_URL ?? null);
const hub = new FabricHub({ state, transports: () => detectTransports(net(), listen.port), heartbeatMs: Number(process.env.EPC_FABRIC_HB_MS ?? 10_000) });
hub.start();
const envs = new FabricEnvironments({ gateway: gateway as never, hub, state, pluginDir: process.env.EPC_FABRIC_PLUGIN_DIR ?? new URL("../../../plugins/remote-worker", import.meta.url).pathname, controlUrl: `http://${control.host}:${control.port}` });

const wl = workerListener(hub); wl.listen(listen.port, listen.host, () => console.log(`workers connect to ${listen.host}:${listen.port}`));
const cl = controlListener(hub); cl.listen(control.port, control.host, () => console.log(`control on ${control.host}:${control.port}`));

const read = async (req: import("node:http").IncomingMessage) => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return c.length ? JSON.parse(Buffer.concat(c).toString()) : {}; };
createServer(async (req, res) => {
  const send = (s: number, b: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  try {
    const p = (req.url ?? "").split("?")[0]; const b = req.method === "POST" ? await read(req) : {};
    if (p === "/workers") return send(200, { workers: hub.workers(), pending: hub.pendingList(), leases: hub.leases(), pairings: hub.pairings() });
    if (p === "/pair") return send(200, hub.createPairing("live-test", { name: b.name, companies: b.companies ?? null, transport: b.transport ?? null }));
    if (p === "/approve") return send(200, hub.approvePending("live-test", b.id, b) ?? { ok: true });
    if (p === "/revoke") return send(200, hub.revoke("live-test", b.id) ?? { ok: true });
    if (p === "/env") return send(200, await envs.create(b));
    if (p === "/transports") return send(200, detectTransports(net(), listen.port));
    if (p === "/audit") return send(200, hub.auditList({ limit: 200 }));
    if (p === "/hostkey") return send(200, hub.hostKey());
    if (p === "/token") return send(200, { token: hub.issueControlToken(b.companyId) });
    send(404, {});
  } catch (e) { send(500, { error: (e as Error).message }); }
}).listen(admin.port, admin.host, () => console.log(`admin on ${admin.host}:${admin.port} (loopback only)`));
setInterval(() => {}, 1 << 30);
