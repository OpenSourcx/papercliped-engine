#!/usr/bin/env bash
# Builds the signed update feed (feed.json and feed.sig), which CI uploads to https://updates.papercliped.co/. Installed devices
# read it to learn what is available on their channel and which releases were withdrawn. It needs RELEASE_SIGNING_KEY (the same
# key every installer pins); use GitHub's release API by default or EPC_RELEASES_JSON for a local input.
#
#   RELEASE_SIGNING_KEY=... EPC_RELEASES_JSON=releases.json bash scripts/publish-update-feed.sh --local <dir>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
die() { echo "publish-update-feed: $*" >&2; exit 1; }
[ -n "${RELEASE_SIGNING_KEY:-}" ] || die "RELEASE_SIGNING_KEY isn't set, so the feed was not published"

work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

json="${EPC_RELEASES_JSON:-}"
if [ -z "$json" ]; then
  json="$work/releases.json"
  gh api "repos/${GITHUB_REPOSITORY:-OpenSourcx/papercliped-engine}/releases?per_page=100" >"$json" || die "couldn't read the release list"
fi

[ "${1:-}" = "--local" ] || die "usage: publish-update-feed.sh --local <dir>"
node "$ROOT/scripts/build-update-feed.mjs" --releases "$json" --out "${2:?usage: publish-update-feed.sh --local <dir>}"
echo "publish-update-feed: built ${2}"
