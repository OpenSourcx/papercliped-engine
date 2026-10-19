import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain ESM script with no types
import { tokens, files, faviconSvg, manifest, ico, conicAt } from "../../../brand/build.mjs";

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const css = read("apps/console/src/index.css");
const token = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1].trim();

describe("Pin's brand kit", () => {
  it("uses the same colours as the console's CSS, so the mark can't drift from the product", () => {
    expect([token("pin-1"), token("pin-2"), token("pin-3")]).toEqual(tokens.orb.stops);
    expect(token("bg")).toBe(tokens.surface.dark);
    expect(token("ink")).toBe(tokens.surface.ink);
    expect(token("accent")).toBe(tokens.accent);
    expect(token("pin-highlight")).toBe("rgb(255 255 255 / 0.7)");
    expect(tokens.orb.highlightOpacity).toBe(0.7);
    // the CSS core is `inset: 22%` at 25% of the surface colour
    expect(css).toMatch(/\.pin-orb::before\s*{[^}]*inset:\s*22%/);
    expect(css).toMatch(/\.pin-orb::before\s*{[^}]*color-mix\(in oklab, var\(--bg\) 25%/);
  });

  it("ships SVGs that are exactly what the tokens produce", () => {
    for (const [name, make] of Object.entries(files as Record<string, () => string>)) expect(read(`brand/${name}`), name).toBe(make());
    expect(read("apps/console/public/favicon.svg")).toBe(faviconSvg());
    expect(read("apps/console/public/site.webmanifest")).toBe(manifest());
  });

  it("has every raster and icon the page and manifest point at, and they are real images", () => {
    const html = read("apps/console/index.html");
    for (const href of ["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png", "/site.webmanifest"]) {
      expect(html).toContain(`href="${href}"`);
      expect(existsSync(join(ROOT, "apps/console/public", href)), href).toBe(true);
    }
    expect(html).not.toContain("data:image"); // no hand-pasted copy of the mark
    const png = (p: string) => readFileSync(join(ROOT, p)).subarray(0, 8).toString("hex");
    for (const p of ["apps/console/public/apple-touch-icon.png", "apps/console/public/icon-192.png", "apps/console/public/icon-512.png", "brand/png/pin-orb-1024.png", "brand/png/pin-orb-16.png"]) expect(png(p), p).toBe("89504e470d0a1a0a");
    const icon = readFileSync(join(ROOT, "apps/console/public/favicon.ico"));
    expect([icon.readUInt16LE(0), icon.readUInt16LE(2), icon.readUInt16LE(4)]).toEqual([0, 1, 3]);
    expect(statSync(join(ROOT, "apps/console/public/icon-512.png")).size).toBeGreaterThan(5000);
    for (const m of JSON.parse(read("apps/console/public/site.webmanifest")).icons) expect(existsSync(join(ROOT, "apps/console/public", m.src)), m.src).toBe(true);
  });

  it("writes a valid .ico container", () => {
    const one = ico([{ size: 16, data: Buffer.from("abc") }]);
    expect(one.length).toBe(6 + 16 + 3);
    expect(one.readUInt32LE(6 + 12)).toBe(22);
  });

  it("runs the gradient gold → coral → violet from the top, clockwise, like the CSS conic gradient", () => {
    expect([conicAt(0), conicAt(120), conicAt(240)]).toEqual(tokens.orb.stops);
    expect(conicAt(360)).toBe(tokens.orb.stops[0]);
    expect(conicAt(60)).not.toBe(conicAt(0)); // blends between the stops
  });
});
