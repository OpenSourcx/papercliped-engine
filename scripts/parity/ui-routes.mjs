#!/usr/bin/env node
// Which API operations does the NATIVE Paperclip UI (the pinned package's ui-dist bundle) actually call, and which of them
// does the ePaperclip host proxy refuse? Static, source-only evidence.
// Usage: node --experimental-strip-types scripts/parity/ui-routes.mjs [ui-dist dir] [--json]
import { readdirSync, readFileSync } from "node:fs";
import { ENGINE_ALLOW } from "../../services/epaperclip/src/engine-allow.ts";
const args = process.argv.slice(2);
const dir = (args.find((a) => !a.startsWith("--")) ?? "/project/.work/engine-1023/tree/node_modules/@paperclipai/server/ui-dist") + "/assets";
const seen = new Map();
const call = /\.(get|post|put|patch|delete|postForm)\(\s*(?=[`"'])/g;
function readStr(s, i) {
  const q = s[i]; let out = ""; i++;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { out += s[i + 1]; i++; continue; }
    if (c === q) return out;
    if (q === "`" && c === "$" && s[i + 1] === "{") { let d = 1; i += 2; while (i < s.length && d) { if (s[i] === "{") d++; else if (s[i] === "}") d--; i++; } i--; out += "{}"; continue; }
    out += c;
  }
  return null;
}
for (const f of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
  const s = readFileSync(`${dir}/${f}`, "utf8");
  for (const m of s.matchAll(call)) {
    const p = readStr(s, m.index + m[0].length); if (!p || !p.startsWith("/")) continue;
    const path = p.split("?")[0].replace(/\/+$/, "") || "/";
    const k = `${m[1] === "postForm" ? "POST" : m[1].toUpperCase()} ${path}`;
    seen.set(k, (seen.get(k) ?? new Set()).add(f.replace(/-[\w-]{6,}\.js$/, "")));
  }
}
const rows = [...seen].map(([k, files]) => {
  const [method, path] = k.split(" ");
  const full = "/api" + path;
  const concrete = full.replace(/\{\}/g, "x1");
  return { method, path: full, allowed: ENGINE_ALLOW.some((r) => r.test(concrete)), chunks: [...files].slice(0, 3).join(",") };
}).sort((a, b) => a.path.localeCompare(b.path));
if (args.includes("--json")) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
const closed = rows.filter((r) => !r.allowed);
console.log(`native UI calls ${rows.length} distinct operations; ${rows.length - closed.length} pass the ePaperclip host proxy, ${closed.length} are refused (404)`);
for (const r of closed) console.log(`closed ${r.method.padEnd(6)} ${r.path}   [${r.chunks}]`);
