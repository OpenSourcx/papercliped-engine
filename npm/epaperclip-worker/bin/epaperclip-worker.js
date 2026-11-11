#!/usr/bin/env node
// epaperclip-worker: runs the ePaperclip worker CLI from this package. It needs Node 22 or newer; the worker itself
// connects out to an ePaperclip host/Pin, never opens a port, and never holds Proxmox or user OAuth credentials.
import { spawnSync } from "node:child_process";

const bundle = new URL("../worker/epaperclip-worker.mjs", import.meta.url);
const [major] = process.versions.node.split(".").map(Number);
if ((major ?? 0) < 22) {
  console.error(`epaperclip-worker: Node 22 or newer is needed (this is ${process.version})`);
  process.exit(1);
}
const r = spawnSync(process.execPath, [bundle.pathname, ...process.argv.slice(2)], { stdio: "inherit" });
if (r.error) {
  console.error(`epaperclip-worker: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
