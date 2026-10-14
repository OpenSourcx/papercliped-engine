// Regenerates dcSchema.ts from the Proxmox VE API viewer data, so the forms and the strict validation come from
// Proxmox's own parameter definitions instead of being guessed.
//
//   curl -sS https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js -o apidoc.js
//   node services/epaperclip/src/features/dcSchema.gen.mjs apidoc.js > services/epaperclip/src/features/dcSchema.ts
//
// Only the endpoints the backup, SDN, mapping and node-option screens write to are included. The output is plain data.
import { readFileSync } from "node:fs";

const src = readFileSync(process.argv[2], "utf8");
const start = src.indexOf("const apiSchema = ") + "const apiSchema = ".length;
const api = JSON.parse(src.slice(start, src.indexOf("\n]\n;", start) + 2));
const find = (nodes, path) => {
  for (const n of nodes) {
    if (n.path === path) return n;
    const r = n.children && find(n.children, path);
    if (r) return r;
  }
};
const params = (path, method) => {
  const n = find(api, path);
  if (!n || !n.info[method]) throw new Error(`no ${method} ${path}`);
  return n.info[method].parameters.properties;
};

const SECRET = new Set(["token", "key", "password", "secret"]);
// Perl-style inline flags in Proxmox patterns: (?^i:x) is "x, case-insensitively".
const jsPattern = (p) => {
  if (typeof p !== "string") return undefined;
  let flags = "";
  let out = p.replace(/\(\?\^i:/g, () => ((flags = "i"), "(?:"));
  if (/\(\?\^/.test(out) || /\(\?[a-z]*[-^]/.test(out)) return undefined;
  try {
    new RegExp(`^(?:${out})$`, flags);
  } catch {
    return undefined;
  }
  return { source: out, flags };
};

function field(name, p) {
  // The first sentence keeps hints short and never cut mid-word.
  const first = String(p.description ?? "").split("\n")[0];
  const sentence = first.match(/^.{20,260}?[.!?](?:\s|$)/)?.[0].trim();
  const f = { description: sentence ?? (first.length > 260 ? `${first.slice(0, first.lastIndexOf(" ", 260))}…` : first) };
  if (p.type === "array") {
    f.type = "array";
    f.items = field(name, p.items ?? { type: "string" });
    return f;
  }
  f.type = p.type === "number" ? "number" : p.type;
  if (p.enum) f.enum = p.enum;
  // Top-level parameters say minimum/maximum; the fields inside property strings say min/max.
  const lo = p.minimum ?? p.min;
  const hi = p.maximum ?? p.max;
  if (lo !== undefined) f.min = Number(lo);
  if (hi !== undefined) f.max = Number(hi);
  if (p.maxLength !== undefined) f.maxLength = p.maxLength;
  if (p.default !== undefined) f.default = p.default;
  if (typeof p.format === "string") f.format = p.format;
  const pat = jsPattern(p.pattern);
  if (pat) f.pattern = pat;
  if (SECRET.has(name)) f.secret = true;
  if (p.format && typeof p.format === "object") {
    f.props = {};
    for (const [k, v] of Object.entries(p.format)) {
      const sub = field(k, v);
      if (!v.optional) sub.required = true;
      if (v.default_key) sub.defaultKey = true;
      f.props[k] = sub;
    }
  }
  return f;
}

function group(path, method, { skip = [], keep } = {}) {
  const out = {};
  for (const [name, p] of Object.entries(params(path, method))) {
    if (["delete", "digest", "lock-token", "release-lock"].includes(name) || skip.includes(name)) continue;
    if (keep && !keep.includes(name)) continue;
    const f = field(name, p);
    if (!p.optional) f.required = true;
    out[name] = f;
  }
  return out;
}


// The API viewer names these three property strings (format "prune-backups" and so on) without spelling out their
// keys in the endpoint; the keys below follow the typetext Proxmox publishes for them.
const keep = (what) => ({ description: `Keep backups for the last <N> different ${what}.`, type: "integer", min: 0 });
const NAMED_PROPS = {
  "prune-backups": {
    "keep-all": { description: "Keep all backups. Conflicts with the other options when true.", type: "boolean" },
    "keep-last": { description: "Keep the last <N> backups.", type: "integer", min: 0 },
    "keep-hourly": keep("hours"),
    "keep-daily": keep("days"),
    "keep-weekly": keep("weeks"),
    "keep-monthly": keep("months"),
    "keep-yearly": keep("years"),
  },
  "backup-fleecing": {
    enabled: { description: "Enables fleecing: writes go to a temporary image while the backup reads, so a slow backup target doesn't slow the machine.", type: "boolean", defaultKey: true },
    storage: { description: "Use this storage to storage fleecing images. For efficient space usage, it should be local thin-provisioned storage.", type: "string", format: "pve-storage-id" },
  },
  "backup-performance": {
    "max-workers": { description: "Applies to VMs. Allow multiple workers (instead of 1) per disk for backup.", type: "integer", min: 1, max: 256 },
    "pbs-entries-max": { description: "Applies to container backups sent to a Proxmox Backup Server. Maximum number of entries in the catalog.", type: "integer", min: 1 },
  },
};
function patchNamed(schema) {
  for (const f of Object.values(schema)) if (typeof f.format === "string" && NAMED_PROPS[f.format]) {
    f.props = structuredClone(NAMED_PROPS[f.format]);
    delete f.format;
    if (f.default !== undefined) delete f.default;
  }
  return schema;
}

const schemas = {
  backupJob: patchNamed(group("/cluster/backup", "POST", { skip: ["id", "dow", "starttime", "script", "dumpdir", "tmpdir", "quiet", "stop", "mailnotification", "mailto", "stdout", "job-id", "remove"] })),
  nodeConfig: group("/nodes/{node}/config", "PUT", { skip: ["node", "acme", "acmedomain[n]"] }),
  sdnZone: group("/cluster/sdn/zones", "POST", { skip: ["dp-id", "secondary-controllers", "type", "zone"] }),
  sdnVnet: group("/cluster/sdn/vnets", "POST", { skip: ["type", "vnet"] }),
  sdnSubnet: group("/cluster/sdn/vnets/{vnet}/subnets", "POST", { skip: ["type", "vnet", "subnet"] }),
  sdnIpam: group("/cluster/sdn/ipams", "POST", { skip: ["type", "ipam"] }),
  sdnDns: group("/cluster/sdn/dns", "POST", { skip: ["type", "dns"] }),
  sdnController: group("/cluster/sdn/controllers", "POST", { skip: ["type", "controller", "node"] }),
  sdnVnetFirewall: group("/cluster/sdn/vnets/{vnet}/firewall/options", "PUT", { skip: ["vnet"] }),
  mappingPci: group("/cluster/mapping/pci", "POST", { skip: ["id"] }),
  mappingUsb: group("/cluster/mapping/usb", "POST", { skip: ["id"] }),
  mappingDir: group("/cluster/mapping/dir", "POST", { skip: ["id"] }),
};
// Backup jobs and vzdump share their parameters; the run-now form uses the same definitions.
console.log(`// GENERATED by dcSchema.gen.mjs from the Proxmox VE API viewer. Do not edit by hand.
// Proxmox's own parameter definitions for the backup job, SDN, resource mapping and node option forms.
import type { Schema } from "./nodeSchema.ts";

export const DC_SCHEMAS: Record<"backupJob" | "nodeConfig" | "sdnZone" | "sdnVnet" | "sdnSubnet" | "sdnIpam" | "sdnDns" | "sdnController" | "sdnVnetFirewall" | "mappingPci" | "mappingUsb" | "mappingDir", Schema> = ${JSON.stringify(schemas, null, 1)};
`);
