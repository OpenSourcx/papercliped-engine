#!/usr/bin/env node
// Checks every Proxmox call in the code against Proxmox's own API schema (the data behind pve.proxmox.com/pve-docs/api-viewer).
//
//   node scripts/check-pve-api.mjs [path/to/apidoc.js]      uses PVE_APIDOC or downloads the schema when no file is given
//
// For each `pve.call("METHOD", "/path", ...)` (and the client's own `this.call`) it checks that the path and method exist,
// and, where the parameters are written out as an object literal, that every name is one the endpoint takes. Calls built
// from variables can't be read statically; they are counted, not guessed at. Exit 1 on any mismatch, so it can gate a release.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = ["services/epaperclip/src", "packages/proxmox-client/src", "plugins/proxmox-sandbox/src"];
/** Names the code uses that Proxmox takes on every call or that the client adds itself. */
const IGNORE_PARAMS = new Set(["digest", "delete", "node"]);

async function loadSchema() {
  const arg = process.argv[2] ?? process.env.PVE_APIDOC;
  let text;
  if (arg && existsSync(arg)) text = readFileSync(arg, "utf8");
  else {
    const r = await fetch("https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js");
    if (!r.ok) throw new Error(`couldn't download the schema (${r.status}); pass a path to apidoc.js`);
    text = await r.text();
    if (arg) writeFileSync(arg, text);
  }
  // `const apiSchema = [ ... ]` followed by the viewer's own code: the array closes at the first `]` in column 0.
  const start = text.indexOf("[", text.indexOf("apiSchema"));
  const end = text.indexOf("\n]", start);
  return JSON.parse(text.slice(start, end + 2));
}

/** path -> { METHOD -> Set of parameter names } */
function flatten(tree, out = new Map()) {
  for (const n of tree) {
    if (n.info && n.path) {
      const methods = new Map();
      for (const [m, i] of Object.entries(n.info)) methods.set(m, new Set(Object.keys(i.parameters?.properties ?? {})));
      out.set(n.path, methods);
    }
    if (n.children) flatten(n.children, out);
  }
  return out;
}

function walk(dir, acc = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== "node_modules" && f !== "dist") walk(p, acc);
    } else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f)) acc.push(p);
  }
  return acc;
}

/** Text from `open` (at the opening char) to its matching close, honouring strings and template literals. */
function balanced(src, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const close = pairs[src[open]];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) {
        if (src[i] === "\\") i++;
        else if (q === "`" && src[i] === "$" && src[i + 1] === "{") i = balanced(src, i + 1);
      }
    } else if (c === src[open]) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return src.length - 1;
}

function splitTop(args) {
  const parts = [];
  let last = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (i++; i < args.length && args[i] !== q; i++) {
        if (args[i] === "\\") i++;
        else if (q === "`" && args[i] === "$" && args[i + 1] === "{") i = balanced(args, i + 1);
      }
    } else if (c === "(" || c === "{" || c === "[") i = balanced(args, i);
    else if (c === ",") {
      parts.push(args.slice(last, i).trim());
      last = i + 1;
    }
  }
  parts.push(args.slice(last).trim());
  return parts;
}

/** The keys of `{ a: 1, "b-c": 2, d, ...e }`, or null when it isn't a plain object literal. */
function literalKeys(text) {
  if (!text.startsWith("{")) return null;
  const inner = text.slice(1, balanced(text, 0));
  const keys = [];
  for (const part of splitTop(inner)) {
    if (!part) continue;
    if (part.startsWith("...")) return null;
    const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*(?::|$)/.exec(part);
    if (!m) return null;
    keys.push(m[1] ?? m[2] ?? m[3]);
  }
  return keys;
}

const shape = (p) => p.split("/").filter(Boolean);
function matchExact(codeSegs, s) {
  if (s.length !== codeSegs.length) return false;
  return s.every((seg, i) => seg.startsWith("{") || codeSegs[i] === "{x}" || seg === codeSegs[i]);
}
/** A path that starts with a variable (`${nodePath}/disks/smart`) may have it stand for several leading segments. */
function matchPath(codeSegs, schemaPath, leadingVariable) {
  const s = shape(schemaPath);
  if (matchExact(codeSegs, s)) return true;
  if (!leadingVariable || codeSegs[0] !== "{x}") return false;
  for (let k = 2; k <= 4 && k < s.length; k++) if (matchExact(codeSegs.slice(1), s.slice(k))) return true;
  return false;
}

const schema = flatten(await loadSchema());
const paths = [...schema.keys()];
const problems = [];
let checked = 0;
let dynamic = 0;
let keysChecked = 0;

for (const dir of SOURCES) {
  const base = join(ROOT, dir);
  if (!existsSync(base)) continue;
  for (const file of walk(base)) {
    const src = readFileSync(file, "utf8");
    const re = /\b(?:pve|this|client|c)\.call(?:<[^()]*?>)?\(/g;
    for (let m; (m = re.exec(src)); ) {
      const open = m.index + m[0].length - 1;
      const args = splitTop(src.slice(open + 1, balanced(src, open)));
      const method = /^["'](GET|POST|PUT|DELETE)["']$/.exec(args[0] ?? "")?.[1];
      const where = `${relative(ROOT, file)}:${src.slice(0, m.index).split("\n").length}`;
      if (!method) {
        dynamic++;
        continue;
      }
      const pathArg = args[1] ?? "";
      if (!/^[`"']/.test(pathArg)) {
        dynamic++;
        continue;
      }
      const raw = pathArg.slice(1, -1);
      // `${seg(node)}` and friends are parameters; a `${...}` that spans a whole segment is one parameter, one that
      // is glued to text ("local:${x}") is part of a parameter value, so the segment is still one parameter.
      let template = raw.replace(/\$\{[^}]*(?:\{[^}]*\}[^}]*)*\}/g, "{x}");
      const q = template.indexOf("?");
      if (q >= 0) template = template.slice(0, q);
      const segs = shape(template).map((s) => (s.includes("{x}") ? "{x}" : s));
      const hits = paths.filter((p) => matchPath(segs, p, raw.startsWith("${")));
      if (!hits.length) {
        problems.push(`${where}  ${method} ${template}  (no such path)`);
        continue;
      }
      const withMethod = hits.filter((p) => schema.get(p).has(method));
      if (!withMethod.length) {
        problems.push(`${where}  ${method} ${template}  (path exists, but not for ${method}; it has ${[...schema.get(hits[0]).keys()].join(", ")})`);
        continue;
      }
      checked++;
      const keys = literalKeys(args[2] ?? "");
      if (keys && keys.length) {
        keysChecked++;
        const allowed = new Set();
        for (const p of withMethod) for (const k of schema.get(p).get(method)) allowed.add(k);
        // Indexed families (net0, scsi1, ide2, ...) are written as net[n] in the schema.
        const ok = (k) => allowed.has(k) || IGNORE_PARAMS.has(k) || [...allowed].some((a) => a.endsWith("[n]") && new RegExp(`^${a.slice(0, -3)}\\d+$`).test(k));
        const bad = keys.filter((k) => !ok(k));
        if (bad.length) problems.push(`${where}  ${method} ${template}  unknown parameter${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}`);
      }
    }
  }
}

console.log(`Proxmox API conformance: ${checked} calls matched the schema (${keysChecked} with parameters checked), ${dynamic} built from variables and not checked.`);
if (problems.length) {
  console.log(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const p of problems) console.log("  " + p);
  process.exit(1);
}
