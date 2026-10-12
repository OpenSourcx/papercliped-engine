// Starts the built bundle on a spare port and checks it answers, so a packaging mistake can't reach a host.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const port = 40000 + Math.floor(Math.random() * 20000);
// A throwaway state directory, and an engine address nothing listens on, so the smoke run touches nothing real.
const stateDir = mkdtempSync(join(tmpdir(), "epc-smoke-"));
const child = spawn(process.execPath, ["dist/epaperclip.mjs"], {
  env: { ...process.env, EPC_DEV_HTTP: "1", EPC_LISTEN: `127.0.0.1:${port}`, EPC_PVE_CA: "/dev/null", EPC_STATIC: "", EPC_STATE_DIR: stateDir, EPC_ENGINE_URL: "http://127.0.0.1:9" },
  stdio: ["ignore", "inherit", "inherit"],
});
let ok = false;
for (let i = 0; i < 30 && !ok; i++) {
  await wait(200);
  ok = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false);
}
child.kill();
rmSync(stateDir, { recursive: true, force: true });
if (!ok) {
  console.error("smoke: the built service didn't answer /api/health");
  process.exit(1);
}
console.log("smoke: ok");
