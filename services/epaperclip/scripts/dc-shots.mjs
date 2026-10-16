// Screenshots of the hardware, backup, SDN, mapping, bulk and resources screens at 1440 and 390 wide, demo (no host:
// the pages say they need a device) and live (run scripts/dc-live.ts first).
//   node scripts/dc-shots.mjs [outDir] [liveUrl]
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch { pw = require(join(execFileSync("npm", ["root", "-g"]).toString().trim(), "playwright")); }
const out = resolve(process.argv[2] ?? "/tmp/dc-shots");
const liveUrl = process.argv[3] ?? "http://127.0.0.1:4481";
const dist = resolve(import.meta.dirname, "../../../apps/console/dist");
mkdirSync(out, { recursive: true });
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
const demo = createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p.startsWith("/api/")) return void res.writeHead(404).end("no host");
  const file = join(dist, p);
  const f = existsSync(file) && extname(file) ? file : join(dist, "index.html");
  res.writeHead(200, { "Content-Type": types[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
}).listen(0, "127.0.0.1");
await new Promise((r) => demo.once("listening", r));
const demoUrl = `http://127.0.0.1:${demo.address().port}`;
const pages = ["host/hardware", "host/bulk", "datacenter/resources", "datacenter/backup", "datacenter/sdn", "datacenter/mappings"];
const browser = await pw.chromium.launch();
const problems = [];
for (const [mode, base] of [["demo", demoUrl], ["live", liveUrl]]) {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => problems.push(`${mode} ${w}: ${e.message}`));
    await page.addInitScript(() => localStorage.setItem("epc.setup", JSON.stringify({ ownerName: "Sam", deviceName: "pve", pinMode: "assistant", aiProvider: null })));
    if (mode === "live") {
      await page.goto(`${base}/`);
      await page.evaluate(() => fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username: "sam", password: "right", realm: "pve" }) }));
    }
    for (const p of pages) {
      await page.goto(`${base}/pve/${p}`);
      await page.waitForTimeout(900);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (overflow) problems.push(`${mode} ${w} ${p}: horizontal page scroll`);
      await page.screenshot({ path: `${out}/${mode}-${w}-${p.replace("/", "-")}.png` });
    }
    await ctx.close();
  }
}
await browser.close();
demo.close();
console.log(problems.length ? "Problems:\n" + [...new Set(problems)].join("\n") : `dc-shots: done, no page errors. ${out}`);
