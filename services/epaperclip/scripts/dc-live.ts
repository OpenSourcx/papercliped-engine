// Serves the built console and the real host service against the fake Proxmox for the hardware, backup, SDN and
// mapping screens, for screenshots. Not a test and not shipped: `node --experimental-strip-types scripts/dc-live.ts`.
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { fakeDcPve } from "../test/fakes-dc.ts";

const port = Number(process.env.PORT ?? 4481);
const pve = fakeDcPve();
const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(), staticDir: resolve(process.env.EPC_STATIC ?? "../../apps/console/dist"), secureCookies: false });
createServer(app).on("upgrade", app.upgrade).listen(port, "127.0.0.1", () => console.log(`dc-live: http://127.0.0.1:${port}`));
