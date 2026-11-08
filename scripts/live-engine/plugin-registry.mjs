// Live-check helper: build two repacked versions of plugins/proxmox-sandbox into ./pkgs (see docs/PLUGIN-CATALOG.md), then run this from that folder.
// A tiny npm registry for the live plugin check: serves @epc-live/plugin-proxmox-sandbox from ./pkgs, proxies everything else to npmjs.
import http from "node:http"; import fs from "node:fs"; import crypto from "node:crypto";
const NAME = "@epc-live/plugin-proxmox-sandbox"; const PORT = 4873;
const hidden = new Set(); // versions withheld, to publish "later"
const meta = () => {
  const versions = {};
  for (const f of fs.readdirSync("pkgs")) {
    const m = /plugin-proxmox-sandbox-(\d+\.\d+\.\d+)\.tgz$/.exec(f); if (!m || hidden.has(m[1])) continue;
    const buf = fs.readFileSync("pkgs/" + f);
    const pj = JSON.parse(execTar(f));
    versions[m[1]] = { ...pj, dist: { tarball: `http://127.0.0.1:${PORT}/tarballs/${f}`, integrity: "sha512-" + crypto.createHash("sha512").update(buf).digest("base64"), shasum: crypto.createHash("sha1").update(buf).digest("hex") } };
  }
  const latest = Object.keys(versions).sort().at(-1);
  return { name: NAME, "dist-tags": { latest }, versions };
};
import { execFileSync } from "node:child_process";
const execTar = (f) => execFileSync("tar", ["-xzOf", "pkgs/" + f, "package/package.json"]).toString();
http.createServer(async (req, res) => {
  const u = decodeURIComponent(req.url);
  if (u === "/admin/hide/0.2.0") { hidden.add("0.2.0"); return res.end("hidden"); }
  if (u === "/admin/show/0.2.0") { hidden.delete("0.2.0"); return res.end("shown"); }
  if (u === "/" + NAME) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(meta())); }
  { const m = u.match(/^\/(@[^/]+\/[^/]+)\/(\d+\.\d+\.\d+)$/); if (m && m[1] === NAME) { const doc = meta().versions[m[2]]; res.writeHead(doc ? 200 : 404, { "Content-Type": "application/json" }); return res.end(JSON.stringify(doc ?? {})); } /* versionDoc */ }
  if (u.startsWith("/tarballs/")) { const f = u.slice(10); if (/^[\w.-]+\.tgz$/.test(f) && fs.existsSync("pkgs/" + f)) { res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(fs.readFileSync("pkgs/" + f)); } res.writeHead(404); return res.end(); }
  const up = await fetch("https://registry.npmjs.org" + req.url, { headers: { accept: req.headers.accept ?? "*/*" } });
  res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") ?? "application/json" }); res.end(Buffer.from(await up.arrayBuffer()));
}).listen(PORT, "127.0.0.1", () => console.log("registry on", PORT));
