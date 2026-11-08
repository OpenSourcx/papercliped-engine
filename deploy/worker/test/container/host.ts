// A minimal ePaperclip Worker Fabric host for deploy/worker/test/container.sh: the real hub and worker listener, a throwaway state folder,
// and a loopback-only admin socket that stands in for the console (create a pairing code, list workers, read stats, run a management action).
//   node --experimental-strip-types host.ts <state-dir> <advertised-host> [listen-port] [admin-port]
import { createServer } from "node:http";
import { FabricHub } from "../../../../services/epaperclip/src/fabric/hub.ts";
import { workerListener } from "../../../../services/epaperclip/src/fabric/listener.ts";
import { StateStore } from "../../../../services/epaperclip/src/state.ts";

const [stateDir = "/tmp/epb-host", advertised = "127.0.0.1", lp = "7843", ap = "3140"] = process.argv.slice(2);
const state = new StateStore(stateDir);
const hub = new FabricHub({ state, heartbeatMs: 3000, transports: () => [{ provider: "custom", label: "test", available: true, address: `ws://${advertised}:${lp}`, detail: "" }] });
hub.start();
workerListener(hub).listen(Number(lp), "0.0.0.0");
const body = async (r: import("node:http").IncomingMessage) => { let s = ""; for await (const c of r) s += c; return s ? JSON.parse(s) : {}; };
createServer(async (req, res) => {
  const out = (code: number, o: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  try {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/pair") { const b = await body(req); return out(200, hub.createPairing("container-test", { name: b.name ?? "ct" })); }
    if (u.pathname === "/workers") return out(200, hub.workers());
    if (u.pathname === "/stats") return out(200, hub.stats(String(u.searchParams.get("id"))));
    if (u.pathname === "/audit") return out(200, hub.auditList({ limit: 200 }).events);
    if (u.pathname === "/manage") { const b = await body(req); return out(200, { result: await hub.manage("container-test", b.id, b.action, b.params ?? {}) }); }
    out(404, {});
  } catch (e) { out(500, { error: (e as Error).message }); }
}).listen(Number(ap), "127.0.0.1", () => console.log(`host ready: workers ${lp}, admin ${ap}`));
