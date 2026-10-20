// Writes the release notes for a tag: what people read in the console's "What's new", on the GitHub release page and in the
// signed update feed.
//
//   node scripts/release-notes.mjs --tag v1.0.0-rc16 [--previous v1.0.0-rc15] [--out release/notes.md]
//
// Where the words come from, in order:
//   1. CHANGELOG.md: a section titled `## 1.0.0-rc16` (or `## Unreleased`) that someone wrote by hand. It wins.
//   2. The commit messages since the previous release: each commit's first line is a heading and the first paragraph of its
//      body the explanation. Write commit messages as release notes (what changed, for whom, in plain words) and these come
//      out right on their own.
// Merge commits and bookkeeping (version bumps, "Merge ...") are left out. Nothing here needs a network.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const REPO = "https://github.com/OpenSourcx/papercliped-engine";
const MAX = 3800; // the console keeps 4000 characters of notes

const run = (args, cwd) => execFileSync("git", args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] }).trim();

/** The hand-written section for this version, or "Unreleased", if it has anything in it. */
export function fromChangelog(text, version) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const want = [`## ${version}`, `## v${version}`, "## Unreleased"];
  for (const title of want) {
    const at = lines.findIndex((l) => l.trim().toLowerCase().startsWith(title.toLowerCase()));
    if (at < 0) continue;
    let end = lines.findIndex((l, i) => i > at && /^## /.test(l));
    if (end < 0) end = lines.length;
    const body = lines.slice(at + 1, end).join("\n").trim();
    if (body) return body;
  }
  return null;
}

const SKIP = /^(merge\b|bump\b|version\b|release\b|co-authored-by:|claude-session:)/i;

/** Commits as notes. `commits` is [{subject, body}] newest first. */
export function fromCommits(commits) {
  const seen = new Set();
  const out = [];
  for (const c of commits) {
    const subject = c.subject.trim().replace(/\.$/, "");
    if (!subject || SKIP.test(subject) || seen.has(subject.toLowerCase())) continue;
    seen.add(subject.toLowerCase());
    const para = c.body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !SKIP.test(p)) ?? "";
    const text = para.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").slice(0, 420);
    out.push(`- **${subject}.**${text ? ` ${text}` : ""}`);
  }
  return out.join("\n");
}

export function buildNotes({ tag, previous, changelog, commits }) {
  const version = tag.replace(/^v/, "");
  const body = (changelog ? fromChangelog(changelog, version) : null) ?? fromCommits(commits);
  const link = previous ? `\n\n**Full changelog:** ${REPO}/compare/${previous}...${tag}` : "";
  let notes = body ? `## What's new in ${version}\n\n${body}` : `## ${version}\n\nNo notes were written for this release.`;
  if (notes.length > MAX) notes = `${notes.slice(0, MAX).replace(/\s+\S*$/, "")} …`;
  return `${notes}${link}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const root = new URL("../", import.meta.url).pathname;
  const tag = arg("--tag", "");
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(tag)) { console.error("release-notes: --tag must look like v1.0.0 or v1.0.0-rc1"); process.exit(1); }
  let previous = arg("--previous", "");
  if (!previous) {
    try {
      const tags = run(["tag", "--list", "v*", "--sort=-v:refname"], root).split("\n").filter(Boolean);
      previous = tags[tags.indexOf(tag) + 1] ?? "";
    } catch { /* no history to look at */ }
  }
  let commits = [];
  try {
    const range = previous ? `${previous}..${tag}` : tag;
    const raw = run(["log", "--no-merges", "--format=%x1e%s%x1f%b", range], root);
    commits = raw.split("\x1e").filter(Boolean).map((r) => { const [subject, body = ""] = r.split("\x1f"); return { subject: subject.trim(), body }; });
  } catch { /* the tag may not exist locally yet */ }
  const changelog = existsSync(`${root}CHANGELOG.md`) ? readFileSync(`${root}CHANGELOG.md`, "utf8") : "";
  const notes = buildNotes({ tag, previous, changelog, commits });
  const out = arg("--out", "");
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, notes); console.log(`release-notes: ${tag} -> ${out}`); } else process.stdout.write(notes);
}
