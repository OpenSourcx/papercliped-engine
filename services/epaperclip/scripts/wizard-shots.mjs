// Screenshots of every step of both creation wizards, at 1440 and 390 wide, in demo mode (the built console on
// in-browser data) and live mode (the real host service against the wizard's fake Proxmox: run scripts/wizard-live.ts
// first). Needs Playwright and a Chromium: PLAYWRIGHT_BROWSERS_PATH or the default install.
//   node scripts/wizard-shots.mjs [outDir] [liveUrl]        default outDir /tmp/wizard-shots, liveUrl http://127.0.0.1:4480
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require("playwright");
} catch {
  pw = require(join(execFileSync("npm", ["root", "-g"]).toString().trim(), "playwright"));
}
const out = resolve(process.argv[2] ?? "/tmp/wizard-shots");
const liveUrl = process.argv[3] ?? "http://127.0.0.1:4480";
const dist = resolve(import.meta.dirname, "../../../apps/console/dist");
mkdirSync(out, { recursive: true });

// The demo: static files with the single-page fallback, and no host service (so the console starts in demo mode).
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
const demo = createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p.startsWith("/api/")) return void res.writeHead(404).end("no host");
  const file = join(dist, p);
  const f = existsSync(file) && !file.endsWith("/") && extname(file) ? file : join(dist, "index.html");
  res.writeHead(200, { "Content-Type": types[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
}).listen(0, "127.0.0.1");
await new Promise((r) => demo.once("listening", r));
const demoUrl = `http://127.0.0.1:${demo.address().port}`;

const browser = await pw.chromium.launch();
const problems = [];
for (const [mode, base] of [["demo", demoUrl], ["live", liveUrl]]) {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => problems.push(`${mode} ${w}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !/401|404/.test(m.text()) && problems.push(`${mode} ${w}: console ${m.text()}`));
    await page.addInitScript(() => localStorage.setItem("epc.setup", JSON.stringify({ ownerName: "Sam", deviceName: "pve", pinMode: "assistant", aiProvider: null, pinAccess: { system: true, orgs: true, connectors: true, docs: true }, completedAt: new Date().toISOString() })));
    if (mode === "demo") {
      await page.goto(`${base}/pve/machines`);
    } else {
      await page.goto(`${base}/`);
      await page.evaluate(() => fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username: "sam", password: "right", realm: "pve" }) }));
      await page.goto(`${base}/pve/machines`);
    }
    for (const [kind, label] of [["vm", "vm"], ["ct", "ct"]]) {
      await page.goto(`${base}/pve/machines?modal=new-machine${kind === "vm" ? "&kind=vm" : ""}`);
      await page.getByRole("dialog").waitFor();
      await page.getByRole("navigation", { name: "Steps" }).waitFor();
      const steps = await page.getByRole("navigation", { name: "Steps" }).getByRole("button").allInnerTexts();
      for (let i = 0; i < steps.length; i++) {
        await page.getByRole("navigation", { name: "Steps" }).getByRole("button").nth(i).click();
        await page.waitForTimeout(350);
        const name = steps[i].replace(/^\d+\s*/, "").trim().toLowerCase().replace(/[^a-z]+/g, "-");
        await page.screenshot({ path: `${out}/${mode}-${w}-${label}-${String(i + 1).padStart(2, "0")}-${name}.png` });
      }
    }
    await ctx.close();
  }
}
await browser.close();
demo.close();
if (problems.length) {
  console.log("Problems seen:\n" + [...new Set(problems)].join("\n"));
  process.exitCode = 1;
} else console.log(`wizard-shots: done, no page errors. Screenshots in ${out}`);
