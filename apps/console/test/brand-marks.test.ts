import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIBRARY } from "@papercliped-engine/os-library";
import { BRAND_ICONS } from "../src/data/brandIcons.ts";
import { GENERIC_ENTRIES, hasOfficialMark, resolveMark } from "../src/data/brandMarks.ts";
import { PLUGINS } from "../src/data/storePlugins.ts";
import { buildStoreItems } from "../src/pages/store/catalog.ts";

const ids = [...PLUGINS.map((p) => p.id), ...LIBRARY.map((e) => e.id)];
const generic = (id: string) => resolveMark(id).kind === "generic";

describe("Store and Connectors marks", () => {
  it("gives every first-party catalog entry its official mark, or an allow-listed labelled generic glyph", () => {
    const missing = ids.filter((id) => generic(id) && !(id in GENERIC_ENTRIES));
    expect(missing).toEqual([]);
  });

  it("keeps the generic allow-list honest: no stale ids, and nothing in it that already has a mark", () => {
    for (const id of Object.keys(GENERIC_ENTRIES)) {
      expect(ids, id).toContain(id);
      expect(generic(id), id).toBe(true);
    }
  });

  it("shows a real mark for the providers people recognise", () => {
    for (const id of ["openai", "anthropic", "gemini", "github", "linear", "slack", "discord", "notion", "vercel", "gmail", "tailscale", "cloudflared", "codex_local", "grok_local", "xai", "mistral", "deepseek", "ollama", "virtio-win", "debian", "ubuntu-lts", "alpine", "rocky-9", "alma-9", "arch", "telegram", "whatsapp"]) {
      expect(hasOfficialMark(id), id).toBe(true);
    }
    expect(resolveMark("virtio-win")).toMatchObject({ kind: "brand", title: "Fedora" });
  });

  it("marks container templates by distribution or app, and labels the rest generic", () => {
    expect(hasOfficialMark("ct:debian-12-standard_12.7-1_amd64.tar.zst")).toBe(true);
    expect(hasOfficialMark("ct:debian-12-turnkey-nextcloud_18.1-1_amd64.tar.gz")).toBe(true);
    const m = resolveMark("ct:debian-12-turnkey-mediaserver_18.0-1_amd64.tar.gz", "Media Server");
    expect(m.kind).toBe("generic");
  });

  it("covers every item the Store builds, including plugin and template items", () => {
    const items = buildStoreItems({ catalog: [{ template: "alpine-3.20-default_20240908_amd64.tar.xz", headline: "Alpine", description: null, os: "alpine", version: "3.20", section: "system", infopage: null }], isoFiles: {}, tplFiles: {}, latest: {}, installedPlugins: new Set() });
    const bad = items.filter((i) => generic(i.id) && !(i.id in GENERIC_ENTRIES)).map((i) => i.id);
    expect(bad).toEqual([]);
  });

  it("labels an unknown or custom entry as custom, never as a vendor or a letter", () => {
    const m = resolveMark("acme-widget", "Acme Widget");
    expect(m).toMatchObject({ kind: "generic", glyph: "custom" });
    expect(m.kind === "generic" && m.label).toMatch(/Acme Widget \(generic custom icon\)/);
    expect(resolveMark("constructor").kind).toBe("generic");
  });

  it("records a source and licence for every shipped mark, and ships only inert artwork", () => {
    for (const [id, b] of Object.entries(BRAND_ICONS)) {
      expect(b.path.length, id).toBeGreaterThan(20);
      expect(b.title, id).toBeTruthy();
      expect(b.source, id).toBeTruthy();
      expect(["CC0-1.0", "MIT"], id).toContain(b.license);
    }
    const dirs = ["brand-marks", "public/brands"];
    for (const d of dirs) {
      for (const f of readdirSync(join(process.cwd(), d)).filter((n) => n.endsWith(".svg"))) {
        const svg = readFileSync(join(process.cwd(), d, f), "utf8");
        expect(svg, `${d}/${f}`).not.toMatch(/<(script|foreignObject|image|style)\b|\son[a-z]+=|href=|https?:\/\/(?!www\.w3\.org)/i);
      }
    }
    expect(existsSync(join(process.cwd(), "brand-marks/LOBE-LICENSE"))).toBe(true);
    expect(existsSync(join(process.cwd(), "brand-marks/PAPERCLIP-LICENSE"))).toBe(true);
  });

  it("has no letter-tile fallback left in the UI", () => {
    for (const f of ["../src/pages/store/Store.tsx", "../src/ui/ProviderMark.tsx", "../src/ui/BrandMark.tsx", "../src/pages/Connectors.tsx", "../src/pages/connect/LiveConnections.tsx"]) {
      expect(readFileSync(new URL(f, import.meta.url), "utf8"), f).not.toMatch(/tileHue|identity-gradient|\.slice\(0, [12]\)|charAt\(0\)/);
    }
  });
});
