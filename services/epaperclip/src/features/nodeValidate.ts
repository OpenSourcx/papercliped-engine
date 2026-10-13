import { createPrivateKey, X509Certificate } from "node:crypto";
import { HttpError } from "../http.ts";
import type { FieldSchema, Schema } from "./nodeSchema.ts";

/**
 * Strict validation for the node and datacenter screens. Everything the browser sends is checked here before it can
 * reach Proxmox, and Proxmox's own checks still apply on top (it decides permissions and has the final word on values).
 */

const bad = (msg: string): never => {
  throw new HttpError(400, "bad_request", msg);
};

export const NODE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/;
export const nodeName = (v: unknown): string => (typeof v === "string" && NODE_RE.test(v) ? v : bad("That isn't a node name"));

/** UPID:node:pid:pstart:starttime:type:id:user: — the id may hold ":" and "/" (volume ids), so only the fixed fields are pinned. */
export const UPID_RE = /^UPID:[\w.-]+:[0-9A-Fa-f]+:[0-9A-Fa-f]+:[0-9A-Fa-f]+:\w+:\S*$/;
export function upid(v: unknown): { upid: string; node: string } {
  if (typeof v !== "string" || v.length > 400 || !UPID_RE.test(v)) return bad("That isn't a task id");
  return { upid: v, node: v.split(":")[1] };
}

export const configId = (v: unknown, what = "name"): string => (typeof v === "string" && /^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(v) ? v : bad(`The ${what} must start with a letter and use letters, numbers, - and _ (2 to 64 characters)`));

/** Debian package names and versions, as apt writes them. */
export const packageName = (v: unknown): string => (typeof v === "string" && /^[a-z0-9][a-z0-9+.-]{1,100}$/.test(v) ? v : bad("That isn't a package name"));
export const packageVersion = (v: unknown): string => (typeof v === "string" && /^[A-Za-z0-9.+~:-]{1,100}$/.test(v) ? v : bad("That isn't a package version"));

/** Services Proxmox lets you start, stop, restart or reload (its own list; anything else is refused before it gets there). */
export const SERVICES = ["chrony", "corosync", "cron", "ksmtuned", "lxcfs", "postfix", "proxmox-firewall", "pve-cluster", "pve-firewall", "pve-ha-crm", "pve-ha-lrm", "pve-lxc-syscalld", "pvedaemon", "pvefw-logger", "pveproxy", "pvescheduler", "pvestatd", "qmeventd", "spiceproxy", "sshd", "syslog", "systemd-journald", "systemd-timesyncd"] as const;
/** Stopping any of these can cut this node off from its cluster, its sessions or the people running it. */
export const CRITICAL_SERVICES = new Set(["pve-cluster", "corosync", "pvedaemon", "pveproxy", "sshd", "pve-ha-lrm", "pve-ha-crm", "pvescheduler", "pvestatd", "lxcfs"]);
export const SERVICE_ACTIONS = ["start", "stop", "restart", "reload"] as const;

export function timezone(v: unknown): string {
  if (typeof v !== "string" || v.length > 64 || !/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(v)) return bad("Pick a time zone such as Europe/Berlin");
  return v;
}

/** Proxmox's subscription key: pve + level digit + letter + 10 hex characters. */
export function subscriptionKey(v: unknown): string {
  if (typeof v !== "string") return bad("Enter the subscription key");
  const k = v.trim();
  return /^pve[1248][cbsp]-[0-9a-f]{10}$/.test(k) ? k : bad("That doesn't look like a Proxmox VE subscription key (for example pve2c-0123456789)");
}

/** Removes anything secret from text that came back from Proxmox before it can reach a browser or a log. */
export function scrub(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("…");
  return out;
}

// ---- Certificates

export const MAX_CERT_BYTES = 64 * 1024;
export const MAX_KEY_BYTES = 16 * 1024;
const BLOCK = (label: string) => new RegExp(`-----BEGIN ${label}-----\\r?\\n([A-Za-z0-9+/=\\r\\n]+?)\\r?\\n?-----END ${label}-----`, "g");

export interface CheckedCertificate {
  /** The chain, normalized to LF line endings with one trailing newline. */
  pem: string;
  count: number;
  subject: string;
  issuer: string;
  san: string;
  fingerprint256: string;
  validFrom: number;
  validTo: number;
  selfSigned: boolean;
  /** Whether the certificate names 127.0.0.1 or localhost, which ePaperclip uses to reach Proxmox on this machine. */
  coversLoopback: boolean;
  leaf: X509Certificate;
}

