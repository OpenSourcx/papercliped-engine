// Builds the signed update feed that installed devices read: updates/feed.json (every published release, which channel it is
// on, its notes, and which ones were withdrawn) and updates/feed.sig (a detached Ed25519 signature over those exact bytes,
// made with the same release key every installer pins). Devices fall back to GitHub's own release list if the feed is
// unreachable, and the update helper checks each release's own signature either way; the feed is what lets a bad release be
// withdrawn and lets the notes and channels be trusted.
//
//   gh api "repos/OpenSourcx/papercliped-engine/releases?per_page=100" > releases.json
//   RELEASE_SIGNING_KEY="$(cat key.pem)" node scripts/build-update-feed.mjs --releases releases.json --out site/updates
//
// Withdrawn versions are listed in deploy/withdrawn-releases.txt (one per line: `1.0.0-rc3 # reason`); editing that file and
// releasing again is how a release is pulled. The result is verified against deploy/release-signing.pub before it is written.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { VERSION_RE, isPrerelease, normalizeVersion, privateKeyFrom, signManifest, verifyManifest } from "./release-lib.mjs";

const root = new URL("../", import.meta.url).pathname;
const MAX_NOTES = 4000;
const REPO_PAGE = "https://github.com/OpenSourcx/papercliped-engine/";

const cmp = (a, b) => {
  const [ac, ap = ""] = normalizeVersion(a).split(/-(.+)/);
  const [bc, bp = ""] = normalizeVersion(b).split(/-(.+)/);
  const x = ac.split(".").map(Number);
  const y = bc.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  if (ap === bp) return 0;
  if (!ap) return 1;
  if (!bp) return -1;
  return ap.localeCompare(bp, "en", { numeric: true });
};

/** Pure: the feed text from GitHub's release list and the withdrawn list. Exported for the tests. */
export function buildFeed(releases, withdrawnText = "", now = new Date()) {
  const withdrawn = new Map();
  for (const line of withdrawnText.split("\n")) {
    const m = /^\s*v?([0-9][^\s#]*)\s*(?:#\s*(.*))?$/.exec(line);
    if (m && VERSION_RE.test(m[1])) withdrawn.set(m[1], (m[2] ?? "").trim().slice(0, 200));
  }
  const out = [];
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft === true) continue;
    const version = normalizeVersion(r.tag_name ?? "");
    if (!VERSION_RE.test(version)) continue;
    const url = typeof r.html_url === "string" && r.html_url.startsWith(REPO_PAGE) ? r.html_url : `${REPO_PAGE}releases`;
    out.push({
      version,
      channel: r.prerelease === true || isPrerelease(version) ? "rc" : "stable",
      publishedAt: typeof r.published_at === "string" && !Number.isNaN(Date.parse(r.published_at)) ? r.published_at : null,
      notes: String(r.body ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, MAX_NOTES),
      url,
      withdrawn: withdrawn.has(version),
      ...(withdrawn.has(version) ? { withdrawnReason: withdrawn.get(version) } : {}),
    });
  }
  out.sort((a, b) => cmp(b.version, a.version));
  const live = out.filter((r) => !r.withdrawn);
  const channels = { stable: live.find((r) => r.channel === "stable")?.version ?? null, rc: live[0]?.version ?? null };
  return `${JSON.stringify({ format: 1, generatedAt: now.toISOString(), channels, releases: out.slice(0, 60) }, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const fail = (m) => { console.error(`build-update-feed: ${m}`); process.exit(1); };
  const secret = process.env.RELEASE_SIGNING_KEY;
  if (!secret?.trim()) fail("RELEASE_SIGNING_KEY is not set, so the feed was NOT written.");
  let priv; try { priv = privateKeyFrom(secret); } catch { fail("RELEASE_SIGNING_KEY is not a PEM private key."); }
  const pub = readFileSync(arg("--public", `${root}deploy/release-signing.pub`), "utf8");
  let releases; try { releases = JSON.parse(readFileSync(arg("--releases", ""), "utf8")); } catch { fail("--releases must be a JSON file from the GitHub releases API."); }
  let withdrawn = ""; try { withdrawn = readFileSync(arg("--withdrawn", `${root}deploy/withdrawn-releases.txt`), "utf8"); } catch { /* none withdrawn */ }
  const feed = buildFeed(releases, withdrawn);
  const sig = signManifest(feed, priv);
  if (!verifyManifest(feed, sig, pub)) fail("the signature does not verify against the pinned public key; nothing was written.");
  const out = arg("--out", "updates").replace(/\/?$/, "/");
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}feed.json`, feed);
  writeFileSync(`${out}feed.sig`, sig);
  console.log(`build-update-feed: ${JSON.parse(feed).releases.length} releases, signed -> ${out}feed.json, feed.sig`);
}
