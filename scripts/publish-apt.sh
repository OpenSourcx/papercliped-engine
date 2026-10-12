#!/usr/bin/env bash
# Publishes release/epaperclip_*_all.deb to ePaperclip's signed APT repository: the gh-pages branch, folder apt/, served
# by GitHub Pages at https://opensourcx.github.io/papercliped-engine/apt.
#
#   APT_SIGNING_KEY=<ASCII-armored private key> bash scripts/publish-apt.sh   CI, on a version tag: commit and push
#   APT_SIGNING_KEY=... bash scripts/publish-apt.sh --local <dir>              build the repository into <dir> only
#
# Without APT_SIGNING_KEY it skips, saying so. The key must be the one whose public half is committed at
# deploy/apt/epaperclip-archive-keyring.asc (users trust that one); anything else is refused. APT_SIGNING_PASSPHRASE is
# used if the key has one. Earlier versions stay in the pool, so the repository keeps them.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_KEY="${EPC_APT_PUBLIC_KEY:-$ROOT/deploy/apt/epaperclip-archive-keyring.asc}"
die() { echo "publish-apt: $*" >&2; exit 1; }

mode=push; out=""
if [ "${1:-}" = "--local" ]; then mode=local; out="${2:?usage: publish-apt.sh --local <dir>}"; fi
if [ -z "${APT_SIGNING_KEY:-}" ]; then
  echo "::notice::publish-apt: APT_SIGNING_KEY isn't set, so the APT repository was not published."
  exit 0
fi
deb="$(ls -t "$ROOT"/release/epaperclip_*_all.deb 2>/dev/null | head -n1)"
[ -n "$deb" ] || die "no release/epaperclip_*_all.deb; run scripts/build-deb.sh first"
for c in gpg dpkg-scanpackages gzip; do command -v "$c" >/dev/null || die "the '$c' command is missing (apt-get install -y gnupg dpkg-dev)"; done
[ -f "$PUBLIC_KEY" ] || die "$PUBLIC_KEY is missing"

GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
site=""
cleanup() {
  rm -rf "$GNUPGHOME"
  if [ -n "$site" ]; then git -C "$ROOT" worktree remove --force "$site" >/dev/null 2>&1 || rm -rf "$site"; fi
}
trap cleanup EXIT
printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import 2>/dev/null || die "APT_SIGNING_KEY isn't a key gpg can import"
fpr="$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1=="fpr"{print $10; exit}')"
want="$(gpg --batch --with-colons --show-keys "$PUBLIC_KEY" | awk -F: '$1=="fpr"{print $10; exit}')"
[ -n "$fpr" ] && [ "$fpr" = "$want" ] || die "the signing key (${fpr:-none}) isn't the one published in ${PUBLIC_KEY#"$ROOT/"} ($want); nothing was published"
sign=(gpg --batch --yes --pinentry-mode loopback --local-user "$fpr")
[ -z "${APT_SIGNING_PASSPHRASE:-}" ] || sign+=(--passphrase-fd 3)

if [ "$mode" = push ]; then
  site="$(mktemp -d)"; rmdir "$site"
  if git -C "$ROOT" fetch --quiet --depth 1 origin gh-pages 2>/dev/null; then
    git -C "$ROOT" worktree add --quiet --detach "$site" FETCH_HEAD
  else
    git -C "$ROOT" worktree add --quiet --detach "$site"
    (cd "$site" && git checkout --quiet --orphan gh-pages && git rm -rqf --ignore-unmatch . && git clean -fdxq)
  fi
  apt="$site/apt"; touch "$site/.nojekyll"
else
  apt="$out"
fi

debname="$(basename "$deb")"
pool="$apt/pool/main/e/epaperclip"
install -d "$pool"
cp -f "$deb" "$pool/$debname"
cp -f "$PUBLIC_KEY" "$apt/epaperclip-archive-keyring.asc"
gpg --batch --yes --dearmor -o "$apt/epaperclip-archive-keyring.gpg" "$PUBLIC_KEY"

dists="$apt/dists/stable"
rm -rf "$dists"
for arch in amd64 arm64 all; do
  d="$dists/main/binary-$arch"; install -d "$d"
  (cd "$apt" && dpkg-scanpackages --multiversion pool /dev/null 2>/dev/null) >"$d/Packages"
  gzip -9nkf "$d/Packages"
  printf 'Archive: stable\nSuite: stable\nComponent: main\nOrigin: ePaperclip\nLabel: ePaperclip\nArchitecture: %s\n' "$arch" >"$d/Release"
done
grep -q "^Filename: pool/main/e/epaperclip/$debname$" "$dists/main/binary-all/Packages" || die "the package didn't make it into the index"

{
  echo "Origin: ePaperclip"
  echo "Label: ePaperclip"
  echo "Suite: stable"
  echo "Codename: stable"
  echo "Date: $(LC_ALL=C date -Ru)"
  echo "Architectures: amd64 arm64 all"
  echo "Components: main"
  echo "Description: ePaperclip for Proxmox VE"
  for h in MD5Sum:md5sum SHA256:sha256sum SHA512:sha512sum; do
    echo "${h%%:*}:"
    (cd "$dists" && find main -type f | LC_ALL=C sort | while read -r f; do
      printf ' %s %8d %s\n' "$("${h#*:}" "$f" | cut -d' ' -f1)" "$(stat -c %s "$f")" "$f"
    done)
  done
} >"$dists/Release"
if [ -n "${APT_SIGNING_PASSPHRASE:-}" ]; then
  "${sign[@]}" --clearsign -o "$dists/InRelease" "$dists/Release" 3<<<"$APT_SIGNING_PASSPHRASE"
  "${sign[@]}" --armor --detach-sign -o "$dists/Release.gpg" "$dists/Release" 3<<<"$APT_SIGNING_PASSPHRASE"
else
  "${sign[@]}" --clearsign -o "$dists/InRelease" "$dists/Release"
  "${sign[@]}" --armor --detach-sign -o "$dists/Release.gpg" "$dists/Release"
fi
gpg --batch --verify "$dists/Release.gpg" "$dists/Release" 2>/dev/null || die "the Release signature doesn't verify"

if [ "$mode" = local ]; then echo "publish-apt: $debname -> $apt (signed by $fpr)"; exit 0; fi
cd "$site"
git add -A
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit --quiet -m "APT repository: $debname" || { echo "publish-apt: nothing changed"; exit 0; }
git push --quiet origin HEAD:refs/heads/gh-pages
echo "publish-apt: published $debname to gh-pages:/apt (signed by $fpr)"