export function checkCertificateChain(v: unknown, now: number): CheckedCertificate {
  if (typeof v !== "string" || !v.trim()) return bad("Paste the certificate (PEM)");
  if (Buffer.byteLength(v) > MAX_CERT_BYTES) return bad("That certificate is too large (limit 64 KB)");
  const text = v.replace(/\r\n/g, "\n");
  if (/PRIVATE KEY/.test(text)) return bad("That includes a private key. Paste only the certificate chain here; the key goes in its own box");
  const blocks = [...text.matchAll(BLOCK("CERTIFICATE"))];
  if (blocks.length < 1 || blocks.length > 10) return bad("Expected between 1 and 10 certificates in PEM format (-----BEGIN CERTIFICATE-----)");
  // Nothing may sit between or after the blocks except whitespace.
  if (text.replace(BLOCK("CERTIFICATE"), "").trim() !== "") return bad("The certificate has extra text around the PEM blocks");
  let certs: X509Certificate[];
  try {
    certs = blocks.map((b) => new X509Certificate(b[0]));
  } catch {
    return bad("That isn't a valid certificate (the PEM could not be read)");
  }
  const leaf = certs[0];
  const from = Date.parse(leaf.validFrom);
  const to = Date.parse(leaf.validTo);
  if (to < now) return bad(`This certificate expired on ${new Date(to).toISOString().slice(0, 10)}`);
  if (from > now + 24 * 3600_000) return bad(`This certificate isn't valid until ${new Date(from).toISOString().slice(0, 10)}`);
  const san = leaf.subjectAltName ?? "";
  return {
    pem: `${blocks.map((b) => b[0].trim()).join("\n")}\n`,
    count: certs.length,
    subject: leaf.subject.replace(/\n/g, ", "),
    issuer: leaf.issuer.replace(/\n/g, ", "),
    san,
    fingerprint256: leaf.fingerprint256,
    validFrom: from,
    validTo: to,
    selfSigned: leaf.subject === leaf.issuer,
    coversLoopback: /IP Address:127\.0\.0\.1\b|DNS:localhost\b/.test(san),
    leaf,
  };
}

/** Checks a private key's shape and that it belongs to the certificate. The key is never echoed in any message. */
export function checkPrivateKey(v: unknown, cert: CheckedCertificate): string {
  if (typeof v !== "string" || !v.trim()) return bad("Paste the private key (PEM)");
  if (Buffer.byteLength(v) > MAX_KEY_BYTES) return bad("That private key is too large (limit 16 KB)");
  const text = v.replace(/\r\n/g, "\n");
  if (/BEGIN ENCRYPTED PRIVATE KEY|Proc-Type:.*ENCRYPTED/.test(text)) return bad("The private key is protected with a passphrase. Proxmox needs it without one; remove the passphrase first (openssl pkey -in key.pem -out key-plain.pem)");
  let found: string | null = null;
  for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"]) {
    const m = [...text.matchAll(BLOCK(label))];
    if (m.length > 1) return bad("Paste exactly one private key");
    if (m.length === 1) {
      if (found) return bad("Paste exactly one private key");
      found = m[0][0].trim();
    }
  }
  if (!found) return bad("The private key must be PEM text (-----BEGIN PRIVATE KEY-----)");
  if (text.replace(BLOCK("PRIVATE KEY"), "").replace(BLOCK("RSA PRIVATE KEY"), "").replace(BLOCK("EC PRIVATE KEY"), "").trim() !== "") return bad("The private key has extra text around the PEM block");
  try {
    if (!cert.leaf.checkPrivateKey(createPrivateKey(found))) return bad("This private key doesn't belong to the certificate");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return bad("The private key could not be read");
  }
  return `${found}\n`;
}

// ---- Settings forms driven by Proxmox's own parameter definitions

