import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNotes, fromChangelog, fromCommits } from "./release-notes.mjs";

const commits = [
  { subject: "Task log: read the log after the status.", body: "The window showed 'no content' on a finished task.\nIt now reads again.\n\nCo-Authored-By: x\nClaude-Session: y" },
  { subject: "Merge branch 'x'", body: "" },
  { subject: "Updates: rc13 is newer than rc9", body: "Labels compared as text.\n\nMore detail nobody needs." },
  { subject: "Task log: read the log after the status", body: "duplicate" },
];

test("commit messages become notes: subject as the heading, first paragraph as the explanation, merges and duplicates dropped", () => {
  const n = fromCommits(commits);
  assert.equal(n.split("\n").length, 2);
  assert.match(n, /^- \*\*Task log: read the log after the status\.\*\* The window showed 'no content' on a finished task\. It now reads again\./);
  assert.doesNotMatch(n, /Merge|Co-Authored|nobody needs/);
});

test("a hand-written CHANGELOG section for the version wins over commits, and Unreleased is the fallback", () => {
  const log = "# Changelog\n\n## Unreleased\n- Draft thing\n\n## 1.0.0-rc15\n- Written by hand\n\n## 1.0.0-rc14\n- Old\n";
  assert.equal(fromChangelog(log, "1.0.0-rc15"), "- Written by hand");
  assert.equal(fromChangelog(log, "1.0.0-rc16"), "- Draft thing");
  assert.equal(fromChangelog("## Unreleased\n\n## 1.0.0-rc1\n- x", "1.0.0-rc2"), null);
  const n = buildNotes({ tag: "v1.0.0-rc15", previous: "v1.0.0-rc14", changelog: log, commits });
  assert.match(n, /^## What's new in 1\.0\.0-rc15\n\n- Written by hand/);
  assert.match(n, /compare\/v1\.0\.0-rc14\.\.\.v1\.0\.0-rc15/);
});

test("with nothing to say it says so, and long notes are cut at a word", () => {
  assert.match(buildNotes({ tag: "v1.0.0", previous: "", changelog: "", commits: [] }), /No notes were written/);
  const long = buildNotes({ tag: "v1.0.0", previous: "", changelog: "", commits: Array.from({ length: 80 }, (_, i) => ({ subject: `Change number ${i}`, body: "x ".repeat(100) })) });
  assert.ok(long.length < 4000);
  assert.match(long, /…\n$/);
});
