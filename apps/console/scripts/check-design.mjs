#!/usr/bin/env node
/**
 * check-design.mjs: the console's design gates (apps/console/DESIGN.md, "Enforcement").
 *
 * Scans src/**\/*.{ts,tsx} (comments stripped) and fails when a visual value is typed by hand instead of coming
 * from the token layer (src/index.css and the theme presets):
 *
 *   colour     hex colours, rgb()/hsl()/oklch() literals, and Tailwind palette classes (bg-red-500, text-white)
 *   type       arbitrary font sizes (text-[13px]) and fontSize string literals; use the type ladder (text-compact)
 *   motion     cubic-bezier(), "200ms"-style timings, duration-150/delay-75 and animate-[...]; use motion tokens
 *   layer      z-[60] and zIndex numbers; use the z tokens, z-(--z-modal)
 *   shape      rounded-[..], tracking-[..], leading-[..]; use the radius, tracking and type tokens
 *   spacing    arbitrary padding, margin, gap and inset values (p-[13px]); use the spacing scale
 *
 * Exceptions are allowlisted by path in the "DESIGN ALLOWLIST" block of src/index.css, each with its gates and a
 * reason:   * allow <path> | <gate,gate|*> | <reason>
 *
 * Usage: node scripts/check-design.mjs   (exit 1 when any gate fails)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PALETTE = "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";
const UTIL = "bg|text|border|ring|fill|stroke|from|to|via|outline|divide|placeholder|caret|decoration|shadow";

export const GATES = {
  colour: [
    /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/g,
    /#(?=[0-9]*[a-fA-F])[0-9a-fA-F]{3,4}\b/g,
    /\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(\s*[\d.]/g,
    new RegExp(`\\b(?:${UTIL})-(?:white|black|(?:${PALETTE})-\\d{2,3})\\b`, "g"),
  ],
  type: [/\btext-\[[\d.]+(?:px|rem|em|%)?\]/g, /\bfontSize:\s*["'`]/g],
  motion: [/cubic-bezier\(/g, /["'`][^"'`\n]*\b\d+m?s\b[^"'`\n]*["'`]/g, /\b(?:duration|delay)-\d+\b/g, /\banimate-\[/g],
  layer: [/\bz-\[\d+\]/g, /\bzIndex:\s*\d/g],
  shape: [/\brounded(?:-[a-z]{1,2})?-\[(?!inherit\])[^\]]+\]/g, /\btracking-\[[^\]]+\]/g, /\bleading-\[[^\]]+\]/g],
  spacing: [/(?<![\w-])-?(?:p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y|inset|inset-x|inset-y|top|left|right|bottom)-\[[^\]]*\d(?:px|rem)[^\]]*\]/g],
};

/** Removes // and /* *\/ comments so prose like "lab #109" or "200ms" in a comment never counts. Keeps line numbers. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, p) => p + " ".repeat(m.length - p.length));
}

/** Parses "* allow <path> | <gates> | <reason>" lines from the allowlist block in index.css. */
export function parseAllowlist(css) {
  const block = css.split("DESIGN ALLOWLIST")[1] ?? "";
  const end = block.indexOf("*/");
  return (end >= 0 ? block.slice(0, end) : block)
    .split("\n")
    .map((l) => l.match(/^\s*\*\s*allow\s+(\S+)\s*\|\s*([^|]+)\|\s*(.+)$/))
    .filter(Boolean)
    .map((m) => ({ path: m[1], gates: m[2].trim() === "*" ? Object.keys(GATES) : m[2].split(",").map((g) => g.trim()), reason: m[3].trim() }));
}

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

/** Returns every violation under <root>/src that the allowlist does not cover. */
export function checkDesign(root) {
  const allow = parseAllowlist(readFileSync(join(root, "src/index.css"), "utf8"));
  const out = [];
  for (const file of walk(join(root, "src"))) {
    const rel = relative(root, file).split("\\").join("/");
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    for (const [gate, patterns] of Object.entries(GATES)) {
      if (allow.some((a) => rel.includes(a.path) && a.gates.includes(gate))) continue;
      lines.forEach((line, i) => {
        for (const re of patterns) for (const m of line.matchAll(re)) out.push({ gate, file: rel, line: i + 1, match: m[0].slice(0, 80) });
      });
    }
  }
  return { violations: out, allowlist: allow };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { violations, allowlist } = checkDesign(root);
  const byGate = Object.groupBy ? Object.groupBy(violations, (v) => v.gate) : {};
  for (const gate of Object.keys(GATES)) {
    const list = byGate[gate] ?? violations.filter((v) => v.gate === gate);
    console.log(`${list.length ? "FAIL" : "ok  "} ${gate.padEnd(8)} ${list.length} violation${list.length === 1 ? "" : "s"}`);
    for (const v of list.slice(0, 40)) console.log(`       ${v.file}:${v.line}  ${v.match}`);
    if (list.length > 40) console.log(`       ... and ${list.length - 40} more`);
  }
  console.log(`${allowlist.length} allowlist entries`);
  process.exit(violations.length ? 1 : 0);
}
