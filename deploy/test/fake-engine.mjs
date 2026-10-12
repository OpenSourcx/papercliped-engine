// Stand-in for the engine in deploy/test/run.sh (installed by EPC_SKIP_ENGINE_NPM=1 at the engine's real entry point).
// It needs the settings the unit and engine.env give the real one, answers /api/health like it, and "migrates" its
// database by writing the engine version from its lockfile into PAPERCLIP_HOME/instances/default/db/schema_version.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const failUnderSystemd = false; // run.sh flips this to make an engine that test-starts fine but fails as a service
if (failUnderSystemd && process.env.INVOCATION_ID) process.exit(1);

const { PAPERCLIP_HOME: home, BETTER_AUTH_SECRET: secret, HOST: host, PORT: port } = process.env;
if (!home || !secret || !host || !port) { console.error("fake engine: PAPERCLIP_HOME, BETTER_AUTH_SECRET, HOST and PORT are required"); process.exit(1); }

const lock = JSON.parse(readFileSync(new URL("../../../../package-lock.json", import.meta.url), "utf8"));
const version = lock.packages["node_modules/paperclipai"].version;
const db = `${home}/instances/default/db`;
mkdirSync(db, { recursive: true });
writeFileSync(`${db}/schema_version`, `${version}\n`);

createServer((req, res) => {
  if (req.url !== "/api/health") { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ok", version, bootstrapStatus: "bootstrap_pending" }));
}).listen(Number(port), host);
process.on("SIGTERM", () => process.exit(0));
