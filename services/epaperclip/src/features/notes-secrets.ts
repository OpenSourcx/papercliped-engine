/**
 * Secret detection for Notes. Before any text is sent to a model (or shown in a sort preview) it goes through
 * `scanSecrets`: every likely secret (private keys, API tokens, passwords in `key: value` or sentence form, URLs with
 * credentials, password hashes, long random-looking strings) is replaced by a placeholder, and the values are handed back
 * separately so the host service can keep them (vault) or drop them. The model only ever sees the placeholders.
 *
 * This is a safety net, not a guarantee: patterns miss things. The page says so, and a person can always redact more.
 */

export type SecretKind = "private-key" | "token" | "password" | "url-credentials" | "hash" | "api-key" | "high-entropy";

export interface SecretFinding {
  /** s1, s2 ... in text order. */
  id: string;
  kind: SecretKind;
  /** A name for the secret a person recognises: the key it was assigned to ("db_password"), or the kind. */
  label: string;
  /** 1-based line of the first character. */
  line: number;
  /** The secret itself. Server side only: never return it in a list or a preview. */
  value: string;
}

export type PublicFinding = Omit<SecretFinding, "value"> & { length: number };

export interface Scan {
  redacted: string;
  findings: SecretFinding[];
}

export const placeholder = (kind: SecretKind, id: string) => `⟦redacted:${kind}:${id}⟧`;
/** Matches a placeholder in a body; group 1 is the kind, group 2 the id. */
export const PLACEHOLDER = /⟦redacted:([a-z-]+):(s\d+)⟧/g;

export const publicFinding = (f: SecretFinding): PublicFinding => ({ id: f.id, kind: f.kind, label: f.label, line: f.line, length: f.value.length });

interface Range {
  start: number;
  end: number;
  kind: SecretKind;
  label: string;
}

const KEY_WORDS = "password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth(?!or)|credential|private[_-]?key|root[_-]?pw";

/** Each rule yields ranges of the secret value only, so the key name stays readable. */
const RULES: { kind: SecretKind; re: RegExp; group?: number; label?: (m: RegExpExecArray) => string }[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { kind: "token", re: /PVEAPIToken=[^\s=]+!([^\s=]+)=([0-9a-f-]{20,})/g, group: 2, label: () => "Proxmox API token" },
  { kind: "token", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, label: () => "AWS access key" },
  { kind: "token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, label: () => "GitHub token" },
  { kind: "token", re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, label: () => "GitHub token" },
  { kind: "token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, label: () => "Slack token" },
  { kind: "api-key", re: /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}\b/g, label: () => "API key" },
  { kind: "api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: () => "API key" },
  { kind: "token", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, label: () => "JWT" },
  { kind: "token", re: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g, group: 1, label: () => "Bearer token" },
  { kind: "url-credentials", re: /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@]+:([^\s/@]+)@[^\s]+/gi, group: 1, label: () => "URL password" },
  { kind: "hash", re: /\$(?:1|5|6|y|2[aby])\$[A-Za-z0-9./$,=-]{8,}/g, label: () => "password hash" },
  // command line flags: --password hunter2, --password=hunter2, --token abc
  { kind: "password", re: /--(?:password|passwd|token|secret|api-key)(?:=|\s+)(?!-)(["']?)([^\s"']{3,})\1/gi, group: 2, label: () => "command line secret" },
  // key: value, key = value, "key": "value", export KEY=value
  { kind: "password", re: new RegExp(`(["']?\\b[\\w.-]*(?:${KEY_WORDS})[\\w.-]*["']?)\\s*[:=]\\s*(["']?)((?!\\s)[^\\s"',;]{3,})\\2`, "gi"), group: 3, label: (m) => m[1].replace(/["']/g, "").slice(0, 60) },
  // sentences: "the root password is hunter2", "password hunter2"
  { kind: "password", re: /\b(?:password|passwd|passphrase|pw)\s+(?:is|was|=)\s+(["']?)([^\s"',;]{3,})\1/gi, group: 2, label: () => "password" },
];

const PLAIN_WORDS = /^(?:\d{1,7}|true|false|null|none|yes|no|empty|changeme|example|xxx+|\*+|<[^>]*>|\$\{?[A-Za-z_]+\}?|\[?redacted.*|⟦.*)$/i;
const isPlaceholderValue = (v: string) => PLAIN_WORDS.test(v) || v.startsWith("⟦");

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Long random-looking strings that no other rule named: mixed case and digits, high entropy, not a path, hash or id. */
function entropyRanges(text: string): Range[] {
  const out: Range[] = [];
  for (const m of text.matchAll(/(?<![\w/.+-])[A-Za-z0-9+/_=-]{32,}(?![\w/+-])/g)) {
    const s = m[0];
    if (/^[0-9a-f]+$/i.test(s)) continue; // checksums and ids
    if (!/[a-z]/.test(s) || !/[A-Z0-9]/.test(s) || !/\d/.test(s)) continue;
    if ((s.match(/\//g) ?? []).length > 2) continue; // looks like a path
    if (entropy(s) < 4.2) continue;
    out.push({ start: m.index!, end: m.index! + s.length, kind: "high-entropy", label: "random-looking string" });
  }
  return out;
}

const lineOf = (text: string, index: number) => {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

/** `startAt` continues the numbering (s<startAt+1> ...) so new placeholders never collide with ones already in a text. */
export function scanSecrets(text: string, startAt = 0): Scan {
  const ranges: Range[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`))) {
      const g = rule.group ?? 0;
      const value = m[g];
      if (!value || isPlaceholderValue(value)) continue;
      const offset = g === 0 ? 0 : m[0].lastIndexOf(value);
      const start = m.index! + offset;
      ranges.push({ start, end: start + value.length, kind: rule.kind, label: rule.label ? rule.label(m as RegExpExecArray) : rule.kind });
    }
  }
  ranges.push(...entropyRanges(text));
  // Overlaps: the earliest, then the longest, wins; the rest are covered by it.
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) {
      if (r.end > last.end) last.end = r.end;
      continue;
    }
    merged.push({ ...r });
  }
  const findings: SecretFinding[] = [];
  let redacted = "";
  let at = 0;
  merged.forEach((r, i) => {
    const id = `s${startAt + i + 1}`;
    findings.push({ id, kind: r.kind, label: r.label || r.kind, line: lineOf(text, r.start), value: text.slice(r.start, r.end) });
    redacted += text.slice(at, r.start) + placeholder(r.kind, id);
    at = r.end;
  });
  redacted += text.slice(at);
  return { redacted, findings };
}

/** Puts the original values back where a body still holds their placeholders (the explicit "keep as written" choice). */
export function restoreSecrets(body: string, findings: readonly SecretFinding[]): string {
  const byId = new Map(findings.map((f) => [f.id, f.value]));
  return body.replace(PLACEHOLDER, (all, _k, id) => byId.get(id) ?? all);
}

/** The placeholders a body still holds, in order. */
export function placeholdersIn(body: string): string[] {
  return [...body.matchAll(PLACEHOLDER)].map((m) => m[2]);
}
