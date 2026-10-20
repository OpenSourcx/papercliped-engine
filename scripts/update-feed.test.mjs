import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFeed } from "./build-update-feed.mjs";
import { generateReleaseKey, privateKeyFrom, signManifest, verifyManifest } from "./release-lib.mjs";

const rel = (tag, extra = {}) => ({ tag_name: tag, body: "notes\r\nmore", html_url: `https://github.com/OpenSourcx/papercliped-engine/releases/tag/${tag}`, published_at: "2026-10-01T00:00:00Z", draft: false, prerelease: tag.includes("-"), ...extra });

test("orders newest first and assigns each release to its channel", () => {
  const f = JSON.parse(buildFeed([rel("v1.0.0-rc2"), rel("v1.0.0"), rel("v1.0.0-rc10"), rel("v0.9.0"), rel("v1.0.1-rc1", { draft: true })]));
  assert.deepEqual(f.releases.map((r) => r.version), ["1.0.0", "1.0.0-rc10", "1.0.0-rc2", "0.9.0"]);
  assert.deepEqual(f.channels, { stable: "1.0.0", rc: "1.0.0" });
  assert.equal(f.releases[1].channel, "rc");
});

test("with only candidates there is no stable channel", () => {
  const f = JSON.parse(buildFeed([rel("v1.0.0-rc1"), rel("v1.0.0-rc2")]));
  assert.deepEqual(f.channels, { stable: null, rc: "1.0.0-rc2" });
});

test("a withdrawn release is marked, never the channel's newest, and keeps its reason", () => {
  const f = JSON.parse(buildFeed([rel("v1.0.0-rc3"), rel("v1.0.0-rc2")], "# note\n1.0.0-rc3 # broke the engine restart\n"));
  assert.equal(f.releases[0].withdrawn, true);
  assert.equal(f.releases[0].withdrawnReason, "broke the engine restart");
  assert.equal(f.channels.rc, "1.0.0-rc2");
});

test("skips entries that aren't versions, cleans notes and foreign links", () => {
  const f = JSON.parse(buildFeed([rel("nightly"), rel("v1.0.0", { body: "a\u0000b", html_url: "https://evil.test/x" })]));
  assert.equal(f.releases.length, 1);
  assert.equal(f.releases[0].notes, "ab");
  assert.match(f.releases[0].url, /^https:\/\/github\.com\/OpenSourcx\/papercliped-engine\//);
});

test("the signature covers the exact bytes and fails when they change", () => {
  const { publicPem, privatePem } = generateReleaseKey();
  const feed = buildFeed([rel("v1.0.0")]);
  const sig = signManifest(feed, privateKeyFrom(privatePem));
  assert.equal(verifyManifest(feed, sig, publicPem), true);
  assert.equal(verifyManifest(feed.replace("1.0.0", "1.0.1"), sig, publicPem), false);
});