const NAMED: Record<string, (s: string) => string | null> = {
  "pve-configid": (s) => (/^[A-Za-z][A-Za-z0-9_-]+$/.test(s) && s.length <= 64 ? null : "must start with a letter and use letters, numbers, - and _"),
  "email-list": (s) => (s.split(",").every((e) => /^[^\s@,;<>"]{1,64}@[A-Za-z0-9.-]{1,253}$/.test(e.trim())) ? null : "must be email addresses separated by commas"),
  "email-opt": (s) => (/^[^\s@,;<>"]{1,64}@[A-Za-z0-9.-]{1,253}$/.test(s) ? null : "must be an email address"),
  address: (s) => (/^[A-Za-z0-9.-]{1,253}$/.test(s) || /^[0-9A-Fa-f:]{2,45}$/.test(s) ? null : "must be a host name or IP address"),
  "mac-prefix": (s) => (/^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{1,2}){0,2}$/.test(s) ? null : "must look like BC:24:11"),
  CIDR: (s) => (/^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(s) || /^[0-9A-Fa-f:]{2,39}\/\d{1,3}$/.test(s) ? null : "must be a network such as 10.0.0.0/24"),
  "graphite-path": (s) => (/^[A-Za-z0-9_.-]+$/.test(s) ? null : "may use letters, numbers, . _ and -"),
  "pve-node-location": (s) => (/^latitude=-?\d+(\.\d+)?,longitude=-?\d+(\.\d+)?(,name=[\w .-]{1,64})?$/.test(s) ? null : "must look like latitude=48.1,longitude=11.5"),
  "pve-acme-domain": (s) => (/^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(s) ? null : "must be a domain name"),
  "pve-acme-alias": (s) => (/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(s) ? null : "must be a domain name"),
};

/** Fields that legitimately hold several lines. Everything else is refused if it contains control characters. */
const MULTILINE = new Set(["description", "body"]);
/** Webhook headers and secrets are property strings with a base64 value (name=X-Token,value=...). */
const WEBHOOK_ITEM = /^name=[A-Za-z0-9_-]{1,64}(?:,value=[A-Za-z0-9+/]*={0,2})?$/;
/** List settings whose entries have a fixed shape. */
const ITEM_PATTERNS: Record<string, [RegExp, string]> = {
  header: [WEBHOOK_ITEM, "entries look like name=X-Token,value=<base64>"],
  secret: [WEBHOOK_ITEM, "entries look like name=token,value=<base64>"],
  "match-field": [/^(?:regex|exact):[A-Za-z0-9_-]{1,64}=.{1,256}$/, "entries look like exact:type=vzdump"],
  "match-severity": [/^(?:info|notice|warning|error|unknown)$/, "entries are info, notice, warning, error or unknown"],
  "match-calendar": [/^[A-Za-z0-9:*,./ -]{1,64}$/, "entries are calendar events such as mon..fri 08:00-18:00"],
  target: [/^[A-Za-z][A-Za-z0-9_-]{1,63}$/, "entries are target names"],
  mailto: [/^[^\s@,;<>"]{1,64}@[A-Za-z0-9.-]{1,253}$/, "entries are email addresses"],
  "mailto-user": [/^[^\s@,;<>"]{1,64}@[A-Za-z0-9._-]{1,64}$/, "entries are Proxmox users such as sam@pve"],
};

export interface Checked {
  /** Values ready to send to Proxmox (booleans are 1/0, property strings are composed, arrays stay arrays). */
  params: Record<string, string | number | string[]>;
  /** Settings to clear. */
  remove: string[];
}

export function checkValue(name: string, f: FieldSchema, v: unknown, nested = false): string | number | string[] {
  const label = name;
  switch (f.type) {
    case "boolean": {
      if (typeof v !== "boolean") return bad(`${label} must be on or off`);
      return v ? 1 : 0;
    }
    case "integer":
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v) || (f.type === "integer" && !Number.isInteger(v))) return bad(`${label} must be a ${f.type === "integer" ? "whole " : ""}number`);
      if (f.min !== undefined && v < f.min) return bad(`${label} must be at least ${f.min}`);
      if (f.max !== undefined && v > f.max) return bad(`${label} must be at most ${f.max}`);
      return v;
    }
    case "array": {
      if (!Array.isArray(v) || v.length > 64) return bad(`${label} must be a list of up to 64 entries`);
      const items = f.items ?? { type: "string", description: "" };
      return v.map((x) => {
        const fixed = ITEM_PATTERNS[name];
        if (fixed) {
          if (typeof x !== "string" || !fixed[0].test(x)) return bad(`${label} ${fixed[1]}`);
          return x;
        }
        const c = checkValue(label, items, x, true);
        return String(c);
      });
    }
    case "string": {
      if (f.props) {
        if (!v || typeof v !== "object" || Array.isArray(v)) return bad(`${label} must be a set of options`);
        const o = v as Record<string, unknown>;
        for (const k of Object.keys(o)) if (!(k in f.props)) return bad(`${label} has no option “${k}”`);
        const parts: string[] = [];
        for (const [k, sub] of Object.entries(f.props)) {
          const val = o[k];
          if (val === undefined || val === null || val === "") {
            if (sub.required) return bad(`${label}: ${k} is required`);
            continue;
          }
          const c = checkValue(`${label} ${k}`, sub, val, true);
          parts.push(`${k}=${Array.isArray(c) ? c.join(";") : c}`);
        }
        if (!parts.length) return bad(`${label} needs at least one option`);
        return parts.join(",");
      }
      if (typeof v !== "string") return bad(`${label} must be text`);
      const max = f.maxLength ?? (MULTILINE.has(name) ? 65_536 : 1024);
      if (v.length > max) return bad(`${label} is too long (limit ${max} characters)`);
      if (MULTILINE.has(name) ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) : /[\u0000-\u001f\u007f]/.test(v)) return bad(`${label} can't contain control characters`);
      if (nested && /[,]/.test(v)) return bad(`${label} can't contain a comma`);
      if (f.enum && !f.enum.includes(v)) return bad(`${label} must be one of ${f.enum.join(", ")}`);
      if (f.format && NAMED[f.format]) {
        const why = NAMED[f.format](v);
        if (why) return bad(`${label} ${why}`);
      }
      if (f.pattern && !new RegExp(`^(?:${f.pattern.source})$`, f.pattern.flags).test(v)) return bad(`${label} isn't in the form Proxmox expects`);
      return v;
    }
  }
}

/**
 * Checks `input` against a schema. Unknown settings are refused. `null` or "" clears an optional setting (on update).
 * With `creating`, required settings must be present.
 */
export function checkGroup(schema: Schema, input: Record<string, unknown>, opts: { creating?: boolean; skip?: string[] } = {}): Checked {
  const params: Checked["params"] = {};
  const remove: string[] = [];
  for (const [key, v] of Object.entries(input)) {
    if (opts.skip?.includes(key)) continue;
    const f = schema[key];
    if (!f) return bad(`Unknown setting “${key}”`);
    if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
      if (f.required && opts.creating) return bad(`${key} is required`);
      if (!opts.creating) remove.push(key);
      continue;
    }
    params[key] = checkValue(key, f, v);
  }
  if (opts.creating) for (const [key, f] of Object.entries(schema)) if (f.required && !(key in params) && !opts.skip?.includes(key)) return bad(`${key} is required`);
  return { params, remove };
}

/** Splits a Proxmox property string ("a=1,b=two" or "secure,network=10.0.0.0/24" when the first key is the default one). */
export function parseProps(raw: unknown, schema?: FieldSchema): Record<string, string> {
  if (typeof raw !== "string") return {};
  const defKey = schema?.props ? Object.entries(schema.props).find(([, s]) => s.defaultKey)?.[0] : undefined;
  const out: Record<string, string> = {};
  raw.split(",").forEach((part, i) => {
    const at = part.indexOf("=");
    if (at < 0) {
      if (i === 0 && defKey && part) out[defKey] = part;
      return;
    }
    out[part.slice(0, at)] = part.slice(at + 1);
  });
  return out;
}

/** Reads values Proxmox returned into the shapes the forms edit (property strings become objects, booleans become booleans). */
export function readGroup(schema: Schema, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(schema)) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (f.secret) continue;
    if (f.props) {
      const p = parseProps(v, f);
      const obj: Record<string, unknown> = {};
      for (const [pk, ps] of Object.entries(f.props)) {
        if (p[pk] === undefined) continue;
        obj[pk] = ps.type === "boolean" ? p[pk] === "1" || p[pk] === "true" : ps.type === "integer" || ps.type === "number" ? Number(p[pk]) : p[pk];
      }
      out[k] = obj;
    } else if (f.type === "boolean") out[k] = v === 1 || v === true || v === "1";
    else out[k] = v;
  }
  return out;
}
