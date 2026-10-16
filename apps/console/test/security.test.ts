import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { httpUrl } from "../src/lib/safeUrl.ts";

/**
 * The console runs under `script-src 'self'; style-src 'self'` with nothing from third parties. These tests keep the code
 * from growing the things that rule exists to rule out: HTML sinks, inline code, remote loads and unsafe links.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|html|css)$/.test(name)) out.push(p);
  }
  return out;
};
const src = files(join(root, "src")).filter((f) => !f.includes(`${join("src", "vendor")}`));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("links whose target comes from outside the console", () => {
  it("only http(s) addresses without credentials are links", () => {
    expect(httpUrl("https://letsencrypt.org/documents/LE-SA-v1.4-April-3-2024.pdf")).toBe("https://letsencrypt.org/documents/LE-SA-v1.4-April-3-2024.pdf");
    expect(httpUrl("http://shop.example/x")).toBe("http://shop.example/x");
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "file:///etc/passwd", "//evil.example/x", "/relative", "https://user:pw@evil.example/", "", "not a url", null, undefined, 42, {}, "https://" + "a".repeat(3000)]) expect(httpUrl(bad), String(bad)).toBeNull();
  });

  it("every external link opens without giving the page a handle to ours", () => {
    const bad: string[] = [];
    for (const f of src.filter((x) => x.endsWith(".tsx"))) {
      const text = strip(readFileSync(f, "utf8"));
      for (const m of text.matchAll(/<a\b[^>]*target=["{]["']?_blank[^>]*>/g)) if (!/rel=\{?["'][^"']*noopener/.test(m[0])) bad.push(`${relative(root, f)}: ${m[0].slice(0, 80)}`);
    }
    expect(bad).toEqual([]);
  });

  it("no link takes its address straight from data without the check", () => {
    const bad: string[] = [];
    for (const f of src.filter((x) => x.endsWith(".tsx"))) {
      const text = strip(readFileSync(f, "utf8"));
      // href={ something.url } / href={x.tos}: addresses that arrive from Proxmox, a CA, the engine or a feed.
      for (const m of text.matchAll(/href=\{([^}]+)\}/g)) {
        const expr = m[1];
        if (/httpUrl\(|pathUrl\(|^`|^"|^'|^to\b/.test(expr.trim())) continue;
        if (/\b(url|tos|link|href|uri)\b/i.test(expr) && !/^\s*(b|base|b\s*\+)/.test(expr)) bad.push(`${relative(root, f)}: href={${expr.trim().slice(0, 60)}}`);
      }
    }
    // The Store's library entries are fixed addresses in this repository's own catalog.
    expect(bad.filter((b) => !b.includes("lib.pageUrl"))).toEqual([]);
  });
});

describe("no way to put markup or code in the page", () => {
  it("has no HTML sinks, eval or javascript: addresses", () => {
    const sinks = /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write\(|\beval\(|new Function\(|setTimeout\(\s*["'`]|setInterval\(\s*["'`]|javascript:/;
    const hits = src.map((f) => [relative(root, f), strip(readFileSync(f, "utf8")).match(sinks)?.[0]] as const).filter(([, m]) => m);
    expect(hits).toEqual([]);
  });

  it("makes no inline script or style, and loads nothing from another site", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i); // only <script src=...>
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i); // no inline event handlers
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html.replace(/xmlns='http:\/\/www\.w3\.org\/2000\/svg'/g, "")).not.toMatch(/(src|href)=["']https?:\/\//i);
    const css = src.filter((f) => f.endsWith(".css")).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(css).not.toMatch(/@import\s+(url\()?["']?https?:/i);
    expect(css).not.toMatch(/url\(\s*["']?https?:/i);
    const code = src.filter((f) => /\.tsx?$/.test(f)).map((f) => strip(readFileSync(f, "utf8"))).join("\n");
    // No script, stylesheet, frame or image is created from a remote address, and no analytics or font service is named.
    expect(code).not.toMatch(/createElement\(\s*["'](script|link|iframe|style)["']/);
    expect(code).not.toMatch(/googletagmanager|google-analytics|gstatic\.com|googleapis\.com|cdn\.jsdelivr|unpkg\.com|cdnjs\.|sentry\.io|segment\.(io|com)|mixpanel\.com|plausible\.io|posthog\.com/i);
  });

  it("sends every change with our own header and never puts a secret in a URL", () => {
    const api = readFileSync(join(root, "src", "data", "api.ts"), "utf8");
    expect(api).toMatch(/X-EPC-Request/);
    const code = src.filter((f) => /\.tsx?$/.test(f)).map((f) => strip(readFileSync(f, "utf8"))).join("\n");
    expect(code).not.toMatch(/\/(api|engine)\/[^"'`\n]*[?&](token|password|secret|apikey|api_key|ticket)=/i);
    expect(code).not.toMatch(/localStorage\.(set|get)Item\([^)]*(token|password|secret|ticket)/i);
  });
});

import { returnUrl } from "../src/lib/safeUrl.ts";
describe("returnUrl", () => {
  const cursor = "cursor://anysphere.cursor-mcp/oauth/callback";
  it("sends people to web addresses and to the one custom-scheme address the page showed", () => {
    expect(returnUrl("https://claude.ai/cb?code=1", "https://claude.ai/cb")).toBe("https://claude.ai/cb?code=1");
    expect(returnUrl(`${cursor}?code=1`, cursor)).toBe(`${cursor}?code=1`);
  });
  it("never to another app, another scheme, or a scheme that runs code or reads files", () => {
    expect(returnUrl("vscode://anysphere.cursor-mcp/oauth/callback?code=1", cursor)).toBeNull();
    expect(returnUrl("cursor://other/oauth/callback?code=1", cursor)).toBeNull();
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "blob:https://x/y", "about:blank", "ws://x/", "vbscript:x"]) expect(returnUrl(bad, bad), bad).toBeNull();
    expect(returnUrl(cursor, "https://claude.ai/cb")).toBeNull();
    expect(returnUrl("", cursor)).toBeNull();
    expect(returnUrl(5, cursor)).toBeNull();
  });
});
