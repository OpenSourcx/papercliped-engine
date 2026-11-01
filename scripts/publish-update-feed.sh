#!/usr/bin/env bash
# Publishes the signed update feed (feed.json and feed.sig) to Cloudflare R2, served at
# https://updates.papercliped.co/feed.json (scripts/r2.sh). Installed devices read it to learn what is available on their
# channel and which releases were withdrawn. Run by CI after a release is published; it needs RELEASE_SIGNING_KEY (the same
# key every installer pins), `gh` with a token, and the R2 credentials.
#
#   RELEASE_SIGNING_KEY="$(cat key.pem)" GH_TOKEN=... R2_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
#     bash scripts/publish-update-feed.sh
#   RELEASE_SIGNING_KEY=... EPC_RELEASES_JSON=releases.json bash scripts/publish-update-feed.sh --local <dir>   no network, no push
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/r2.sh
. "$ROOT/scripts/r2.sh"
die() { echo "publish-update-feed: $*" >&2; exit 1; }
[ -n "${RELEASE_SIGNING_KEY:-}" ] || die "RELEASE_SIGNING_KEY isn't set, so the feed was not published"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

json="${EPC_RELEASES_JSON:-}"
if [ -z "$json" ]; then
  json="$work/releases.json"
  gh api "repos/${GITHUB_REPOSITORY:-OpenSourcx/papercliped-engine}/releases?per_page=100" >"$json" || die "couldn't read the release list"
fi

if [ "${1:-}" = "--local" ]; then
  node "$ROOT/scripts/build-update-feed.mjs" --releases "$json" --out "${2:?usage: --local <dir>}"
  exit 0
fi

r2_ready || die "R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY aren't set, so the feed was not published"
node "$ROOT/scripts/build-update-feed.mjs" --releases "$json" --out "$work/feed"
# A short cache, so a withdrawn release reaches devices within minutes. The feed first, then its signature: a device that reads
# the two in between sees a bad signature and uses GitHub's release list instead, which is safe.
for f in feed.json:application/json feed.sig:text/plain; do
  r2 cp "$work/feed/${f%%:*}" "s3://$R2_BUCKET/${f%%:*}" --content-type "${f#*:}" --cache-control "public, max-age=300"
done
echo "publish-update-feed: published $EPC_UPDATES_BASE/feed.json"
