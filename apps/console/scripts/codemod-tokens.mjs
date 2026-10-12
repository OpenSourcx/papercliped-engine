#!/usr/bin/env node
/**
 * Rewrites hand-typed visual values in the console's source to design tokens (see apps/console/DESIGN.md).
 * Idempotent: running it twice changes nothing the second time. Files another team owns can be skipped with
 * --skip <path-substring> (repeatable), so a parallel branch is never rewritten underneath it.
 *
 *   node scripts/codemod-tokens.mjs [--dry] [--skip src/pages/org/ ...]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const skip = args.flatMap((a, i) => (a === "--skip" ? [args[i + 1]] : []));

const TYPE = {
  "11px": "micro", "12px": "xs", "12.5px": "xs", "13px": "compact", "14px": "sm", "15px": "body", "17px": "lead", "18px": "lg",
  "20px": "xl", "22px": "title", "26px": "heading", "28px": "display", "30px": "display", "32px": "display", "34px": "hero",
  "40px": "hero-md", "48px": "hero-lg",
};
const Z = { 58: "island", 59: "drawer", 60: "modal", 65: "fullscreen", 70: "popover" };
const RULES = [
  [/\btext-\[(\d+(?:\.\d+)?px)\]/g, (m, v) => (TYPE[v] ? `text-${TYPE[v]}` : m)],
  [/\btracking-\[0\.(?:08|1)em\]/g, () => "tracking-label"],
  [/\btracking-\[0\.3em\]/g, () => "tracking-code"],
  [/\bz-\[(\d+)\]/g, (m, n) => (Z[n] ? `z-(--z-${Z[n]})` : m)],
  [/\brounded-\[16px\]/g, () => "rounded-rail-active"],
  [/\brounded-\[24px\]/g, () => "rounded-rail"],
  [/\brounded-\[30%\]/g, () => "rounded-squircle"],
  [/\bduration-150\b/g, () => "duration-(--duration-fast)"],
  [/\bduration-200\b/g, () => "duration-(--duration-base)"],
  [/\bduration-(?:300)\b/g, () => "duration-(--duration-slow)"],
  [/\bduration-(?:500|700)\b/g, () => "duration-(--duration-deliberate)"],
  [/\banimate-\[spin_2\.4s_linear_infinite\]/g, () => "animate-spin-slow"],
];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css)$/.test(f) && !p.endsWith("index.css") ? [p] : [];
  });
}

let changed = 0;
for (const file of walk(join(root, "src"))) {
  const rel = relative(root, file);
  if (skip.some((s) => rel.includes(s))) continue;
  const before = readFileSync(file, "utf8");
  let after = before;
  for (const [re, fn] of RULES) after = after.replace(re, fn);
  if (after !== before) {
    changed++;
    console.log(`${dry ? "would rewrite" : "rewrote"} ${rel}`);
    if (!dry) writeFileSync(file, after);
  }
}
console.log(`${changed} file${changed === 1 ? "" : "s"}${dry ? " would change" : " changed"}`);
