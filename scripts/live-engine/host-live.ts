// LIVE-check host: the real ePaperclip host service (createApp) in front of a real engine, with a FAKE Proxmox (fakePinPve:
// users sam (administrator) and lee) and the built console. Prints the address and stays up.
//   EPC_LIVE_ENGINE=http://127.0.0.1:3199 EPC_LIVE_ENGINE_DIR=/project/.work/engine-1023/tree node --experimental-strip-types scripts/live-engine/host-live.ts
import { startPinApp } from "../../services/epaperclip/test/fakes-pin.ts";

const url = process.env.EPC_LIVE_ENGINE ?? "http://127.0.0.1:3199";
const installDir = process.env.EPC_LIVE_ENGINE_DIR ?? "/project/.work/engine-1023/tree";
const app = await startPinApp({ engine: { url, publicUrl: url, installDir }, staticDir: new URL("../../apps/console/dist", import.meta.url).pathname });
console.log(`host: ${app.base}`);
setInterval(() => {}, 1 << 30);
