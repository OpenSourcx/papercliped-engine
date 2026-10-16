import { INBOX, LIMITS, titleFrom, type NoteLink } from "./notes-core.ts";

/**
 * The part of Notes that needs no model: cutting a pasted blob into separate notes, and a keyword sorter that proposes a
 * folder, tags and a title from IP addresses, machine ids, URLs, commands and words. It is the fallback when no model
 * is configured or the model fails, and what the tests use. It is deterministic and has no side effects.
 */

export const MAX_BLOB = 120_000;
export const MAX_CHUNKS = 60;

const SEPARATOR = /^\s*(?:-{3,}|={3,}|\*{3,}|_{3,}|#{3,}\s*)\s*$/;
const HEADING = /^#{1,2}\s+\S/;
const FENCE = /^\s*(```|~~~)/;

/** Cuts a blob at separator lines, top-level headings and runs of blank lines, never inside a code fence. */
export function splitBlob(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const chunks: string[][] = [[]];
  let fence: string | null = null;
  let blanks = 0;
  const cut = () => {
    if (chunks[chunks.length - 1].some((l) => l.trim())) chunks.push([]);
  };
  for (const line of lines) {
    const f = FENCE.exec(line)?.[1];
    if (fence) {
      chunks[chunks.length - 1].push(line);
      if (f === fence) fence = null;
      continue;
    }
    if (f) {
      fence = f;
      blanks = 0;
      chunks[chunks.length - 1].push(line);
      continue;
    }
    if (SEPARATOR.test(line)) {
      blanks = 0;
      cut();
      continue;
    }
    if (!line.trim()) {
      blanks++;
      chunks[chunks.length - 1].push(line);
      if (blanks === 2) cut();
      continue;
    }
    if (HEADING.test(line) && chunks[chunks.length - 1].some((l) => l.trim())) cut();
    blanks = 0;
    chunks[chunks.length - 1].push(line);
  }
  let out = chunks.map((c) => c.join("\n").trim()).filter(Boolean);
  // Scraps join the note before them.
  const merged: string[] = [];
  for (const c of out) {
    if (merged.length && c.length < 24 && !HEADING.test(c)) merged[merged.length - 1] += `\n\n${c}`;
    else merged.push(c);
  }
  out = merged;
  // Too many pieces: the last ones are kept together rather than lost.
  if (out.length > MAX_CHUNKS) out = [...out.slice(0, MAX_CHUNKS - 1), out.slice(MAX_CHUNKS - 1).join("\n\n")];
  return out;
}

// ---- Classification

interface Category {
  folder: string;
  /** Word patterns; each distinct hit counts once. */
  words: RegExp[];
  tags: string[];
}

const w = (...s: string[]) => s.map((x) => new RegExp(x, "i"));

export const CATEGORIES: Category[] = [
  { folder: "Runbooks", tags: ["runbook"], words: w("\\brunbook\\b", "\\bprocedure\\b", "\\bstep \\d\\b", "^\\s*\\d+[.)]\\s", "\\bhow to\\b", "\\brestore\\b", "\\brollback\\b", "\\bfailover\\b", "\\bchecklist\\b", "\\bplaybook\\b") },
  { folder: "Networking", tags: ["network"], words: w("\\bvlan\\b", "\\bgateway\\b", "\\bsubnet\\b", "\\bdns\\b", "\\bdhcp\\b", "\\bvmbr\\d+\\b", "\\bbridge\\b", "\\bfirewall\\b", "\\bnetmask\\b", "\\bmtu\\b", "\\bwireguard\\b", "\\bvpn\\b", "\\bcidr\\b", "\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?:/\\d{1,2})?\\b", "\\bpfsense\\b", "\\bopnsense\\b") },
  { folder: "Storage and backups", tags: ["storage"], words: w("\\bzfs\\b", "\\bzpool\\b", "\\bceph\\b", "\\blvm\\b", "\\bnfs\\b", "\\bsmb\\b", "\\biscsi\\b", "\\bvzdump\\b", "\\bbackup", "\\bsnapshot", "\\bpbs\\b", "\\bdatastore\\b", "\\braid\\b", "\\bsmart\\b", "\\bdisk\\b") },
  { folder: "Logs and errors", tags: ["logs"], words: w("\\berror\\b", "\\bfailed\\b", "\\btraceback\\b", "\\bjournalctl\\b", "\\bsyslog\\b", "\\bkernel:", "\\bwarning\\b", "\\bexception\\b", "\\bpanic\\b", "^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}", "^[A-Z][a-z]{2}\\s+\\d{1,2}\\s\\d{2}:\\d{2}:\\d{2}", "\\bTASK (?:ERROR|OK)\\b", "\\bcore dump") },
  { folder: "Snippets", tags: ["snippet"], words: w("^\\s*```", "^\\s*[$#]\\s+\\S", "\\bsudo\\b", "\\bapt(?:-get)?\\s+(?:install|update|upgrade)\\b", "\\bqm\\s+\\w+", "\\bpct\\s+\\w+", "\\bpvesm\\b", "\\bpvecm\\b", "\\bcurl\\s+-", "\\bsystemctl\\b", "\\bchmod\\b", "\\bgrep\\b", "\\bssh\\s+\\S+@", "\\brsync\\b") },
  { folder: "Tickets", tags: ["ticket"], words: w("\\bticket\\b", "\\b[A-Z]{2,8}-\\d{1,6}\\b", "\\bINC\\d{5,}\\b", "\\bcase #?\\d+", "\\bpriority\\b", "\\bassigned to\\b", "\\bcustomer reports?\\b", "\\bsteps to reproduce\\b", "\\bexpected\\b.*\\bactual\\b") },
  { folder: "To-do", tags: ["todo"], words: w("^\\s*[-*]\\s+\\[[ xX]\\]", "\\btodo\\b", "\\bto-do\\b", "\\bremember to\\b", "\\bdon't forget\\b", "\\bneed to\\b", "\\bfollow up\\b", "\\bby (?:monday|friday|tomorrow|next week)\\b") },
  { folder: "Machines", tags: ["machines"], words: w("\\bvmid\\b", "\\b(?:vm|ct|lxc|qemu|container)\\s*#?\\d{3,}\\b", "\\bcloud-init\\b", "\\bvirtio\\b", "\\bcpu\\b", "\\bram\\b", "\\bhostname\\b", "\\btemplate\\b", "\\bhypervisor\\b", "\\bpassthrough\\b", "\\bgpu\\b") },
];

/** Single-word topics that become tags wherever they appear. */
const TOPIC_TAGS: [RegExp, string][] = [
  [/\bzfs\b/i, "zfs"], [/\bceph\b/i, "ceph"], [/\blvm\b/i, "lvm"], [/\bnfs\b/i, "nfs"], [/\bvlan\b/i, "vlan"], [/\bdns\b/i, "dns"], [/\bdhcp\b/i, "dhcp"],
  [/\bwireguard\b/i, "wireguard"], [/\bvpn\b/i, "vpn"], [/\bfirewall\b/i, "firewall"], [/\bnginx\b/i, "nginx"], [/\bdocker\b/i, "docker"], [/\bpostgres(?:ql)?\b/i, "postgres"],
  [/\bmysql\b|\bmariadb\b/i, "mysql"], [/\bcertificate\b|\bacme\b|\bletsencrypt\b|\bssl\b|\btls\b/i, "tls"], [/\bcron\b/i, "cron"], [/\bsystemd\b|\bsystemctl\b/i, "systemd"],
  [/\bssh\b/i, "ssh"], [/\bapt\b|\bdpkg\b/i, "apt"], [/\bvzdump\b|\bbackup/i, "backup"], [/\bsnapshot/i, "snapshot"], [/\bpbs\b/i, "pbs"], [/\bcluster\b|\bcorosync\b|\bquorum\b/i, "cluster"],
  [/\bha\b|\bhigh availability\b/i, "ha"], [/\bgpu\b|\bpassthrough\b/i, "passthrough"], [/\bcloud-init\b/i, "cloud-init"], [/\bupgrade\b|\bupdate\b/i, "updates"], [/\bsmart\b|\bsmartctl\b/i, "smart"],
  [/\bhome ?assistant\b/i, "home-assistant"], [/\bplex\b|\bjellyfin\b/i, "media"], [/\bpihole\b|\badguard\b/i, "dns"],
];

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

export interface RuleResult {
  title: string;
  folder: string;
  tags: string[];
  confidence: number;
  reasons: string[];
}

export function classify(text: string): RuleResult {
  const lines = text.split("\n");
  const urls = text.match(URL_RE) ?? [];
  const nonEmpty = lines.filter((l) => l.trim());
  const urlLines = nonEmpty.filter((l) => /^\s*(?:[-*]\s+)?(?:\[[^\]]*\]\()?\s*https?:\/\//i.test(l)).length;
  const scores = CATEGORIES.map((c) => {
    let hits = 0;
    const seen: string[] = [];
    for (const re of c.words) {
      const matched = re.source.startsWith("^") ? lines.some((l) => re.test(l)) : re.test(text);
      if (matched) {
        hits++;
        seen.push(re.source);
      }
    }
    return { c, hits };
  });
  let best = scores.reduce((a, b) => (b.hits > a.hits ? b : a));
  const reasons: string[] = [];
  let folder = INBOX;
  let confidence = 0.3;
  const tags = new Set<string>();
  if (nonEmpty.length && urlLines / nonEmpty.length >= 0.6) {
    folder = "Links";
    confidence = 0.9;
    tags.add("links");
    reasons.push("Mostly web addresses");
  } else if (best.hits >= 1) {
    folder = best.c.folder;
    confidence = best.hits >= 3 ? 0.9 : best.hits === 2 ? 0.8 : 0.6;
    for (const t of best.c.tags) tags.add(t);
    reasons.push(`Looks like ${best.c.folder.toLowerCase()} (${best.hits} matching word${best.hits === 1 ? "" : "s"})`);
  } else reasons.push("Nothing in it matched a topic, so it stays in the Inbox");
  for (const [re, tag] of TOPIC_TAGS) if (re.test(text) && tags.size < 6) tags.add(tag);
  if ((text.match(IPV4) ?? []).length) tags.add("network");
  if (urls.length && folder !== "Links" && tags.size < 8) tags.add("links");
  return { title: titleFrom(text), folder, tags: [...tags].slice(0, 8), confidence, reasons };
}

// ---- Recognising the person's own machines, storage and organizations

export interface Inventory {
  machines: { vmid: number; name: string; type: string; ips: string[] }[];
  storages: string[];
  orgs: { id: string; name: string }[];
}

export const EMPTY_INVENTORY: Inventory = { machines: [], storages: [], orgs: [] };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const whole = (name: string, flags = "i") => new RegExp(`(?<![\\w.-])${escape(name)}(?![\\w-])`, flags);

/** Links to things in `inv` that the text names by id, name or address. Only what the person can see is in `inv`. */
export function matchLinks(text: string, inv: Inventory): NoteLink[] {
  const out: NoteLink[] = [];
  const add = (l: NoteLink) => {
    if (out.length < LIMITS.links && !out.some((x) => x.kind === l.kind && x.id === l.id)) out.push(l);
  };
  const ids = new Set<number>();
  for (const m of text.matchAll(/\b(?:vmid|vm|ct|lxc|qemu|machine|guest|container)\s*[#:=-]?\s*(\d{3,9})\b/gi)) ids.add(Number(m[1]));
  for (const m of text.matchAll(/\b(?:qm|pct)\s+[a-z-]+\s+(\d{3,9})\b/g)) ids.add(Number(m[1]));
  for (const m of text.matchAll(/\/(?:vms|lxc|qemu|qemu-server|nodes\/[\w-]+\/(?:qemu|lxc))\/(\d{3,9})\b/g)) ids.add(Number(m[1]));
  for (const m of text.matchAll(/\bvm-(\d{3,9})-disk/g)) ids.add(Number(m[1]));
  const ips = new Set(text.match(IPV4) ?? []);
  for (const g of inv.machines) {
    const label = `${g.name} #${g.vmid}`;
    if (ids.has(g.vmid)) add({ kind: "machine", id: String(g.vmid), label });
    else if (g.ips.some((ip) => ips.has(ip))) add({ kind: "machine", id: String(g.vmid), label });
    else if (g.name.length >= 3 && whole(g.name, g.name.length < 5 ? "" : "i").test(text)) add({ kind: "machine", id: String(g.vmid), label });
  }
  for (const s of inv.storages) {
    const loose = s.length >= 4 && !/^(local|data|backup|storage)$/i.test(s);
    if (loose ? whole(s, "").test(text) : new RegExp(`(?:\\bstorage\\s+${escape(s)}\\b|(?<![\\w.-])${escape(s)}:(?:\\s|\\S))`).test(text)) add({ kind: "storage", id: s, label: s });
  }
  for (const o of inv.orgs) if (o.name.length >= 3 && whole(o.name).test(text)) add({ kind: "org", id: o.id, label: o.name });
  return out;
}
