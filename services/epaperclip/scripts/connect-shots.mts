// Screenshots of the connector screens (consent, connected apps, connections, agents' AI accounts, adapters in the Store)
// at 1440 and 390 wide, in the demo and live against the fake Proxmox and engine of test/fakes-connect.ts. Not part of the suite.
//
//   pnpm --filter @papercliped-engine/console exec vite build
//   EPC_SHOTS_DIR=/tmp/connect-shots node --experimental-strip-types services/epaperclip/scripts/connect-shots.mts
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { fakeCompat, pkce, startConnectApp } from "../test/fakes-connect.ts";

const here = import.meta.dirname;
const dist = resolve(here, "../../../apps/console/dist");
const out = process.env.EPC_SHOTS_DIR ?? "/tmp/connect-shots";
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(process.env.EPC_PLAYWRIGHT ?? "/opt/node-tools/")("playwright");
const executablePath = process.env.EPC_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

const local = await fakeCompat();
const h = await startConnectApp({ staticDir: dist, providers: (u, i) => fetch(u, i) });
h.eng.st.envs.set("env1", { id: "env1", name: "Northwind containers", driver: "sandbox", status: "active", metadata: { epaperclip: "agent-containers" } });
await h.call("PUT", "/api/connectors/anthropic/credential", { cookie: h.sam }, { apiKey: "sk-ant-demo-0123456789abcdefWXYZ" });
await h.call("POST", "/api/connect/connections", { cookie: h.sam }, { catalog: "ollama", baseUrl: local.base, model: "llama3.2" });
await h.call("POST", "/api/connect/connections", { cookie: h.sam }, { catalog: "groq", apiKey: "gsk_demo_0123456789abcdefghij", model: "llama-3.3-70b" });
await h.call("PATCH", "/api/connect/connections/groq", { cookie: h.sam }, { price: { inPerM: 0.59, outPerM: 0.79 }, orgs: ["co_1"] });
await h.call("PATCH", "/api/connect/connections/anthropic", { cookie: h.sam }, { orgs: ["co_1"], model: "claude-demo" });
await h.call("PUT", "/api/connect/fallbacks", { cookie: h.sam }, { order: ["x:ollama"] });
h.state.setSetting("connect.usage", { [new Date(h.clock.t).toISOString().slice(0, 10)]: { "x:ollama|llama3.2": [14, 22000, 5100], "x:groq|llama-3.3-70b": [6, 9000, 2100] } });
await h.connect({ name: "Claude", scope: "paperclip:control" });
await h.connect({ name: "ChatGPT", scope: "paperclip:read", redirect: "https://chatgpt.com/connector_platform_oauth_redirect" });
const apps = await (await h.call("GET", "/api/connect/apps", { cookie: h.sam })).json();
void apps;
const { client_id } = await h.register("http://127.0.0.1:1455/auth/callback", "Codex CLI");
const consentUrl = `/oauth/authorize?${new URLSearchParams({ client_id, redirect_uri: "http://127.0.0.1:1455/auth/callback", response_type: "code", scope: "paperclip:control", state: "demo", code_challenge: pkce().challenge, code_challenge_method: "S256", resource: `${h.base}/mcp` })}`;
await h.tool((await h.connect({ name: "Claude", scope: "paperclip:control" })).access, "host_status");

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
type Shot = { name: string; path: string; wait: string; click?: string };
const shots = (mode: "demo" | "live"): Shot[] =>
  mode === "live"
    ? [
        { name: "consent", path: consentUrl, wait: "text=Connect Codex CLI to ePaperclip?" },
        { name: "apps", path: "/pve/home?settings=apps", wait: "text=Your connected apps" },
        { name: "connectors", path: "/pve/home?settings=connectors", wait: "text=Usage, last 30 days" },
        { name: "org-accounts", path: "/pve/co_1/connectors", wait: "text=Sign in with a subscription" },
        { name: "store-adapters", path: "/pve/store", click: "role=radio[name=\"Plugins\"]", wait: "text=Claude Code" },
      ]
    : [
        { name: "apps", path: "/pve/home?settings=apps", wait: "text=Connect an app" },
        { name: "connectors", path: "/pve/home?settings=connectors", wait: "text=Connectors" },
        { name: "store-adapters", path: "/pve/store", click: "role=radio[name=\"Plugins\"]", wait: "text=Claude Code" },
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
      if (shot.click) await page.click(shot.click, { timeout: 8000 }).catch(() => problems.push(`[${mode} ${label} ${shot.name}] couldn't click ${shot.click}`));
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
await h.closeAll();
await local.close();
demoServer.close();
console.log(problems.length ? problems.join("\n") : "no page errors, failed loads or sideways scrolling");
console.log(`screenshots in ${out}`);
process.exit(0);
