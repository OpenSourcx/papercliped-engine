// Stand-in for the host service in deploy/test/run.sh: plain http on EPC_LISTEN, answering /api/health and /api/realms.
// /api/health also reports the settings the unit is meant to give it, so the tests can check the unit file.
import { createServer } from "node:http";

const failUnderSystemd = false; // run.sh flips this to make a version that test-starts fine but fails as a service
if (failUnderSystemd && process.env.INVOCATION_ID) process.exit(1);

const listen = process.env.EPC_LISTEN ?? "127.0.0.1:0";
const i = listen.lastIndexOf(":");
createServer((req, res) => {
  const body = req.url === "/api/health"
    ? { ok: true, stateDir: process.env.EPC_STATE_DIR ?? null, engineUrl: process.env.EPC_ENGINE_URL ?? null,
        enginePublicUrl: process.env.EPC_ENGINE_PUBLIC_URL ?? null, engineDir: process.env.EPC_ENGINE_DIR ?? null }
    : req.url === "/api/realms" ? [] : null;
  res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}).listen(Number(listen.slice(i + 1)), listen.slice(0, i));
