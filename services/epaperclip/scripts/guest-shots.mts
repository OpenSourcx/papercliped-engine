// Screenshots of the machine page and the screens around it, at desktop (1440) and phone (390) width, in the demo and
// live against a fake Proxmox (the same one the host tests use, test/fakes-guest.ts). Not part of the test suite.
//
//   pnpm --filter @papercliped-engine/console exec vite build      # the console it serves
//   EPC_SHOTS_DIR=/tmp/guest-shots node --experimental-strip-types services/epaperclip/scripts/guest-shots.mts
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

const here = import.meta.dirname;
const dist = resolve(here, "../../../apps/console/dist");
const out = process.env.EPC_SHOTS_DIR ?? "/tmp/guest-shots";
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(process.env.EPC_PLAYWRIGHT ?? "/opt/node-tools/")("playwright");
const executablePath = process.env.EPC_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

// Live: the real host service on the built console, with the fake Proxmox behind it.
const pve = fakeGuest(fakePve().transport);
const liveServer = createServer(createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(), staticDir: dist, secureCookies: false }));
const live = await listen(liveServer);

// Demo: the same files with no host service behind them, so the console falls back to its demo data.
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

type Shot = { name: string; path: string; click?: string; wait?: string };
const pages = (mode: "demo" | "live"): Shot[] => {
  const vm = mode === "live" ? 300 : 109;
  const ct = mode === "live" ? 301 : 101;
  return [
    { name: "machines", path: "/pve/machines", wait: "text=New machine" },
    { name: "machine-vm-overview", path: `/pve/machines/${vm}`, wait: "text=Notes and tags" },
    { name: "machine-ct-overview", path: `/pve/machines/${ct}`, wait: "text=Notes and tags" },
    { name: "machine-vm-hardware", path: `/pve/machines/${vm}?tab=hardware`, wait: "text=Firmware and devices" },
    { name: "machine-ct-hardware", path: `/pve/machines/${ct}?tab=hardware`, wait: "text=Features" },
    { name: "machine-vm-permissions", path: `/pve/machines/${vm}?tab=permissions`, wait: "text=On this machine" },
    { name: "machine-firewall", path: `/pve/machines/${vm}?tab=firewall`, wait: "text=Rules" },
    { name: "machine-not-found", path: "/pve/machines/9999", wait: "text=There is no machine #9999" },
    { name: "unknown-address", path: "/pve/nope", wait: "text=We couldn't find that page" },
    { name: "firewall", path: "/pve/firewall", wait: "text=Firewall" },
    { name: "settings-general", path: "/pve/home?settings=general", wait: "text=Device" },
    { name: "settings-apps", path: "/pve/home?settings=apps", wait: "text=Connected apps" },
  ];
};

for (const mode of ["demo", "live"] as const) {
  for (const [label, width, height] of [["w1440", 1440, 900], ["w390", 390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    await ctx.addInitScript((s) => localStorage.setItem("epc.setup", JSON.stringify(s)), setup);
    const base = mode === "live" ? live : demo;
    if (mode === "live") {
      const r = await ctx.request.post(`${base}/api/login`, { headers: { "X-EPC-Request": "1", Origin: base }, data: { username: "sam", password: "right", realm: "pve" } });
      if (!r.ok()) throw new Error(`sign-in failed: ${r.status()}`);
    }
    const page = await ctx.newPage();
    let current = "";
    page.on("pageerror", (e: Error) => problems.push(`[${mode} ${label} ${current}] page error: ${e.message}`));
    page.on("console", (m: { type(): string; text(): string }) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(`[${mode} ${label} ${current}] console: ${m.text().slice(0, 160)}`));
    for (const shot of pages(mode)) {
      current = shot.name;
      await page.goto(base + shot.path);
      if (shot.wait) await page.waitForSelector(shot.wait, { timeout: 8000 }).catch(() => problems.push(`[${mode} ${label} ${shot.name}] never showed "${shot.wait}"`));
      await page.waitForTimeout(700);
      if (label === "w390") {
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (wide > 0) problems.push(`[${mode} ${label} ${shot.name}] page scrolls sideways by ${wide}px`);
      }
      await page.screenshot({ path: join(out, `${mode}-${label}-${shot.name}.png`), fullPage: true });
    }
    await ctx.close();
  }
}
await browser.close();
liveServer.close();
demoServer.close();
console.log(problems.length ? problems.join("\n") : "no page errors, failed loads or sideways scrolling");
console.log(`screenshots in ${out}`);
process.exit(0);
