// The real ePaperclip host service (createApp) in front of the real parity engine. Proxmox is the repo's FAKE (fakePinPve:
// users sam (administrator) and lee), so everything Proxmox-shaped here is "simulated"; everything engine-shaped is real.
//   EPC_LIVE_ENGINE=http://127.0.0.1:3291 EPC_LIVE_ENGINE_DIR=<paperclipai install> node --experimental-strip-types scripts/parity/host.ts
import { writeFileSync } from "node:fs";
import { startPinApp } from "../../services/epaperclip/test/fakes-pin.ts";

const url = process.env.EPC_LIVE_ENGINE ?? "http://127.0.0.1:3291";
const installDir = process.env.EPC_LIVE_ENGINE_DIR ?? "/project/.work/engine-1023/tree";
const staticDir = process.env.EPC_CONSOLE_DIST ?? new URL("../../apps/console/dist", import.meta.url).pathname;
const app = await startPinApp({ engine: { url, publicUrl: url, installDir }, staticDir });
console.log(`host: ${app.base}`);
writeFileSync(process.env.EPC_HOST_URL_FILE ?? "/project/.work/parity/epc/host.url", app.base);
setInterval(() => {}, 1 << 30);
