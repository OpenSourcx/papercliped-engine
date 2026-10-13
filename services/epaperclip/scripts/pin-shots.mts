// Screenshots of Pin's runtime (inbox, plans, automations, updates, model settings) at 1440 and 390 wide, in the demo and
// live against the fake Proxmox the host tests use (test/fakes-pin.ts). Not part of the test suite.
//
//   pnpm --filter @papercliped-engine/console exec vite build
//   EPC_SHOTS_DIR=/tmp/pin-shots node --experimental-strip-types services/epaperclip/scripts/pin-shots.mts
//
// Needs Playwright and a Chromium: EPC_PLAYWRIGHT (default /opt/node-tools/) and EPC_CHROMIUM
// (default /opt/pw-browsers/chromium-1194/chrome-linux/chrome). Prints page errors and sideways scrolling at phone width.
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { createPlan } from "../src/features/pin-agent.ts";
import { startPinApp } from "../test/fakes-pin.ts";

const here = import.meta.dirname;
const dist = resolve(here, "../../../apps/console/dist");
const out = process.env.EPC_SHOTS_DIR ?? "/tmp/pin-shots";
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(process.env.EPC_PLAYWRIGHT ?? "/opt/node-tools/")("playwright");
const executablePath = process.env.EPC_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

// A provider that lists a few models and answers the test request.
const providers = async (url: string, init: RequestInit) => {
  if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify({ data: [{ id: "model-fast", display_name: "Fast" }, { id: "model-thorough", display_name: "Thorough" }] }), { status: 200 });
  return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
};
const h = await startPinApp({ helper: true, staticDir: dist, providers });
const sam = await h.signIn("sam");
const post = (path: string, body?: unknown) => h.call("POST", path, { cookie: sam }, body ?? {});
await h.call("PUT", "/api/connectors/anthropic/credential", { cookie: sam }, { apiKey: "sk-demo-0123456789abcdefWXYZ" });
await h.call("PUT", "/api/pin/settings", { cookie: sam }, { provider: "anthropic", model: "model-fast", mode: "agent" });
// Automations: one that works and has history, one that failed until it paused itself.
const spec = (name: string, action: string, scope: object, value = 50) => ({ name, trigger: { type: "condition", when: { metric: "memory_percent", op: ">", value, forSeconds: 0 }, cooldownSeconds: 0, everySeconds: 60 }, scope, then: { action } });
const a1 = (await (await post("/api/pin/automations", spec("Web memory guard", "shutdown", { guestType: "lxc", vmids: [101] }))).json()).automation.id;
await post("/api/pin/automations", { name: "Nightly snapshot of production", trigger: { type: "schedule", dailyAt: "02:30" }, scope: { guestType: "any", tag: "prod" }, then: { action: "snapshot" } });
const a3 = (await (await post("/api/pin/automations", spec("Cache CPU watch", "stop", { guestType: "lxc", vmids: [101] }, 5))).json()).automation.id;
await h.runner.tick();
h.pve.guests.get(101)!.status = "running";
h.pve.st.refusePower = { status: 403, message: "no" };
for (let i = 0; i < 3; i++) { h.clock.t += 5 * 60_000; await h.runner.tick(); h.pve.guests.get(101)!.status = "running"; }
h.pve.st.refusePower = null;
h.clock.t = new Date(2026, 9, 13, 12, 0, 0).getTime();
void a1; void a3;
// Inbox, plans, update.
h.pve.finishedTask({ type: "vzdump", id: "101", user: "root@pam", status: "job errors", at: h.clock.t - 90_000 });
h.pve.finishedTask({ type: "qmstart", id: "200", user: "sam@pve", at: h.clock.t - 600_000 });
await h.call("GET", "/api/pin/notifications?refresh=1", { cookie: sam });
createPlan(h.rt, { owner: "sam@pve", title: "Retire the cache container", summary: "Snapshot it first, then shut it down cleanly.", createdBy: "pin", names: new Map([[101, "web"]]), steps: [{ kind: "snapshot", vmid: 101, name: "before-retire" }, { kind: "power", vmid: 101, action: "shutdown" }] });
await h.call("GET", "/api/pin/update", { cookie: sam });

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
const setup = { ownerName: "Sam", deviceName: "pve", pinMode: "agent", aiProvider: null, pinAccess: { system: true, orgs: true, connectors: true, docs: true }, completedAt: "2026-10-01T00:00:00Z" };
const browser = await chromium.launch({ executablePath });
const problems: string[] = [];

type Shot = { name: string; path: string; wait: string };
const shots = (mode: "demo" | "live"): Shot[] =>
  mode === "live"
    ? [
        { name: "inbox", path: "/pve/pin?tab=inbox", wait: "text=Backup of 101 failed" },
        { name: "plans", path: "/pve/pin?tab=plans", wait: "text=Retire the cache container" },
        { name: "automations", path: "/pve/pin?tab=automations", wait: "text=Web memory guard" },
        { name: "automations-page", path: "/pve/automations", wait: "text=Nightly snapshot of production" },
        { name: "updates", path: "/pve/pin?tab=updates", wait: "text=An update is available" },
        { name: "settings", path: "/pve/pin?tab=settings", wait: "text=Test connection" },
      ]
    : [
        { name: "overview", path: "/pve/pin", wait: "text=What Pin may do" },
        { name: "automations", path: "/pve/pin?tab=automations", wait: "text=Rules Pin runs for you" },
        { name: "settings", path: "/pve/pin?tab=settings", wait: "text=Mode" },
      ];

for (const mode of ["demo", "live"] as const) {
  for (const [label, width, height] of [["w1440", 1440, 900], ["w390", 390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    await ctx.addInitScript((s) => localStorage.setItem("epc.setup", JSON.stringify(s)), setup);
    const base = mode === "live" ? h.base : demo;
    if (mode === "live") {
      const r = await ctx.request.post(`${base}/api/login`, { headers: { "X-EPC-Request": "1", Origin: base }, data: { username: "sam", password: "right", realm: "pve" } });
      if (!r.ok()) throw new Error(`sign-in failed: ${r.status()}`);
    }
    const page = await ctx.newPage();
    let current = "";
    page.on("pageerror", (e: Error) => problems.push(`[${mode} ${label} ${current}] page error: ${e.message}`));
    page.on("console", (m: { type(): string; text(): string }) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(`[${mode} ${label} ${current}] console: ${m.text().slice(0, 160)}`));
    for (const shot of shots(mode)) {
      current = shot.name;
      await page.goto(base + shot.path);
      await page.waitForSelector(shot.wait, { timeout: 8000 }).catch(() => problems.push(`[${mode} ${label} ${shot.name}] never showed "${shot.wait}"`));
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
await h.close();
demoServer.close();
console.log(problems.length ? problems.join("\n") : "no page errors, failed loads or sideways scrolling");
console.log(`screenshots in ${out}`);
process.exit(0);
