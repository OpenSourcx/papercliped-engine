// Screenshots of the storage health, storage tools, backup jobs, Ceph manage, resources and routed network screens at
// desktop (1440) and phone (390) width: the demo (no device behind it) and a live cluster against the fake Proxmox in
// test/fakes-diskcluster.ts. Not part of the test suite.
//
//   pnpm --filter @papercliped-engine/console exec vite build      # the console it serves
//   EPC_SHOTS_DIR=/tmp/diskcluster-shots node --experimental-strip-types services/epaperclip/scripts/cluster-shots.mts
//
// Needs Playwright and a Chromium: EPC_PLAYWRIGHT (a folder with node_modules/playwright, default /opt/node-tools/)
// and EPC_CHROMIUM (default /opt/pw-browsers/chromium-1194/chrome-linux/chrome). Prints page errors and failed
// requests it saw, and every horizontal overflow at phone width.
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { fakeDiskCluster } from "../test/fakes-diskcluster.ts";

const here = import.meta.dirname;
const dist = resolve(here, "../../../apps/console/dist");
const out = process.env.EPC_SHOTS_DIR ?? "/tmp/diskcluster-shots";
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(process.env.EPC_PLAYWRIGHT ?? "/opt/node-tools/")("playwright");
const executablePath = process.env.EPC_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

function liveServer() {
  const pve = fakeDiskCluster();
  const server = createServer(createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(), staticDir: dist, secureCookies: false }));
  return { server, pve };
}
const live = liveServer();
const liveUrl = await listen(live.server);

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".png": "image/png" };
const demoServer = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path.startsWith("/api/")) return void res.writeHead(404).end();
  const file = join(dist, path);
  const real = existsSync(file) && statSync(file).isFile() ? file : join(dist, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[extname(real)] ?? "application/octet-stream" });
  createReadStream(real).pipe(res);
});
const demo = await listen(demoServer);

const setup = { ownerName: "Sam", deviceName: "pve", pinMode: "assistant", aiProvider: null, pinAccess: { system: true, orgs: true, connectors: true, docs: true }, completedAt: "2026-10-01T00:00:00Z" };
const browser = await chromium.launch({ executablePath });
const problems: string[] = [];

type Shot = { name: string; path: string; wait?: string; click?: string[] };
const demoShots: Shot[] = [
  { name: "storage-health", path: "/pve/storage-health", wait: "text=works on a connected device" },
  { name: "backup-jobs", path: "/pve/datacenter/backup-jobs", wait: "text=works on a connected device" },
  { name: "resources", path: "/pve/datacenter/resources", wait: "text=works on a connected device" },
  { name: "routed", path: "/pve/datacenter/routed-networks", wait: "text=works on a connected device" },
];
const liveShots: Shot[] = [
  { name: "storage-health", path: "/pve/storage-health", wait: "text=Act now" },
  { name: "zfs-pool", path: "/pve/storage-health", wait: "text=Act now", click: ["role=button[name=/Details and maintenance/]"] },
  { name: "storage-tools-space", path: "/pve/storage/local", wait: "text=Space and tools", click: ["role=button[name=/Space and tools/]"] },
  { name: "storage-tools-retention", path: "/pve/storage/local", wait: "text=Space and tools", click: ["role=button[name=/Space and tools/]", "role=tab[name=/Retention/]"] },
  { name: "backup-jobs", path: "/pve/datacenter/backup-jobs", wait: "text=backup-nightly" },
  { name: "backup-job-edit", path: "/pve/datacenter/backup-jobs", wait: "text=backup-nightly", click: ["role=button[name=/^Edit$/]"] },
  { name: "backup-uncovered", path: "/pve/datacenter/backup-jobs", wait: "text=backup-nightly", click: ["role=tab[name=/Not covered/]"] },
  { name: "ceph-manage", path: "/pve/datacenter/ceph", wait: "text=Placement groups", click: ["role=tab[name=/Manage/]"] },
  { name: "cluster", path: "/pve/datacenter/cluster", wait: "text=Quorum device and links" },
  { name: "resources", path: "/pve/datacenter/resources", wait: "text=Processors" },
  { name: "routed-controllers", path: "/pve/datacenter/routed-networks", wait: "text=bgp1" },
  { name: "routed-fabrics", path: "/pve/datacenter/routed-networks", wait: "text=bgp1", click: ["role=tab[name=/Fabrics/]"] },
];
const targets: { mode: string; base: string; shots: Shot[]; login: boolean }[] = [
  { mode: "demo", base: demo, shots: demoShots, login: false },
  { mode: "live", base: liveUrl, shots: liveShots, login: true },
];

for (const t of targets) {
  for (const [label, width, height] of [["w1440", 1440, 900], ["w390", 390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    await ctx.addInitScript((s) => localStorage.setItem("epc.setup", JSON.stringify(s)), setup);
    if (t.login) {
      const r = await ctx.request.post(`${t.base}/api/login`, { headers: { "X-EPC-Request": "1", Origin: t.base }, data: { username: "sam", password: "right", realm: "pve" } });
      if (!r.ok()) throw new Error(`sign-in failed: ${r.status()}`);
    }
    const page = await ctx.newPage();
    let current = "";
    page.on("pageerror", (e: Error) => problems.push(`[${t.mode} ${label} ${current}] page error: ${e.message}`));
    page.on("console", (m: { type(): string; text(): string }) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(`[${t.mode} ${label} ${current}] console: ${m.text().slice(0, 160)}`));
    for (const shot of t.shots) {
      current = shot.name;
      await page.goto(t.base + shot.path);
      if (shot.wait) await page.waitForSelector(shot.wait, { timeout: 8000 }).catch(() => problems.push(`[${t.mode} ${label} ${shot.name}] never showed "${shot.wait}"`));
      for (const c of shot.click ?? []) {
        const m = c.match(/^role=(\w+)\[name=\/(.*)\/\]$/);
        if (m) await page.getByRole(m[1], { name: new RegExp(m[2]) }).first().click().catch(() => problems.push(`[${t.mode} ${label} ${shot.name}] couldn't click ${c}`));
      }
      await page.waitForTimeout(800);
      if (label === "w390") {
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (wide > 0) problems.push(`[${t.mode} ${label} ${shot.name}] page scrolls sideways by ${wide}px`);
      }
      await page.screenshot({ path: join(out, `${t.mode}-${label}-${shot.name}.png`), fullPage: true });
    }
    await ctx.close();
  }
}
await browser.close();
for (const s of [live.server, demoServer]) s.close();
console.log(problems.length ? problems.join("\n") : "no page errors, failed loads or sideways scrolling");
console.log(`screenshots in ${out}`);
process.exit(0);
