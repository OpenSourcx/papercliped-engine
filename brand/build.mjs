// Builds Pin's brand assets from brand/tokens.json: the SVGs always, the PNGs and favicon.ico when a Chromium and Playwright are
// available (set CHROMIUM=/path/to/chrome and, if needed, PLAYWRIGHT=/path/to/playwright/index.mjs). Output is committed, so
// nobody needs a browser to use the kit.
//
//   node brand/build.mjs            write SVGs, PNGs and the console's public icons
//   node brand/build.mjs --check    fail if the committed SVGs are not what the tokens produce
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { files, faviconSvg, manifest, ico } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PUBLIC = join(ROOT, "apps/console/public");

/** Playwright from PLAYWRIGHT, from this project, or from the global npm folder; null when there is none. */
async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT, "playwright"];
  try {
    candidates.push(join(execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), "playwright", "index.mjs"));
  } catch {
    /* no npm */
  }
  for (const c of candidates.filter(Boolean)) {
    try {
      return await import(/* @vite-ignore */ c);
    } catch {
      /* try the next */
    }
  }
  return null;
}

async function main() {
  const check = process.argv.includes("--check");
  const want = { ...Object.fromEntries(Object.entries(files).map(([n, f]) => [join(HERE, n), f()])), [join(PUBLIC, "favicon.svg")]: faviconSvg(), [join(PUBLIC, "site.webmanifest")]: manifest() };
  if (check) {
    const stale = Object.entries(want).filter(([p, s]) => !existsSync(p) || readFileSync(p, "utf8") !== s).map(([p]) => p.replace(ROOT + "/", ""));
    if (stale.length) {
      console.error(`brand: out of date (run node brand/build.mjs): ${stale.join(", ")}`);
      process.exit(1);
    }
    console.log("brand: SVGs match tokens.json");
    return;
  }
  mkdirSync(join(HERE, "png"), { recursive: true });
  for (const [p, s] of Object.entries(want)) writeFileSync(p, s);

  const chrome = process.env.CHROMIUM ?? ["/opt/pw-browsers/chromium", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
  const pw = await loadPlaywright();
  if (!chrome || !pw) {
    console.log("brand: SVGs written; no Chromium/Playwright found, so PNGs and favicon.ico were left as they are");
    return;
  }
  const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
  const shot = async (svgText, size) => {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svgText}`);
    const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    return buf;
  };
  for (const s of [16, 32, 48, 64, 128, 256, 512, 1024]) writeFileSync(join(HERE, "png", `pin-orb-${s}.png`), await shot(files["pin-orb.svg"](), s));
  for (const s of [180, 192, 512]) writeFileSync(join(HERE, "png", `app-icon-${s}.png`), await shot(files["app-icon.svg"](), s));
  writeFileSync(join(PUBLIC, "apple-touch-icon.png"), await shot(files["app-icon.svg"](), 180));
  writeFileSync(join(PUBLIC, "icon-192.png"), await shot(files["app-icon.svg"](), 192));
  writeFileSync(join(PUBLIC, "icon-512.png"), await shot(files["app-icon.svg"](), 512));
  const small = [];
  for (const size of [16, 32, 48]) small.push({ size, data: await shot(faviconSvg(), size) });
  writeFileSync(join(PUBLIC, "favicon.ico"), ico(small));
  await browser.close();
  console.log("brand: wrote SVGs, PNGs, favicon.ico and the console's public icons");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
