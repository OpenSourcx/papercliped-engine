// Builds Pin's brand assets from brand/tokens.json: the SVGs always, the PNGs and favicon.ico when a Chromium is available
// (the Playwright one the sandbox ships, or CHROMIUM=/path/to/chrome). Output is committed, so nobody needs a browser to use the kit.
//
//   node brand/build.mjs            write SVGs, PNGs and the console's public icons
//   node brand/build.mjs --check    fail if the committed SVGs are not what the tokens produce
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const tokens = JSON.parse(readFileSync(join(HERE, "tokens.json"), "utf8"));

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const fmt = (n) => String(Math.round(n * 100) / 100);

/** The colour of the orb's conic gradient at `deg` clockwise from the top: stop 1 → 2 → 3 → 1, each a third of the turn, in sRGB like CSS. */
export function conicAt(deg) {
  const s = [...tokens.orb.stops, tokens.orb.stops[0]].map(hex);
  const t = ((deg % 360) + 360) % 360 / 120;
  const i = Math.min(2, Math.floor(t));
  return toHex(mix(s[i], s[i + 1], t - i));
}

/** SVG has no conic gradient, so the orb is drawn as thin wedges that meet at the centre, clipped to a circle. */
function wedges(cx, cy, r, step = 2) {
  const out = [];
  for (let a = 0; a < 360; a += step) {
    const a0 = ((a - 1.5) * Math.PI) / 180;
    const a1 = ((a + step + 1.5) * Math.PI) / 180;
    const p = (ang) => `${fmt(cx + r * 1.5 * Math.sin(ang))} ${fmt(cy - r * 1.5 * Math.cos(ang))}`;
    out.push(`<path d="M${fmt(cx)} ${fmt(cy)}L${p(a0)}L${p(a1)}Z" fill="${conicAt(a + step / 2)}"/>`);
  }
  return out.join("");
}

/** The full-colour orb in a `size` box, centred at (cx, cy) with radius r. `id` keeps clip paths unique when SVGs share a page. */
function orbParts(cx, cy, r, id) {
  const { highlight, highlightOpacity, coreInsetPercent, coreOpacity } = tokens.orb;
  const d = r * 2;
  const core = (d * (100 - coreInsetPercent * 2)) / 200;
  return (
    `<clipPath id="${id}"><circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}"/></clipPath>` +
    `<g clip-path="url(#${id})">${wedges(cx, cy, r)}</g>` +
    `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(core)}" fill="${tokens.surface.dark}" fill-opacity="${coreOpacity}"/>` +
    `<circle cx="${fmt(cx - r + d * 0.35)}" cy="${fmt(cy - r + d * 0.29)}" r="${fmt(d * 0.09)}" fill="${highlight}" fill-opacity="${highlightOpacity}"/>`
  );
}

const svg = (w, h, body, title) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;

export const files = {
  /** The mark on its own, transparent background: works on light and dark. */
  "pin-orb.svg": () => svg(256, 256, orbParts(128, 128, 120, "o"), "Pin"),
  /** The mark in a rounded square on the console's dark surface: favicon, app and home-screen icon. The orb fills about 70% so it survives circular masks. */
  "app-icon.svg": () => svg(512, 512, `<rect width="512" height="512" rx="112" fill="${tokens.surface.dark}"/>` + orbParts(256, 256, 178, "a"), "Pin"),
  /** One colour: the orb's silhouette with the highlight cut out. For stamps, print, and places that need a single ink. */
  "pin-orb-black.svg": () => mono("#000000"),
  "pin-orb-white.svg": () => mono("#ffffff"),
};

function mono(color) {
  const r = 120;
  const d = r * 2;
  const body =
    `<mask id="m"><rect width="256" height="256" fill="#fff"/><circle cx="${fmt(128 - r + d * 0.35)}" cy="${fmt(128 - r + d * 0.29)}" r="${fmt(d * 0.09)}" fill="#000"/></mask>` +
    `<circle cx="128" cy="128" r="${r}" fill="${color}" mask="url(#m)"/>`;
  return svg(256, 256, body, "Pin");
}

/** A tiny favicon: no core ring (it turns to mud at 16 px), a larger highlight. */
export const faviconSvg = () => {
  const r = 15;
  const body = `<clipPath id="f"><circle cx="16" cy="16" r="${r}"/></clipPath><g clip-path="url(#f)">${wedges(16, 16, r, 6)}</g><circle cx="${fmt(16 - r + r * 2 * 0.35)}" cy="${fmt(16 - r + r * 2 * 0.29)}" r="${fmt(r * 2 * 0.11)}" fill="#fff" fill-opacity="0.75"/>`;
  return svg(32, 32, body, "Pin");
};

export const manifest = () =>
  JSON.stringify({ name: "ePaperclip", short_name: "ePaperclip", start_url: "/", display: "standalone", background_color: tokens.surface.dark, theme_color: tokens.surface.dark, icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }] }, null, 2) + "\n";

/** A .ico that holds PNG images, which every current browser reads. */
export function ico(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size === 256 ? 0 : size;
    e[1] = size === 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([head, ...entries, ...pngs.map((p) => p.data)]);
}

const ROOT = resolve(HERE, "..");
const PUBLIC = join(ROOT, "apps/console/public");

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
  let pw;
  try {
    pw = await import(process.env.PLAYWRIGHT ?? "playwright");
  } catch {
    pw = await import("/opt/node22/lib/node_modules/playwright/index.mjs").catch(() => null);
  }
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
