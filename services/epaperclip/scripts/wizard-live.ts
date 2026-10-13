// Serves the built console and the real host service against the wizard's fake Proxmox, for screenshots and manual
// checks of the creation wizards in live mode. Not a test and not shipped: `node --experimental-strip-types scripts/wizard-live.ts`.
//   PORT (default 4480)   EPC_STATIC (default ../../apps/console/dist)
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { fakePve } from "../test/fakes.ts";
import { fakeWizard } from "../test/fakes-wizard.ts";

const port = Number(process.env.PORT ?? 4480);
const pve = fakeWizard(fakePve().transport);
const app = createApp({
  pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport },
  sessions: new SessionStore(),
  staticDir: resolve(process.env.EPC_STATIC ?? "../../apps/console/dist"),
  secureCookies: false,
});
// Dev only: what the fake Proxmox has been asked to create (secrets removed), so a browser run can check the result.
const secret = ["password", "cipassword", "ssh-public-keys", "sshkeys"];
createServer((req, res) => {
  if (req.url === "/__created") {
    const out = [...pve.created].map(([vmid, c]) => ({ vmid, type: c.type, params: Object.fromEntries(Object.entries(c.params).map(([k, v]) => [k, secret.includes(k) ? "(set)" : v])) }));
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
  }
  return app(req, res);
}).on("upgrade", app.upgrade).listen(port, "127.0.0.1", () => console.log(`wizard-live: http://127.0.0.1:${port} (sign in as sam, realm pve, password "right")`));
