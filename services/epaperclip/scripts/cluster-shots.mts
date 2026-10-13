// Screenshots of the cluster screens at desktop (1440) and phone (390) width: the demo (no device behind it), a live
// cluster with Ceph, a live cluster on an older Proxmox (HA groups), and a live single device, all against the fake
// Proxmox in test/fakes-cluster.ts. Not part of the test suite.
//
//   pnpm --filter @papercliped-engine/console exec vite build      # the console it serves
//   EPC_SHOTS_DIR=/tmp/cluster-shots node --experimental-strip-types services/epaperclip/scripts/cluster-shots.mts
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
import { fakePve } from "../test/fakes.ts";
import { fakeGuest } from "../test/fakes-guest.ts";
import { fakeCluster, type ClusterFakeOptions } from "../test/fakes-cluster.ts";

const here = import.meta.dirname;
const dist = resolve(here, "../../../apps/console/dist");
const out = process.env.EPC_SHOTS_DIR ?? "/tmp/cluster-shots";
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(process.env.EPC_PLAYWRIGHT ?? "/opt/node-tools/")("playwright");
const executablePath = process.env.EPC_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

function liveServer(opts: ClusterFakeOptions) {
  const pve = fakeCluster(opts, fakeGuest(fakePve().transport).transport);
  // The machines the guest fake knows, spread over the nodes.
  pve.st.guests.splice(0, pve.st.guests.length,
    { vmid: 300, node: "pve", type: "qemu", name: "vm-app", status: "running" },
    { vmid: 301, node: "pve", type: "lxc", name: "ct-web", status: "running" },
    { vmid: 302, node: "pve", type: "qemu", name: "vm-win", status: "stopped" },
    ...(opts.single ? [] : [{ vmid: 400, node: "pve2", type: "qemu" as const, name: "vm-db", status: "running" }]));
  pve.st.ha.resources.clear();
  if (!opts.single) pve.st.ha.resources.set("vm:300", { sid: "vm:300", state: "started", max_restart: 1, max_relocate: 1, comment: "app server" });
  if (!opts.single) pve.st.ha.resources.set("vm:400", { sid: "vm:400", state: "started", max_restart: 2, max_relocate: 1 });
  for (const m of [pve.st.replication, pve.st.replStatus]) {
    const j = m.get("101-0");
    m.clear();
    if (j && !opts.single) m.set("301-0", { ...j, id: "301-0", guest: 301 });
  }
  const server = createServer(createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(), staticDir: dist, secureCookies: false }));
  return { server, pve };
}
const clustered = liveServer({ ceph: true });
const older = liveServer({ pveVersion: "8.4.1" });
const single = liveServer({ single: true });
const urls = { cluster: await listen(clustered.server), older: await listen(older.server), single: await listen(single.server) };

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
  { name: "cluster", path: "/pve/datacenter/cluster", wait: "text=works on a connected device" },
  { name: "ha", path: "/pve/datacenter/ha", wait: "text=works on a connected device" },
];
const clusterShots: Shot[] = [
  { name: "cluster", path: "/pve/datacenter/cluster", wait: "text=Quorate" },
  { name: "ha-resources", path: "/pve/datacenter/ha", wait: "text=Keep running" },
  { name: "ha-rules", path: "/pve/datacenter/ha", wait: "text=Keep running", click: ["role=tab[name=/Rules/]"] },
  { name: "ha-status", path: "/pve/datacenter/ha", wait: "text=Keep running", click: ["role=tab[name=/Status and fencing/]"] },
  { name: "replication", path: "/pve/datacenter/replication", wait: "text=In sync" },
  { name: "ceph-overview", path: "/pve/datacenter/ceph", wait: "text=Placement groups" },
  { name: "ceph-osds", path: "/pve/datacenter/ceph", wait: "text=Placement groups", click: ["role=tab[name=/OSDs/]"] },
  { name: "ceph-pools", path: "/pve/datacenter/ceph", wait: "text=Placement groups", click: ["role=tab[name=/Pools/]"] },
  { name: "machine-cluster-card", path: "/pve/machines/300", wait: "text=Runs on" },
  { name: "machine-migrate", path: "/pve/machines/300", wait: "text=Runs on", click: ["role=button[name=/Migrate/]"] },
];
const olderShots: Shot[] = [
  { name: "ha-groups", path: "/pve/datacenter/ha", wait: "text=Keep running", click: ["role=tab[name=/Groups/]"] },
];
const singleShots: Shot[] = [
  { name: "cluster", path: "/pve/datacenter/cluster", wait: "text=This device is not in a cluster" },
  { name: "ha", path: "/pve/datacenter/ha", wait: "text=This device is not in a cluster" },
  { name: "replication", path: "/pve/datacenter/replication", wait: "text=This device is not in a cluster" },
  { name: "ceph", path: "/pve/datacenter/ceph", wait: "text=isn't set up" },
  { name: "machine", path: "/pve/machines/300", wait: "text=Notes and tags" },
  { name: "create-cluster", path: "/pve/datacenter/cluster", wait: "text=This device is not in a cluster", click: ["role=button[name=/Create cluster/]"] },
];
const targets: { mode: string; base: string; shots: Shot[]; login: boolean }[] = [
  { mode: "demo", base: demo, shots: demoShots, login: false },
  { mode: "live-cluster", base: urls.cluster, shots: clusterShots, login: true },
  { mode: "live-older", base: urls.older, shots: olderShots, login: true },
  { mode: "live-single", base: urls.single, shots: singleShots, login: true },
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
for (const s of [clustered.server, older.server, single.server, demoServer]) s.close();
console.log(problems.length ? problems.join("\n") : "no page errors, failed loads or sideways scrolling");
console.log(`screenshots in ${out}`);
process.exit(0);
