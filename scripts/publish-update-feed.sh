#!/usr/bin/env bash
# Publishes the signed update feed (updates/feed.json and updates/feed.sig) to the gh-pages branch, served by GitHub Pages at
# https://opensourcx.github.io/papercliped-engine/updates/feed.json. Installed devices read it to learn what is available on
# their channel and which releases were withdrawn. Run by CI after a release is published; it needs RELEASE_SIGNING_KEY (the
# same key every installer pins) and `gh` with a token.
#
#   RELEASE_SIGNING_KEY="$(cat key.pem)" GH_TOKEN=... bash scripts/publish-update-feed.sh
#   RELEASE_SIGNING_KEY=... EPC_RELEASES_JSON=releases.json bash scripts/publish-update-feed.sh --local <dir>   no network, no push
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
die() { echo "publish-update-feed: $*" >&2; exit 1; }
[ -n "${RELEASE_SIGNING_KEY:-}" ] || die "RELEASE_SIGNING_KEY isn't set, so the feed was not published"

work="$(mktemp -d)"; site=""
cleanup() { rm -rf "$work"; [ -z "$site" ] || git -C "$ROOT" worktree remove --force "$site" >/dev/null 2>&1 || true; }
trap cleanup EXIT

json="${EPC_RELEASES_JSON:-}"
if [ -z "$json" ]; then
  json="$work/releases.json"
  gh api "repos/${GITHUB_REPOSITORY:-OpenSourcx/papercliped-engine}/releases?per_page=100" >"$json" || die "couldn't read the release list"
fi

if [ "${1:-}" = "--local" ]; then
  node "$ROOT/scripts/build-update-feed.mjs" --releases "$json" --out "${2:?usage: --local <dir>}"
  exit 0
fi

site="$(mktemp -d)"; rmdir "$site"
if git -C "$ROOT" fetch --quiet --depth 1 origin gh-pages 2>/dev/null; then
  git -C "$ROOT" worktree add --quiet --detach "$site" FETCH_HEAD
else
  git -C "$ROOT" worktree add --quiet --detach "$site"
  (cd "$site" && git checkout --quiet --orphan gh-pages && git rm -rqf --ignore-unmatch . && git clean -fdxq)
fi
touch "$site/.nojekyll"
node "$ROOT/scripts/build-update-feed.mjs" --releases "$json" --out "$site/updates"
cd "$site"
git add -A
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit --quiet -m "Update feed" || { echo "publish-update-feed: nothing changed"; exit 0; }
git push --quiet origin HEAD:refs/heads/gh-pages
echo "publish-update-feed: published gh-pages:/updates"
