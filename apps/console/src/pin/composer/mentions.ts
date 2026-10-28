/**
 * The composer's "@" mentions: a person, an agent, an organization, a machine or a file. Each choice becomes a chip in
 * the field, and the message carries ids, never names, so the agent or Pin knows exactly what was meant.
 */

export type MentionKind = "person" | "agent" | "organization" | "project" | "machine" | "file";

export interface Mention {
  kind: MentionKind;
  /** Stable id: a user name, an agent id, an organization slug, a vmid, a file path. */
  id: string;
  /** What the chip says. */
  label: string;
  /** A second line in the picker: the role, the organization, the path, the machine. */
  detail?: string;
  /** The organization this belongs to, when it has one, so the open organization's things come first. */
  org?: string | null;
}

/** Kind names for the picker's group headings, in reading order. */
export const KIND_LABELS: Record<MentionKind, string> = {
  person: "People",
  agent: "Agents",
  organization: "Organizations",
  project: "Projects",
  machine: "Machines",
  file: "Files",
};

/** The picker's order of kinds: people and agents first, files last (there are the most of them). */
export const KIND_ORDER: MentionKind[] = ["person", "agent", "organization", "project", "machine", "file"];

/**
 * Finds the mention being typed: the "@" and the run of characters after it up to the caret. Only an "@" that starts a
 * word counts (the start of the field, or after a space), so an email address doesn't open the picker.
 */
export function mentionQuery(textBeforeCaret: string): { start: number; query: string } | null {
  const m = /(^|[\s(])@([^\s@]*)$/.exec(textBeforeCaret);
  if (!m) return null;
  const start = textBeforeCaret.length - m[2].length - 1;
  return { start, query: m[2] };
}

const fold = (s: string) => s.toLowerCase();

/** Ranks a mention for a query: a label that starts with it, then one that contains it, then a detail that does. */
function rank(m: Mention, q: string): number {
  if (!q) return 0;
  const label = fold(m.label);
  if (label.startsWith(q)) return 0;
  if (label.includes(q)) return 1;
  if (fold(m.id).includes(q)) return 2;
  if (m.detail && fold(m.detail).includes(q)) return 3;
  return -1;
}

/**
 * Filters and groups the choices for a query. When there is no query the picker starts with the open organization's
 * people, agents and machines (then everyone else's), rather than a wall of every file on every machine.
 */
export function groupMentions(all: Mention[], query: string, openOrg: string | null): { kind: MentionKind; items: Mention[] }[] {
  const q = fold(query.trim());
  let picked: Mention[];
  if (q) {
    picked = all
      .map((m) => ({ m, r: rank(m, q) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r)
      .map((x) => x.m);
  } else {
    // No query: the open organization first, in kind order; then the rest.
    picked = [
      ...all.filter((m) => openOrg && m.org === openOrg && m.kind !== "file"),
      ...all.filter((m) => !(openOrg && m.org === openOrg) || m.kind === "file"),
    ];
  }
  return KIND_ORDER.map((kind) => ({ kind, items: picked.filter((m) => m.kind === kind) })).filter((g) => g.items.length);
}

/** What travels with the message: ids, never names. */
export function mentionContext(mentions: { kind: MentionKind; id: string }[]): { kind: MentionKind; id: string }[] {
  const seen = new Set<string>();
  const out: { kind: MentionKind; id: string }[] = [];
  for (const m of mentions) {
    const key = `${m.kind}:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: m.kind, id: m.id });
  }
  return out;
}

/**
 * The "@name" text the field shows for a chosen mention. A person is written as their Proxmox user (`@sam@pve`), which is
 * how they are addressed everywhere else; everything else uses its label, without spaces.
 */
export function mentionToken(m: { kind: MentionKind; id: string; label: string }): string {
  const text = m.kind === "person" ? m.id : m.label;
  return `@${text.replace(/\s+/g, "-")}`;
}
