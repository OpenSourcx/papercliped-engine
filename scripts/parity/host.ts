// The real ePaperclip host service (createApp) in front of the real parity engine, with PERSISTENT host state (so the engine
// accounts the host created survive a host restart). Proxmox is the repo's FAKE (fakePinPve: users sam administrator, lee), so
// everything Proxmox-shaped here is "simulated"; everything engine-shaped is real.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createApp } from "../../services/epaperclip/src/app.ts";
import { SessionStore } from "../../services/epaperclip/src/sessions.ts";
import { StateStore } from "../../services/epaperclip/src/state.ts";
import { fakePinPve } from "../../services/epaperclip/test/fakes-pin.ts";

const url = process.env.EPC_LIVE_ENGINE ?? "http://127.0.0.1:3291";
const installDir = process.env.EPC_LIVE_ENGINE_DIR ?? "/project/.work/engine-1023/tree";
const staticDir = process.env.EPC_CONSOLE_DIST ?? new URL("../../apps/console/dist", import.meta.url).pathname;
const stateDir = process.env.EPC_HOST_STATE ?? "/project/.work/parity/epc/state";
mkdirSync(stateDir, { recursive: true });
const pve = fakePinPve();
const now = () => Date.now();
const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(now), staticDir, secureCookies: false, state: new StateStore(stateDir), now, fetch: async () => new Response("{}", { status: 404 }), engine: { url, publicUrl: url, installDir } });
const server = createServer(app);
server.on("upgrade", app.upgrade);
const port = Number(process.env.EPC_HOST_PORT ?? 3292);
await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
console.log(`host: ${base}`);
writeFileSync(process.env.EPC_HOST_URL_FILE ?? "/project/.work/parity/epc/host.url", base);
setInterval(() => {}, 1 << 30);
