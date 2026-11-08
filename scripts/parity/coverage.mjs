#!/usr/bin/env node
// Static coverage: every operation in the pinned engine's OpenAPI vs the routes the ePaperclip host lets through (/engine/api allowlist).
// Usage: node --experimental-strip-types scripts/parity/coverage.mjs [openapi.json] [--json] [--tag=name]
import { readFileSync, writeFileSync } from "node:fs";
import { ENGINE_ALLOW } from "../../services/epaperclip/src/engine-allow.ts";
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--")) ?? "docs/evidence/parity/native-openapi.json";
const spec = JSON.parse(readFileSync(file, "utf8"));
const rows = [];
for (const [path, ms] of Object.entries(spec.paths)) for (const [m, d] of Object.entries(ms)) {
  if (!["get", "post", "put", "patch", "delete"].includes(m)) continue;
  const concrete = path.replace(/\{[^}]+\}/g, "x1");
  rows.push({ method: m.toUpperCase(), path, tag: d.tags?.[0] ?? path.split("/")[2] ?? "?", allowed: ENGINE_ALLOW.some((r) => r.test(concrete)) });
}
const by = {};
for (const r of rows) { const t = (by[r.tag] ??= { total: 0, allowed: 0 }); t.total++; if (r.allowed) t.allowed++; }
const tot = { total: rows.length, allowed: rows.filter((r) => r.allowed).length };
if (args.includes("--json")) { console.log(JSON.stringify({ tot, by, closed: rows.filter((r) => !r.allowed) }, null, 1)); process.exit(0); }
console.log(`pin ${spec.info?.version ?? "?"}: ${tot.total} operations, ${tot.allowed} reachable through the host proxy, ${tot.total - tot.allowed} closed`);
for (const [t, v] of Object.entries(by).sort((a, b) => b[1].total - a[1].total)) console.log(`${t.padEnd(24)} ${String(v.allowed).padStart(3)}/${v.total}`);
const tag = args.find((a) => a.startsWith("--tag="))?.slice(6);
if (tag) for (const r of rows.filter((r) => r.tag === tag)) console.log(`${r.allowed ? "open  " : "closed"} ${r.method} ${r.path}`);
